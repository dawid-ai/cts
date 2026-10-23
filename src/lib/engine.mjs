// The signal layer, Tier 1: deterministic detectors, threads, sessions and arcs.
// Pure and replayable: feed it the same ordered events and you get the same moments (that is what `cts reindex` relies on).
import { testSegment, testVerdict, parseCounts, failedTests, skeleton, deploySegment, tagName, DEP_REMOVE_RE, DEP_ADD_RE, RM_RE, HEDGE_RE, DECISIVE_RE, hedgeSentence, topicsOf, errorSigs, PROBLEM_RE, promptTopics, sameAsk, writtenFiles } from './parse.mjs';
import { trunc } from './util.mjs';
import { DraftStore } from './drafts.mjs';

export const BASE = { reversal: 60, fight: 40, disagreement: 70, shipped: 65, broke: 65, pivot: 55, 'memory-cut': 50, refusal: 50, wait: 20, escalation: 45, mark: 100, misread: 55, frustration: 45, recurring: 55, detour: 45, theory: 50, workaround: 50, learned: 50 };
export const TIER2_KINDS = ['theory', 'workaround', 'learned'];
export const KINDS = Object.keys(BASE);
const MIN = 60000;
const DAY = 86400000;
const HUMAN = new Set(['mark', 'confirm', 'dismiss', 'rescore', 'merge', 'thread.close']);
// A shell command's relative path joined to the event's cwd, with `.` and `..` resolved.
// Files that ride along with any change (tests, docs, config, dotfiles): never the start of a side quest.
const COMPANION = /(?:^|\/)(?:tests?|__tests__|spec|docs?|\.[^/]+)\/|\.(?:test|spec)\.\w+$|\.(?:md|mdx|txt|rst|json|lock|ya?ml|toml|ini|cfg|conf)$|(?:^|\/)\.[^/]*$/i;
const absPath = (cwd, f) => {
  if (/^(?:\/|~|[A-Za-z]:)/.test(f) || !cwd) return f;
  const out = [];
  for (const p of `${cwd}/${f}`.replace(/\\/g, '/').split('/')) p === '..' ? out.length > 1 && out.pop() : p !== '.' && (p || !out.length) && out.push(p);
  return out.join('/');
};
// Hotspots: moments that count against the files they touched (or the files written in the 30 minutes before them).
const STRUGGLE = new Set(['fight', 'broke', 'recurring', 'escalation', 'memory-cut', 'detour']);
const CORRECTION = new Set(['reversal', 'refusal', 'misread', 'frustration', 'disagreement']);

const REFUSAL_LEAD = /^\s*(?:no[,.!\s]+(?:don'?t|do not|stop|not)|don'?t|do not|stop\b|i don'?t want|not that|never mind)/i;
const REVERSAL_LEAD = /^\s*(?:wait\b|no\b|nope\b|actually\b|go back|that'?s wrong|that is wrong|revert|undo|scratch that|hold on|hang on)/i;
// You correcting how your request was read ("I meant ...") and losing patience, in your own words (quotes and code removed).
const MISREAD_LEAD = /^\s*(?:(?:no|nope|sorry|hm+|ok(?:ay)?|well)[,.!\s]+)?(?:i meant\b|what i meant\b|i was asking\b|my question (?:was|is)\b|i'?m asking (?:about|whether|if)\b|(?:that'?s |that is )?not what i (?:asked|meant|said|wanted)\b|you (?:misunderstood|misread|got me wrong)\b|i didn'?t (?:ask|mean|say)\b)/i;
const FRUSTRATION = /\b(?:damn(?:ed|it)?|wtf|ffs|fuck\w*|shit\w*|crap|ugh+|argh+|jeez|come on)\b|\b(?:still|again)\b[^.?!\n]{0,30}\b(?:broken|failing|fails|wrong|not work\w*|doesn'?t work|does not work|same (?:error|problem|issue))\b|\b(?:doesn'?t|does not|didn'?t|still not) work(?:ing)?\b|\bnot working\b|\bwhy (?:is|does|do) (?:it|this|that) (?:still|keep)\b|\bkeeps? (?:failing|breaking|happening)\b|\?!|!{3,}/i;
const ownWords = (t) => String(t || '').replace(/<(pasted_content|system-reminder)\b[\s\S]*?<\/\1>/g, ' ').replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ').replace(/^>.*$/gm, ' ').replace(/"[^"\n]*"|“[^”\n]*”/g, ' ').slice(0, 600);
const POS = /\b(done|complete[d]?|implemented|ready|all set|finished|looks good|lgtm|approved?|passes|passing|shipped)\b/i;
const NEG = /\b(missing|rejected?|not (?:done|implemented|complete|working|handled)|incorrect|wrong|broken|blocker|fails?|failing|does(?:n'?t| not) (?:work|handle|cover|meet)|needs? (?:work|fix|changes)|do(?:es)? not pass)\b/i;
const rank = (m) => (/opus|fable|mythos/i.test(m || '') ? 3 : /sonnet/i.test(m || '') ? 2 : /haiku/i.test(m || '') ? 1 : 0);
/** First sentence or line of a message, or '' for structured output (JSON, XML, tables). */
const DEFERRAL_RE = /\b(for now|temporar(?:y|ily) (?:fix|workaround|solution)|TODO|revisit|come back to|for the time being)\b/i;
const verdictOf = (text) => {
  const s = String(text || '').trim();
  if (/^[[{<|]/.test(s)) return '';
  return (s.split(/\n|(?<=[.!?])\s/)[0] || '').slice(0, 240);
};
const globMatch = (pat, s) => new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(s || '');

export class Engine {
  constructor(cfg = {}) {
    this.cfg = { threshold: 50, arcOpenDays: 5, ...cfg, detectors: { fightMin: 3, waitMinutes: 30, mainBranches: ['main', 'master', 'trunk', 'release*'], weights: {}, ...(cfg.detectors || {}) } };
    this.moments = new Map();
    this.drafts = new DraftStore(cfg.drafts || {});
    this.threads = new Map();
    this.warm = new Map();       // near-misses: failure streaks still running or fixed below fightMin; never scored or drafted
    this.sessions = new Map();
    this.dismissals = {};
    this.eventCount = 0;
    this.lastTs = 0;
    this._arcs = null;
    this._ch = null;
    this.prevSession = null;
    this.snap = null;            // retention snapshot: state at snap.at for sessions whose raw events were trimmed
    this._restored = new Set();  // restored moment ids not yet re-emitted by a kept session's replay
  }

  // ---------- accessors ----------
  weight(kind) {
    const w = this.cfg.detectors.weights[kind] ?? 1;
    return w * Math.max(0.5, 1 - 0.1 * (this.dismissals[kind] || 0));
  }
  score(m) {
    if (m.status === 'dismissed' || m.status === 'merged' || m.status === 'dropped') return 0;
    if (m.rescore != null) return m.rescore;
    if (m.kind === 'mark') return 100;
    const s = m.xscore != null ? m.xscore : Math.round(m.base * this.weight(m.kind));
    return m.status === 'confirmed' ? Math.max(80, s) : s;
  }
  view(m) { return { ...m, score: this.score(m) }; }
  listMoments({ min = 0, kinds = null } = {}) {
    return [...this.moments.values()].map((m) => this.view(m)).filter((m) => m.score >= min && (!kinds || kinds.includes(m.kind))).sort((a, b) => a.t0 - b.t0);
  }
  /** Near-misses; `live` while the streak is still the session's current one, the session is open and the 90-minute window has not passed. */
  listWarm() {
    const live = (w, S = this.sessions.get(w.sid)) => !w.done && !!S && !S.ended && this.lastTs - w.t1 < 90 * MIN && (S.fails.get(w.key) || [])[0]?.id === w.span.first;
    const waits = [...this.sessions.values()].map((S) => this.waitWarm(S)).filter(Boolean);
    return [...[...this.warm.values()].map((w) => ({ ...w, live: live(w) })), ...waits].sort((a, b) => a.t1 - b.t1);
  }
  /** Claude blocked on you right now (a question, a permission or an MCP prompt is the session's newest event); past waitMinutes it becomes a `wait` moment. */
  waitWarm(S) {
    const w = S.waitMark;
    if (!w || S.ended || w.t !== S.end) return null;
    const ev = w.ev, th = this.threads.get(ev.id);
    const what = ev.kind === 'permission.request' ? `permission for ${ev.d.tool || 'a tool'}` : ev.kind === 'elicitation' ? 'an MCP prompt' : th ? trunc(th.text, 80) : 'your answer';
    return { id: `${ev.id}.warm`, of: 'wait', sid: S.sid, headline: `Waiting on ${what}`, done: false, live: true, since: w.t, need: this.cfg.detectors.waitMinutes, t0: w.t, t1: w.t, actors: [ev.actor], span: { first: ev.id, ids: [ev.id] }, demo: S.demo };
  }
  openThreads() { return [...this.threads.values()].filter((t) => !t.closed).sort((a, b) => b.opened_t - a.opened_t); }
  /** Moments over the threshold per subagent, keyed by agent id, for the subagent status line (read from context.json). */
  agentCounts() {
    const out = {};
    for (const m of this.listMoments({ min: this.cfg.threshold })) {
      for (const a of m.actors || []) {
        if (!a.startsWith('agent:')) continue;
        const S = this.sessions.get(m.sid), info = S && S.actors.get(a);
        const o = (out[a.slice(6)] ||= { n: 0, sid: m.sid, type: (info && info.agent_type) || null, last: null });
        o.n++; o.last = trunc(m.headline, 60);
      }
    }
    return out;
  }
  context() {
    const last = this.listMoments({ min: this.cfg.threshold }).slice(-1)[0] || null;
    return {
      agents: this.agentCounts(),
      updated: new Date().toISOString(),
      threads: this.openThreads().map((t) => ({ id: t.id, text: t.text, opened_ts: t.opened_ts, opened_by: t.opened_by })),
      last: last && { id: last.id, headline: last.headline, kind: last.kind, score: last.score },
      pending_drafts: this.drafts.pendingCount(),
      pending_extract: [...this.moments.values()].filter((m) => m.tier === 1 && !m.extracted && !m.demo && (m.status === 'auto' || m.status === 'confirmed') && m.kind !== 'mark' && this.score(m) >= this.cfg.threshold).length,
    };
  }

  // ---------- core ----------
  S(sid) {
    let S = this.sessions.get(sid);
    if (!S) {
      S = {
        sid, start: null, end: null, source: null, parent: null, model: null, demo: false, events: 0,
        branch: null, branchSince: null, fails: new Map(), lastGreen: new Map(), reads: new Set(), cut: null, writes: new Map(), touched: new Map(),
        pendingRemove: null, ring: [], msgs: [], pre: new Map(), actors: new Map(), status: {}, waitMark: null,
        stats: { moments: 0, attempts: 0, redGreen: 0, tools: 0, fails: 0 }, lastMoment: null, ended: null,
      };
      S.actors.set('human', { id: 'human', label: 'You', type: 'human' });
      S.actors.set('main', { id: 'main', label: 'main', type: 'main' });
      this.sessions.set(sid, S);
    }
    return S;
  }

  push(ev) {
    const ch = { moments: new Set(), threads: new Set(), sessions: new Set(), drafts: new Set(), warm: new Set() };
    this._ch = ch;
    this._arcs = null;
    const t = Date.parse(ev.ts);
    ev._t = t;
    if (this.drafts.isDraftKind(ev.kind)) { this.eventCount++; this.drafts.apply(ev, t); const id = ev.d && ev.d.draft; if (id) ch.drafts.add(id); this._ch = null; return ch; }
    // Before the snapshot's time, its state already includes every decision and extraction: replay only what it lacks.
    const frozen = this.snap && t <= this.snap.at;
    if (frozen && (ev.kind === 'post.receipt' || ev.kind.startsWith('extract.') || this.snap.sids.has(ev.sid))) { this.eventCount++; this._ch = null; return ch; }
    if (ev.kind === 'post.receipt') { this.eventCount++; this.onPostReceipt(ev, t); this._ch = null; return ch; }
    if (ev.kind.startsWith('extract.')) { this.eventCount++; this.onExtract(ev, t); this._ch = null; return ch; }
    const S = this.S(ev.sid);
    this.eventCount++;
    this.lastTs = Math.max(this.lastTs, t);
    if (S.start == null) S.start = t;
    S.end = Math.max(S.end ?? 0, t);
    S.events++;
    ch.sessions.add(ev.sid);
    if (ev.d && ev.d.demo) S.demo = true;
    this.registerActor(S, ev);
    S.ring.push(ev.id); if (S.ring.length > 12) S.ring.shift();

    this.waitCheck(S, ev, t);
    const d = ev.d || {};
    if (frozen && HUMAN.has(ev.kind)) { this._ch = null; return ch; }
    switch (ev.kind) {
      case 'session.start': this.onSessionStart(S, ev, t); break;
      case 'session.end': S.ended = t; for (const a of Object.keys(S.status)) this.setStatus(S, a, 'done', ev.d.reason || 'session ended'); break;
      case 'prompt': this.onPrompt(S, ev, t); break;
      case 'tool.pre': this.onPre(S, ev, t); break;
      case 'tool.post': case 'tool.fail': this.onPost(S, ev, t); break;
      case 'subagent.start': this.setStatus(S, ev.actor, 'thinking', 'starting'); break;
      case 'subagent.stop': this.onMessage(S, ev, t, true); this.setStatus(S, ev.actor, 'done', 'finished'); break;
      case 'turn.end': this.onMessage(S, ev, t, false); this.setStatus(S, 'main', 'waiting', 'waiting on you'); if (DEFERRAL_RE.test(d.last || '')) this.hedgeFrom(S, ev, t, d.last); break;
      case 'turn.fail': this.setStatus(S, 'main', 'failed', 'turn failed'); break;
      case 'compact.pre': break;
      case 'compact.post': S.cut = { t, ev, rereads: [], emitted: false, before: new Set(S.reads) }; break;
      case 'model.post': this.onModel(S, ev, t); break;
      case 'permission.request': S.waitMark = { t, ev }; this.setStatus(S, 'main', 'waiting', 'waiting for permission'); break;
      case 'permission.denied': this.onDenied(S, ev, t); break;
      case 'elicitation': this.openThread(S, ev, t, 'elicitation', trunc(JSON.stringify(d.extra || {}), 200), [], d.extra && d.extra.elicitation_id); S.waitMark = { t, ev }; break;
      case 'elicitation.result': this.closeElicitation(S, ev, t); break;
      case 'mark': this.onMark(S, ev, t); break;
      case 'confirm': { const m = this.moments.get(d.target); if (m) { m.status = 'confirmed'; ch.moments.add(m.id); } break; }
      case 'dismiss': this.onDismiss(S, ev, t); break;
      case 'rescore': { const m = this.moments.get(d.target); if (m) { m.rescore = Math.max(0, Math.min(100, +d.score)); ch.moments.add(m.id); } break; }
      case 'merge': this.onMerge(d); break;
      case 'thread.close': this.onThreadClose(S, ev, t); break;
      default: break;
    }
    if (ev.kind === 'session.end') for (const w of this.warm.values()) if (w.sid === S.sid && !w.done) ch.warm.add(w.id);
    const wk = this.waitWarm(S)?.id || null;
    if (wk !== (S.wk || null)) { if (S.wk) ch.warm.add(S.wk); if (wk) ch.warm.add(wk); S.wk = wk; }
    this._ch = null;
    return ch;
  }

  registerActor(S, ev) {
    const id = ev.actor;
    if (id === 'caller') { if (!S.actors.has(id)) S.actors.set(id, { id, label: 'claude -p', type: 'caller' }); return; }
    if (!S.actors.has(id)) S.actors.set(id, { id, label: ev.d.name || ev.agent_type || id.replace('agent:', '').slice(0, 8), type: 'agent', agent_type: ev.agent_type || null });
    else if (id.startsWith('agent:')) {
      const a = S.actors.get(id);
      if (ev.d.name) a.label = ev.d.name;
      else if (ev.agent_type && (a.label === id.replace('agent:', '').slice(0, 8))) a.label = ev.agent_type;
    }
    if (!S.status[id] && id !== 'human') S.status[id] = { glyph: 'thinking', text: 'started', t: ev._t };
  }
  label(S, id) { return (S.actors.get(id) || { label: id }).label; }
  setStatus(S, id, glyph, text) { if (id === 'human' || id === 'caller') return; if (!S.actors.has(id)) return; S.status[id] = { glyph, text: trunc(text, 60), t: S.end }; }

  // ---------- moment creation ----------
  emit(S, kind, evs, o = {}) {
    const first = evs[0], last = evs[evs.length - 1];
    const id = `${first.id}.${kind}`;
    if (this.moments.has(id)) {
      const m = this.moments.get(id);
      if (this._restored.delete(id)) { S.lastMoment = m; this._ch.moments.add(id); }
      return m;
    }
    const ids = [...new Set(evs.map((e) => e.id))];
    const m = {
      id, kind, sid: S.sid, base: o.base ?? BASE[kind], status: 'auto', note: o.note || null,
      headline: o.headline, body: o.body || [], actors: [...new Set(o.actors || evs.map((e) => e.actor))],
      files: o.files || [], branch: o.branch ?? S.branch, thread: null,
      span: { first: first.id, last: last.id, count: ids.length, ids: ids.slice(0, 40) },
      t0: first._t, t1: last._t, evidence: o.evidence || {}, tp: evs.filter((e) => e.tp).slice(0, 8).map((e) => ({ id: e.id, ...e.tp })),
      detector: kind, tier: 1, demo: S.demo,
    };
    if (o.who) m.who = o.who;
    if (!m.files.length && (STRUGGLE.has(kind) || CORRECTION.has(kind))) { const near = this.nearFiles(S, last._t); if (near.length) m.near = near; }
    this.moments.set(id, m);
    S.lastMoment = m;
    this._ch.moments.add(id);
    return m;
  }

  // ---------- handlers ----------
  onSessionStart(S, ev, t) {
    const d = ev.d;
    S.source = d.source; if (d.model) S.model = d.model;
    if (d.headless) S.headless = d.headless;
    if (d.title) S.title = d.title;
    if (['resume', 'fork', 'clear'].includes(d.source) && !S.parent) {
      let best = null;
      for (const o of this.sessions.values()) if (o.sid !== S.sid && o.end != null && o.end <= t && !o.demo === !S.demo && (!best || o.end > best.end)) best = o;
      if (best) S.parent = best.sid;
    }
    this.setStatus(S, 'main', 'waiting', 'waiting on you');
  }

  onPrompt(S, ev, t) {
    const text = ev.d.text || '';
    S.waitMark = null;
    // A program's prompt (`claude -p`): no refusals, reversals or threads on your behalf.
    if (ev.actor === 'caller') { S.headless ||= ev.d.headless || 'sdk'; this.setStatus(S, 'main', 'thinking', 'reading the prompt'); return; }
    this.setStatus(S, 'main', 'thinking', 'reading your prompt');
    const own = ownWords(text), mad = FRUSTRATION.test(own);
    // A correction right after a confident "done" weighs more: the answer sounded finished and was not what you asked.
    const prev = [...S.msgs].reverse().find((o) => o.actor === 'main'), sure = !!prev && prev.pos && !prev.neg && t - prev.t <= 30 * MIN;
    if (MISREAD_LEAD.test(own)) {
      this.emit(S, 'misread', [ev], { base: BASE.misread + (sure ? 10 : 0) + (mad ? 5 : 0), actors: ['human'], headline: `You clarified what you meant: “${trunc(text, 90)}”`, evidence: { prompt: trunc(text, 600), after_confident: sure, frustrated: mad }, who: ev.d.who });
    } else if (REFUSAL_LEAD.test(text)) {
      this.emit(S, 'refusal', [ev], { actors: ['human'], headline: `You said no: “${trunc(text, 90)}”`, evidence: { prompt: trunc(text, 600) }, who: ev.d.who });
    } else if (REVERSAL_LEAD.test(text)) {
      this.emit(S, 'reversal', [ev], { actors: ['human'], headline: `You pulled back: “${trunc(text, 90)}”`, evidence: { prompt: trunc(text, 600) }, who: ev.d.who });
    } else if (mad) {
      this.emit(S, 'frustration', [ev], { base: BASE.frustration + (sure ? 10 : 0), actors: ['human'], headline: `You were losing patience: “${trunc(text, 90)}”`, evidence: { prompt: trunc(text, 600), after_confident: sure }, who: ev.d.who });
    }
    // The session's first request, or an error pasted into any prompt, seen in an earlier session.
    const ask = !S.asked && PROBLEM_RE.test(text) ? { text, topics: promptTopics(text) } : null;
    S.asked = true;
    S.turn = { ev, topics: new Set([...promptTopics(text), ...topicsOf(text)]), areas: new Set(), red: null, off: new Map(), done: false };
    this.recurCheck(S, ev, t, { errors: errorSigs(text), ask });
    this.hedgeFrom(S, ev, t, text);
    if (DECISIVE_RE.test(text)) this.closeByTopics(S, ev, t, topicsOf(text), 'decision');
  }

  onPre(S, ev, t) {
    const d = ev.d;
    S.pre.set(d.tool_use_id, ev);
    if (S.pre.size > 400) S.pre.delete(S.pre.keys().next().value);
    this.setStatus(S, ev.actor, 'running', `${d.tool} ${trunc(d.input.file_path || d.input.command || d.input.pattern || d.input.description || '', 40)}`);
    if (d.tool === 'AskUserQuestion') {
      const q = (d.input.questions || []).join(' / ') || 'question for you';
      this.openThread(S, ev, t, 'question', q, topicsOf(q), d.tool_use_id);
      S.waitMark = { t, ev };
      this.setStatus(S, ev.actor, 'waiting', 'waiting on you');
    }
  }

  /** The test run in a Bash event. Events captured before `seg` existed, or with no verdict, are re-classified from the stored command and output. */
  testOf(ev) {
    const d = ev.d;
    if (d.tool !== 'Bash' || !d.test) return null;
    if (d.test.seg && d.test.red != null) return d.test;
    const ts = d.test.seg ? d.test : testSegment(d.input && d.input.command);
    const c = d.test.total ? d.test : parseCounts(d.out);
    return ts && { ...d.test, ...ts, ...(c || {}), red: testVerdict(ts, c, d.out, ev.kind !== 'tool.fail') };
  }

  failKey(ev, tst) {
    const d = ev.d, i = d.input || {};
    if (d.tool === 'Bash') {
      // Keyed on what runs: a shared `cd "<project>" &&` prefix would otherwise make every command one target.
      const cmd = (i.command || '').replace(/\s+/g, ' ').trim().replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, '');
      return tst ? `test:${tst.runner}:${tst.seg.slice(0, 120)}` : `bash:${cmd.slice(0, 80)}`;
    }
    return `${d.tool}:${i.file_path || i.path || i.notebook_path || i.pattern || i.url || ''}`;
  }

  onPost(S, ev, t) {
    const d = ev.d, i = d.input || {};
    const fail = ev.kind === 'tool.fail';
    const pre = S.pre.get(d.tool_use_id);
    const dur = d.dur_ms ?? (pre ? t - pre._t : null);
    S.stats.tools++;
    this.setStatus(S, ev.actor, fail ? 'failed' : 'thinking', fail ? `${d.tool} failed` : 'thinking');
    if (d.tool === 'AskUserQuestion') {
      if (!fail) for (const th of this.threads.values()) if (!th.closed && th.key === d.tool_use_id) this.closeThread(th, ev, t, 'answered');
      S.waitMark = null;
    }
    if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(d.tool) && !fail) { const f = i.file_path || i.notebook_path; if (f) { S.writes.set(f, t); this.touch(S, f, t, ev); } }
    if (d.tool === 'Read' && !fail) this.onRead(S, ev, t, i.file_path);
    if (d.tool === 'EnterWorktree' && !fail) this.emit(S, 'pivot', [ev], { headline: 'Started a worktree to try another path', actors: [ev.actor] });

    const tst = this.testOf(ev);
    const red = tst && tst.red != null ? tst.red : fail;
    const key = this.failKey(ev, tst);
    if (red) {
      S.stats.fails++;
      const arr = S.fails.get(key) || [];
      const fresh = arr.filter((e) => t - e._t < 90 * MIN);
      if (arr.length && fresh[0] !== arr[0]) this.unwarm(arr[0], key);
      fresh.push(ev);
      S.fails.set(key, fresh);
      if (tst || fresh.length > 1) this.warmUp(S, fresh, key, `${fresh.length} failed attempt${fresh.length === 1 ? '' : 's'} at ${trunc(this.label4(key), 60)} so far`);
    } else {
      const arr = S.fails.get(key);
      if (arr && arr.length) {
        S.stats.attempts += arr.length;
        if (tst) S.stats.redGreen++;
        if (arr.length >= this.cfg.detectors.fightMin) { this.fightMoment(S, ev, arr, key, t, dur); this.unwarm(arr[0], key, true); }
        else this.warmUp(S, [...arr, ev], key, `${arr.length} failed attempt${arr.length === 1 ? '' : 's'} at ${trunc(this.label4(key), 60)}, then it passed`, true);
        S.fails.delete(key);
      }
    }
    // A real failure (a red test run, or a command that printed an error, not `grep` finding nothing) can start a side quest.
    if (red && d.tool === 'Bash' && S.turn && !S.turn.red && S.turn.areas.size && (tst || errorSigs(d.out).length || /\b(?:error|failed|exception|traceback|panicked)\b/i.test(d.out || ''))) S.turn.red = ev;
    // A failed call on a file counts against it; a red test run counts against the files written just before it.
    if (red) for (const f of d.tool === 'Bash' ? (tst ? this.nearFiles(S, t) : []) : [i.file_path || i.notebook_path].filter(Boolean)) this.fileStat(S, f, 1, t);
    if (tst && tst.red != null) this.onTest(S, ev, tst, key, red, t);
    else if (red && d.tool === 'Bash') this.recurCheck(S, ev, t, { errors: errorSigs(d.out) });
    if (d.git && !fail) this.onGit(S, ev, t);
    if (d.tool === 'Bash' && !fail) { this.onBash(S, ev, t); for (const f of writtenFiles(i.command)) this.touch(S, absPath(ev.cwd, f), t, ev); }
  }

  /** A file this session wrote, by an edit tool or a shell command: counted for hotspots and remembered for `nearFiles`. */
  touch(S, f, t, ev) { S.touched.delete(f); S.touched.set(f, t); if (S.touched.size > 500) S.touched.delete(S.touched.keys().next().value); this.fileStat(S, f, 0, t); this.detourCheck(S, ev, f); }
  /**
   * A side quest: after a real failure, a turn starts editing an area (first two directory levels) it had not touched,
   * that the prompt does not name. Two edits there make the moment, once per turn. Companion files never count.
   */
  detourCheck(S, ev, f) {
    const T = S.turn, cwd = String(ev.cwd || '').replace(/\\/g, '/').replace(/\/$/, ''), x = String(f).replace(/\\/g, '/');
    if (!T || T.done || !cwd || !x.startsWith(cwd + '/')) return;
    const rel = x.slice(cwd.length + 1), parts = rel.split('/');
    if (COMPANION.test(rel)) return;
    const area = parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join('/') : '';
    if (!T.red) { T.areas.add(area); return; }
    const words = [...area.split(/[/_.-]/), ...parts[parts.length - 1].replace(/\.\w+$/, '').split(/[_.-]/)].map((w) => w.toLowerCase()).filter((w) => w.length >= 3);
    if (T.areas.has(area) || words.some((w) => T.topics.has(w)) || T.topics.has(parts[parts.length - 1].toLowerCase())) return;
    const o = T.off.get(area) || { evs: [], files: new Set(), abs: new Set() };
    o.evs.push(ev); o.files.add(rel); o.abs.add(x); T.off.set(area, o);
    if (o.evs.length < 2) return;
    T.done = true;
    const from = [...T.areas].map((a) => a || 'the top level'), to = area || 'the top level', r = T.red;
    this.emit(S, 'detour', [r, ...o.evs], {
      headline: `Side quest: a failure while working in ${trunc(from.join(', '), 50)} led to edits in ${to}`,
      body: [`${o.files.size === 1 ? 'One file' : `${o.files.size} files`} outside the request's area changed after the failure: ${trunc([...o.files].join(', '), 160)}.`],
      files: [...o.abs], actors: [...new Set([r, ...o.evs].map((e) => e.actor))],
      evidence: { from, to, files: [...o.files], prompt: trunc(T.ev.d.text, 300), command: trunc((r.d.input || {}).command || '', 200), error: trunc(r.d.out || '', 500) },
    });
  }
  /** Files written in this session in the 30 minutes before `t`, newest first (at most 8). */
  nearFiles(S, t) { return [...S.touched].filter(([, w]) => w <= t && t - w <= 30 * MIN).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f]) => f); }
  /**
   * Per file: `s` is {sid: [edits, failures, last time]}, kept per session so a retention snapshot carries trimmed sessions
   * without double counting the ones that replay; `c` is {commit sha: time}, so a commit seen twice counts once.
   */
  fileStat(S, f, k, t, sha) {
    if (S.demo) return;
    const all = (this.files ||= new Map()), r = all.get(f) || { s: {}, c: {} };
    if (sha) r.c[sha] = t;
    else { const c = (r.s[S.sid] ||= [0, 0, 0]); c[k]++; c[2] = Math.max(c[2], t); }
    all.delete(f); all.set(f, r);
    if (all.size > 5000) all.delete(all.keys().next().value);
  }
  /** Files and areas ranked by trouble across all sessions: struggle and correction moments, red runs after editing, then edits. Paths under `root` are made relative. */
  hotspots(root = '', { limit = 40 } = {}) {
    const rel = (f) => { const x = String(f).replace(/\\/g, '/'), r = String(root).replace(/\\/g, '/').replace(/\/$/, ''); return r && x.startsWith(r + '/') ? x.slice(r.length + 1) : x; };
    const rows = new Map(), row = (f) => { const k = rel(f); let r = rows.get(k); if (!r) rows.set(k, r = { file: k, edits: 0, commits: 0, fails: 0, struggles: 0, corrections: 0, sessions: new Set(), last: 0, moments: [], kinds: new Map() }); return r; };
    for (const [f, { s, c }] of this.files || []) {
      const r = row(f);
      for (const [sid, [e, x, t]] of Object.entries(s)) { r.edits += e; r.fails += x; r.sessions.add(sid); r.last = Math.max(r.last, t); }
      for (const t of Object.values(c)) { r.commits++; r.last = Math.max(r.last, t); }
    }
    for (const m of this.moments.values()) {
      const k = m.demo || m.status === 'dismissed' ? null : STRUGGLE.has(m.kind) ? 'struggles' : CORRECTION.has(m.kind) ? 'corrections' : null;
      if (k) for (const f of new Set((m.files.length ? m.files : m.near || []).map(rel))) { const r = row(f); r[k]++; r.sessions.add(m.sid); r.last = Math.max(r.last, m.t1); r.moments.push(m.id); r.kinds.set(m.id, k); }
    }
    const heat = (r) => 3 * (r.struggles + r.corrections) + r.fails + Math.round((r.edits + r.commits) / 5);
    const out = ({ kinds, ...r }) => ({ ...r, sessions: r.sessions.size, heat: heat(r), moments: r.moments.slice(-5) });
    const areas = new Map();
    for (const r of rows.values()) {
      const parts = r.file.split('/'), name = r.file.startsWith('/') || /^[A-Za-z]:/.test(r.file) || r.file.startsWith('~') ? '(outside the project)' : parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join('/') : '(top level)';
      const a = areas.get(name) || { area: name, files: 0, edits: 0, commits: 0, fails: 0, sessions: new Set(), last: 0, kinds: new Map() };
      a.files++; a.edits += r.edits; a.commits += r.commits; a.fails += r.fails;
      for (const s of r.sessions) a.sessions.add(s);
      for (const [id, k] of r.kinds) a.kinds.set(id, k);
      a.last = Math.max(a.last, r.last); areas.set(name, a);
    }
    // A moment near two files of one area counts once for the area.
    for (const a of areas.values()) { const ks = [...a.kinds.values()]; Object.assign(a, { struggles: ks.filter((k) => k === 'struggles').length, corrections: ks.filter((k) => k === 'corrections').length, moments: [...a.kinds.keys()] }); }
    const rank = (a, b) => b.heat - a.heat || b.last - a.last;
    return {
      files: [...rows.values()].map(out).sort(rank).slice(0, limit),
      areas: [...areas.values()].map(out).sort(rank).slice(0, 20),
      total: rows.size,
    };
  }

  label4(key) { return key.replace(/^(test|bash):/, '').replace(/^[^:]+:(?=[^ ])/, '') || key; }
  /** A near-miss, keyed by the streak's first failure. Replaying the same events rebuilds the same entries. */
  warmUp(S, evs, key, headline, done = false) {
    const first = evs[0], last = evs[evs.length - 1], id = `${first.id}.warm`;
    this.warm.delete(id);
    this.warm.set(id, { id, of: 'fight', sid: S.sid, key, headline, done, attempts: evs.length - (done ? 1 : 0), need: this.cfg.detectors.fightMin, t0: first._t, t1: last._t, actors: [...new Set(evs.map((e) => e.actor))], span: { first: first.id, ids: evs.map((e) => e.id).slice(0, 40) }, demo: S.demo });
    if (this.warm.size > 300) this.warm.delete(this.warm.keys().next().value);
    this._ch.warm.add(id);
  }
  /** The streak became a moment, or aged out of the 90-minute window without a fix. */
  unwarm(first, key, promoted = false) {
    const id = `${first.id}.warm`, w = this.warm.get(id);
    if (!w || w.key !== key) return;
    this._ch.warm.add(id);
    if (promoted) this.warm.delete(id);
    else if (!w.done) { w.done = true; w.headline = w.headline.replace(/ so far$/, ', then moved on'); }
  }
  fightMoment(S, ev, arr, key, t) {
    const n = arr.length;
    const label = this.label4(key);
    const last = arr[arr.length - 1];
    const mins = Math.max(1, Math.round((t - arr[0]._t) / MIN));
    const file = (ev.d.input && (ev.d.input.file_path || ev.d.input.path)) || null;
    this.emit(S, 'fight', [...arr, ev], {
      base: Math.min(90, 40 + 5 * n), actors: [...new Set([...arr, ev].map((e) => e.actor))],
      headline: `${n} failed attempts at ${trunc(label, 60)}, then it passed`,
      body: [`${n} failures over ${mins} min on the same target.`, `Last error: ${trunc((last.d.out || '').split('\n').filter(Boolean).slice(-1)[0] || 'n/a', 140)}`],
      files: file ? [file] : [],
      evidence: { attempts: n, elapsed_ms: t - arr[0]._t, error: trunc(last.d.out || '', 500), command: ev.d.input && ev.d.input.command ? trunc(ev.d.input.command, 200) : undefined },
    });
  }

  onTest(S, ev, tst, key, red, t) {
    if (!red) { S.lastGreen.set(key, { ev, total: tst.total || 0 }); return; }
    this.recurCheck(S, ev, t, { tests: failedTests(ev.d.out) });
    const g = S.lastGreen.get(key);
    if (!g) return;
    S.lastGreen.delete(key);
    // More tests than the green run and no more failures than were added: new tests failing first, not a regression.
    if (g.total && tst.total && tst.total - g.total >= tst.fail) return;
    this.emit(S, 'broke', [g.ev, ev], {
      headline: `Tests went red: ${trunc(tst.seg, 60)}`,
      body: [tst.total ? `${tst.fail} of ${tst.total} failing after a green run ${Math.round((t - g.ev._t) / MIN)} min earlier.` : 'Green to red.'],
      evidence: { error: trunc(ev.d.out, 500), counts: { runner: tst.runner, pass: tst.pass, fail: tst.fail, total: tst.total }, since_green_ms: t - g.ev._t },
    });
  }

  /** A problem that keeps coming back: the same failing test, error or opening request as in an earlier session. One moment per session per signature. */
  recurCheck(S, ev, t, { tests = [], errors = [], ask = null }) {
    if (!tests.length && !errors.length && !ask) return;
    const hist = (this.failHist ||= new Map()), hits = [], pre = S.demo ? 'demo:' : '';
    let n = 0, first = t, via = null;
    const see = (sig, label, kind, also = []) => {
      const seen = hist.get(sig) || {}, before = new Map();
      for (const o of [seen, ...also]) for (const [sid, t0] of Object.entries(o)) if (sid !== S.sid && t0 < t) before.set(sid, Math.min(t0, before.get(sid) ?? t0));
      if (before.size && !(S.recur ||= new Set()).has(sig)) { S.recur.add(sig); hits.push(label); via ||= kind; n = Math.max(n, before.size); first = Math.min(first, ...before.values()); }
      if (!(S.sid in seen)) { seen[S.sid] = t; hist.delete(sig); hist.set(sig, seen); }
      if (hist.size > 2000) hist.delete(hist.keys().next().value);
    };
    for (const name of tests) see(pre + name, name, 'test');
    for (const e of errors) see(`${pre}err:${e}`, e, 'error');
    if (ask) {
      // Prompts rarely repeat word for word: match earlier first prompts by topic overlap (sameAsk), keyed by their topic list.
      const p = `${pre}ask:`, also = [];
      for (const [k, v] of hist) if (k.startsWith(p) && sameAsk(ask.topics, k.slice(p.length).split(' '))) also.push(v);
      see(p + ask.topics.join(' '), trunc(ask.text.trim().split('\n')[0], 90), 'prompt', also);
    }
    if (!hits.length) return;
    const where = `also in ${n} earlier session${n === 1 ? '' : 's'}`;
    const headline = via === 'prompt' ? `Back with the same problem: “${hits[0]}”, ${where}` : `${via === 'error' ? 'Same error again' : 'Failing again'}: ${trunc(hits[0], 70)}${hits.length > 1 ? ` (+${hits.length - 1} more)` : ''}, ${where}`;
    const what = via === 'prompt' ? 'You opened a session with this problem' : via === 'error' ? `${hits.length === 1 ? 'This error' : 'These errors'} showed up` : `${hits.length === 1 ? 'This test' : 'These tests'} failed`;
    this.emit(S, 'recurring', [ev], {
      base: Math.min(85, BASE.recurring + 10 * (n - 1)), headline, actors: via === 'prompt' ? ['human'] : undefined, who: via === 'prompt' ? ev.d.who : undefined,
      body: [`${what} in ${n} earlier session${n === 1 ? '' : 's'}, first ${Math.max(1, Math.round((t - first) / DAY))} day(s) ago.`],
      evidence: { via, sessions: n, since_first_ms: t - first, ...(via === 'test' ? { tests: hits } : via === 'error' ? { errors: hits } : { prompt: trunc(ev.d.text, 600) }), ...(via === 'prompt' ? {} : { error: trunc(ev.d.out || ev.d.text || '', 500) }) },
    });
  }

  isMain(branch) { return !!branch && this.cfg.detectors.mainBranches.some((p) => globMatch(p, branch)); }

  onGit(S, ev, t) {
    const g = ev.d.git;
    if (g.branch) {
      if (!S.branch) { S.branch = g.branch; S.branchSince = t; }
    }
    const files = g.files || [];
    if (g.op === 'commit') for (const f of files) this.fileStat(S, f, 0, t, g.sha || `${t}:${g.subject}`);
    if (g.op === 'commit' && this.isMain(g.branch)) {
      this.emit(S, 'shipped', [ev], { headline: `Shipped: ${trunc(g.subject || 'commit', 90)}`, files, branch: g.branch, body: [g.stat ? `${g.stat.files} files, +${g.stat.ins}/-${g.stat.del}` : ''], evidence: { sha: g.sha, subject: g.subject, stat: g.stat } });
    } else if (g.op === 'merge' && this.isMain(g.branch)) {
      this.emit(S, 'shipped', [ev], { headline: `Merged into ${g.branch}: ${trunc(g.args, 70)}`, branch: g.branch, evidence: { args: g.args } });
    } else if (g.op === 'tag' && (g.tag || tagName(g.args))) {
      // The same tag often arrives twice: from `cts import git` and from the session that ran `git tag`.
      const tag = g.tag || tagName(g.args);
      this.tags ||= new Map();
      const seen = this.tags.get(tag);
      if (seen == null || Math.abs(t - seen) > DAY) { this.tags.set(tag, t); this.emit(S, 'shipped', [ev], { headline: `Tagged ${tag}`, evidence: { tag } }); }
    } else if (g.op === 'pr-merge') {
      this.emit(S, 'shipped', [ev], { headline: 'Pull request merged', evidence: { command: ev.d.input.command } });
    } else if (g.op === 'revert' || (g.op === 'reset' && /--hard|--keep\b/.test(g.args))) {
      // Only a reset that discards work reverses it; `reset --soft HEAD~1` or a mixed reset keeps every change (re-splitting a commit).
      this.emit(S, 'reversal', [ev], { headline: `Reverted with git ${g.op} ${trunc(g.args, 50)}`, evidence: { command: ev.d.input.command } });
    } else if (g.op === 'worktree' && /\badd\b/.test(g.args)) {
      this.emit(S, 'pivot', [ev], { headline: 'Opened a worktree for a parallel try', evidence: { command: ev.d.input.command } });
    } else if ((g.op === 'checkout' || g.op === 'switch') && g.branch && S.branch && g.branch !== S.branch) {
      const mins = Math.round((t - S.branchSince) / MIN);
      if (mins >= 45) this.emit(S, 'pivot', [ev], { headline: `Left ${S.branch} after ${mins} min for ${g.branch}`, branch: g.branch, evidence: { from: S.branch, to: g.branch, minutes: mins } });
      S.branch = g.branch; S.branchSince = t;
    }
    if (g.branch && !S.branch) { S.branch = g.branch; S.branchSince = t; }
    if (g.op === 'commit') this.closeByCommit(S, ev, t, g);
  }

  onBash(S, ev, t) {
    const cmd = skeleton(ev.d.input.command || '');
    const dep = deploySegment(cmd);
    if (dep && !(ev.d.git && ev.d.git.op !== 'pr-merge')) {
      const what = trunc(dep.replace(/\s+\d?>>?\s*(?:&\d|\/dev\/null|\S+)/g, '').trim(), 80);
      // The same deploy again within 6 hours of the last one that counted is routine: recorded, but under the feed.
      S.deploys ||= new Map();
      const last = S.deploys.get(what);
      const again = last != null && t - last < 6 * 60 * MIN;
      if (!again) S.deploys.set(what, t);
      this.emit(S, 'shipped', [ev], { headline: `${again ? 'Deployed again' : 'Deployed'}: ${what}`, evidence: { command: trunc(ev.d.input.command || cmd, 300) }, ...(again ? { base: 30 } : {}) });
    }
    let m;
    if ((m = DEP_REMOVE_RE.exec(cmd)) && pkgSet(m[1]).size) S.pendingRemove = { t, pkgs: pkgSet(m[1]), ev };
    else if ((m = DEP_ADD_RE.exec(cmd)) && S.pendingRemove && t - S.pendingRemove.t <= 10 * MIN) {
      const added = pkgSet(m[1]);
      if (added.size && [...added].some((p) => !S.pendingRemove.pkgs.has(p))) {
        this.emit(S, 'pivot', [S.pendingRemove.ev, ev], { headline: `Swapped ${[...S.pendingRemove.pkgs].join(', ')} for ${[...added].join(', ')}`, evidence: { command: trunc(cmd, 200) } });
      }
      S.pendingRemove = null;
    }
    if ((m = RM_RE.exec(cmd))) {
      for (const tok of m[1].split(/\s+/).map((x) => x.replace(/^['"]|['"]$/g, '')).filter((x) => x && !x.startsWith('-'))) {
        for (const [f, wt] of S.writes) {
          if ((f === tok || f.endsWith('/' + tok.replace(/^\.\//, '')) || f.endsWith('\\' + tok)) && t - wt <= 30 * MIN) {
            this.emit(S, 'pivot', [ev], { headline: `Deleted ${tok.split(/[\\/]/).pop()} ${Math.max(1, Math.round((t - wt) / MIN))} min after writing it`, files: [f], evidence: { command: trunc(cmd, 200) } });
            S.writes.delete(f);
          }
        }
      }
    }
  }

  onRead(S, ev, t, path) {
    if (!path) return;
    if (!S.cut) { S.reads.add(path); return; }
    if (t - S.cut.t <= 10 * MIN && S.cut.before.has(path)) {
      S.cut.rereads.push(ev);
      if (S.cut.rereads.length >= 2 && !S.cut.emitted) {
        S.cut.emitted = true;
        this.emit(S, 'memory-cut', [S.cut.ev, ...S.cut.rereads], { headline: `Compaction, then re-read ${S.cut.rereads.length} files already seen`, actors: ['main'], evidence: { files: S.cut.rereads.map((e) => e.d.input.file_path) } });
      }
    } else if (t - S.cut.t > 10 * MIN) S.reads.add(path);
  }

  onMessage(S, ev, t, isSub) {
    const text = ev.d.last || '';
    if (text.length < 15) return;
    // The verdict is the opening sentence: a long report that mentions "missing" somewhere is not a pushback.
    const v = verdictOf(text);
    const msg = { id: ev.id, ev, actor: ev.actor, t, pos: POS.test(v), neg: NEG.test(v), text, topics: topicsOf(v) };
    if (isSub && msg.neg) {
      const other = [...S.msgs].reverse().find((o) => o.actor !== ev.actor && o.pos && !o.neg && t - o.t <= 45 * MIN && o.topics.some((x) => msg.topics.includes(x)));
      if (other) {
        this.emit(S, 'disagreement', [other.ev, ev], {
          headline: `${this.label(S, ev.actor)} pushed back on ${this.label(S, other.actor)}`,
          body: [`${this.label(S, other.actor)}: “${trunc(other.text, 110)}”`, `${this.label(S, ev.actor)}: “${trunc(text, 110)}”`],
          actors: [other.actor, ev.actor], evidence: { a: trunc(other.text, 400), b: trunc(text, 400), actors: [other.actor, ev.actor] },
        });
      }
    }
    S.msgs.push(msg); if (S.msgs.length > 12) S.msgs.shift();
    // A subagent's report describes things (a site's "placeholder" page); only an explicit deferral there is a decision.
    if (isSub && !/^[[{<|]/.test(text.trim()) && DEFERRAL_RE.test(text)) this.hedgeFrom(S, ev, t, text);
  }

  onModel(S, ev, t) {
    const { from, to } = ev.d;
    if (to) S.model = to;
    if (rank(to) <= rank(from)) return;
    const active = [...S.fails.values()].some((arr) => arr.filter((e) => t - e._t < 15 * MIN).length >= 2);
    if (active) this.emit(S, 'escalation', [ev], { headline: `Switched ${from || '?'} → ${to} to get unstuck`, actors: ['main'], evidence: { from, to } });
  }

  onDenied(S, ev, t) {
    S.waitMark = null;
    const d = ev.d;
    this.emit(S, 'refusal', [ev], { headline: `${d.tool || 'A tool call'} was denied${d.reason ? ': ' + trunc(d.reason, 80) : ''}`, evidence: { tool: d.tool, input: d.input, reason: d.reason } });
  }

  waitCheck(S, ev, t) {
    const w = S.waitMark;
    if (!w || w.ev.id === ev.id) return;
    const mins = (t - w.t) / MIN;
    if (mins >= this.cfg.detectors.waitMinutes) {
      this.emit(S, 'wait', [w.ev, ev], { actors: ['main', 'human'], headline: `Waited ${Math.round(mins)} min on you`, evidence: { minutes: Math.round(mins) } });
      S.waitMark = null;
    }
  }

  // ---------- human decisions ----------
  recentAuto(S) {
    return [...this.moments.values()].filter((m) => m.sid === S.sid && m.status === 'auto' && m.kind !== 'mark').sort((a, b) => b.t1 - a.t1)[0];
  }
  onMark(S, ev, t) {
    const d = ev.d;
    if (d.flag === '?') { this.openThread(S, ev, t, 'mark', d.note || 'open question', topicsOf(d.note || ''), null); return; }
    let target = d.target && this.moments.get(d.target);
    if (!target) { const r = this.recentAuto(S); if (r && t - r.t1 <= 5 * MIN) target = r; }
    if (target) { target.status = 'confirmed'; target.rescore = 100; if (d.note) target.note = d.note; this._ch.moments.add(target.id); return; }
    const evs = S.ring.length ? S.ring.slice(-10) : [ev.id];
    const m = this.emit(S, 'mark', [ev], { actors: ['human'], headline: d.note ? trunc(d.note, 100) : 'Marked this moment', note: d.note || null, evidence: { ring: evs } });
    m.span.ids = [...new Set([...evs, ev.id])]; m.span.first = m.span.ids[0]; m.span.count = m.span.ids.length;
    m.t0 = S.end - 1; m.status = 'confirmed';
  }
  onDismiss(S, ev, t) {
    const d = ev.d;
    const m = (d.target && this.moments.get(d.target)) || this.recentAuto(S);
    if (!m || m.status === 'dismissed') return;
    m.status = 'dismissed';
    this.dismissals[m.kind] = (this.dismissals[m.kind] || 0) + 1;
    this._ch.moments.add(m.id);
  }
  /** A past post (imported from a scheduler or platform archive) attaches to the moment it told, by explicit id or by wording. */
  onPostReceipt(ev, t) {
    const d = ev.d || {};
    let m = d.moment && (this.moments.get(d.moment) || [...this.moments.values()].find((x) => x.id.startsWith(d.moment)));
    if (!m && d.text) {
      const tok = (x) => new Set((String(x).toLowerCase().match(/[a-z][a-z0-9'-]{3,}/g) || []));
      const pt = tok(d.text);
      let best = null, bs = 0;
      for (const c of this.moments.values()) {
        if (c.status === 'dismissed' || c.status === 'merged' || c.t1 > t + 3600e3 || t - c.t1 > 14 * 86400e3) continue;
        const mt = tok([c.headline, ...(c.body || []), c.evidence && c.evidence.prompt, c.evidence && c.evidence.subject].filter(Boolean).join(' '));
        if (!mt.size || !pt.size) continue;
        let n = 0; for (const w of pt) if (mt.has(w)) n++;
        const sc = n / Math.min(pt.size, mt.size);
        if (sc > bs) { bs = sc; best = c; }
      }
      if (best && bs >= 0.4) m = best;
    }
    this.receipts = this.receipts || [];
    const r = { channel: d.channel, url: d.url || null, ts: ev.ts, t, moment: m ? m.id : null, event: ev.id };
    this.receipts.push(r);
    if (m) { (m.posts ||= []).push({ channel: r.channel, url: r.url, ts: r.ts }); this._ch.moments.add(m.id); }
  }

  /** Tier 2: the extractor's verdicts arrive as ordinary events, so replaying the log reproduces them. */
  onExtract(ev, t) {
    const d = ev.d || {};
    const S = this.S(ev.sid);
    if (ev.kind === 'extract.moment') {
      let m = d.target && this.moments.get(d.target);
      if (!m) {
        const id = `${d.cite[0]}.${d.kind}`;
        m = this.moments.get(id);
        if (!m) {
          m = {
            id, kind: d.kind, sid: ev.sid, base: BASE[d.kind] ?? 50, status: 'auto', note: null, headline: '', body: [], actors: [], files: [], branch: null, thread: null,
            span: { first: d.cite[0], last: d.cite[d.cite.length - 1], count: d.cite.length, ids: d.cite.slice(0, 40) }, t0: d.t0, t1: d.t1, evidence: {}, tp: d.tp || [], detector: d.kind, tier: 2, demo: S.demo,
          };
          this.moments.set(id, m);
        }
      }
      m.headline = d.headline; m.body = d.body || []; m.xscore = Math.max(0, Math.min(100, Math.round(d.score)));
      m.evidence = { ...m.evidence, ...(d.evidence || {}) }; m.tier = 2; m.extracted = ev.id;
      if (d.actors && d.actors.length) m.actors = [...new Set(d.actors)];
      if (d.files && d.files.length) m.files = [...new Set([...m.files, ...d.files])];
      this._ch.moments.add(m.id);
    } else if (ev.kind === 'extract.drop') {
      const m = this.moments.get(d.target);
      if (m && m.status === 'auto') { m.status = 'dropped'; m.dropReason = d.reason || null; this._ch.moments.add(m.id); }
    } else if (ev.kind === 'extract.merge') {
      this.onMerge({ target: d.target, into: d.into });
    } else if (ev.kind === 'extract.thread') {
      const th = this.threads.get(d.thread);
      if (th && !th.closed && d.op === 'close') { this.closeThread(th, ev, t, 'extractor'); th.closed.text = trunc(d.resolution || '', 140); }
      else if (d.op === 'open' && d.text) {
        this.openThread(S, ev, t, 'extracted', d.text, topicsOf(d.text), null);
      }
    } else if (ev.kind === 'extract.run') {
      this.lastExtract = { id: ev.id, ts: ev.ts, t, n: d.n || 0 };
    } else if (ev.kind === 'extract.auto') {
      this.lastAuto = { t, ok: !!d.ok, fails: d.ok ? 0 : ((this.lastAuto && this.lastAuto.fails) || 0) + 1, error: d.error || null, trigger: d.trigger };
    }
  }
  onMerge(d) {
    const a = this.moments.get(d.target), b = this.moments.get(d.into);
    if (!a || !b || a === b) return;
    b.span.ids = [...new Set([...b.span.ids, ...a.span.ids])].slice(0, 60); b.span.count = b.span.ids.length;
    b.t0 = Math.min(a.t0, b.t0); b.t1 = Math.max(a.t1, b.t1);
    b.actors = [...new Set([...b.actors, ...a.actors])]; b.files = [...new Set([...b.files, ...a.files])];
    b.tp = [...b.tp, ...a.tp].slice(0, 8);
    b.base = Math.max(a.base, b.base);
    b.body = [...b.body, `Merged: ${a.headline}`].slice(0, 5);
    a.status = 'merged';
    this._ch.moments.add(a.id); this._ch.moments.add(b.id);
  }

  // ---------- threads ----------
  hedgeFrom(S, ev, t, text) {
    if (!text || !HEDGE_RE.test(text)) return;
    const sentence = hedgeSentence(text);
    if (!sentence) return;
    this.openThread(S, ev, t, 'hedge', sentence, topicsOf(sentence), null);
  }
  openThread(S, ev, t, kind, text, topics, key) {
    if (this.threads.has(ev.id)) return this.threads.get(ev.id);
    const norm = text.toLowerCase().replace(/\W+/g, ' ').trim();
    for (const th of this.threads.values()) if (!th.closed && th.norm === norm) return th;
    const near = S.lastMoment && t - S.lastMoment.t1 <= 10 * MIN ? S.lastMoment : null;
    const th = {
      id: ev.id, kind, text: trunc(text, 220), norm, topics, key: key || null, sid: S.sid, prompt_id: ev.prompt_id,
      opened_by: this.label(S, ev.actor), opened_actor: ev.actor, opened_t: t, opened_ts: ev.ts, closed: null, moment: near ? near.id : null, tp: ev.tp ? { ...ev.tp } : null,
    };
    this.threads.set(th.id, th);
    if (near && !near.thread) near.thread = th.id;
    this._ch.threads.add(th.id);
    return th;
  }
  closeThread(th, ev, t, how) {
    th.closed = { event: ev.id, ts: ev.ts, t, how, by: this.label(this.S(ev.sid), ev.actor), text: ev.kind === 'prompt' ? trunc(ev.d.text, 140) : ev.d.git ? trunc(ev.d.git.subject || '', 140) : null };
    this._ch.threads.add(th.id);
  }
  closeElicitation(S, ev, t) {
    S.waitMark = null;
    const key = ev.d.extra && ev.d.extra.elicitation_id;
    const open = [...this.threads.values()].filter((th) => !th.closed && th.kind === 'elicitation' && (!key || !th.key || th.key === key));
    if (open.length) this.closeThread(open[open.length - 1], ev, t, 'answered');
  }
  closeByTopics(S, ev, t, topics, how) {
    if (!topics.length) return;
    for (const th of this.threads.values()) {
      if (th.closed || th.kind === 'question' || th.kind === 'elicitation' || th.opened_t >= t || (th.prompt_id && th.prompt_id === ev.prompt_id)) continue;
      if (th.topics.some((x) => topics.includes(x))) this.closeThread(th, ev, t, how);
    }
  }
  /** A commit closes a hedge only if its subject speaks to the topic, or it touches the thread's files in a later session. */
  closeByCommit(S, ev, t, g) {
    if (!g.subject || HEDGE_RE.test(g.subject)) return;
    const subj = new Set(topicsOf(g.subject));
    const base = (g.files || []).map((f) => f.split(/[\\/]/).pop().toLowerCase());
    for (const th of this.threads.values()) {
      if (th.closed || th.kind === 'question' || th.kind === 'elicitation' || th.opened_t >= t || (th.prompt_id && th.prompt_id === ev.prompt_id)) continue;
      const files = th.topics.filter((x) => x.includes('.'));
      const words = th.topics.filter((x) => !x.includes('.') && !files.some((f) => f.startsWith(x + '.')));
      if (words.some((w) => subj.has(w)) || (th.sid !== S.sid && files.some((f) => base.includes(f)))) this.closeThread(th, ev, t, 'commit');
    }
  }
  onThreadClose(S, ev, t) {
    const id = ev.d.target;
    const th = [...this.threads.values()].find((x) => !x.closed && (x.id === id || x.id.startsWith(id)));
    if (th) this.closeThread(th, ev, t, 'manual');
  }

  // ---------- derived views ----------
  sessionList() {
    const per = new Map();
    for (const m of this.moments.values()) per.set(m.sid, (per.get(m.sid) || 0) + 1);
    return [...this.sessions.values()].map((S) => ({
      sid: S.sid, start: S.start, end: S.end, parent: S.parent, source: S.source, model: S.model, title: S.title || null, demo: S.demo, headless: S.headless || null, events: S.events, ended: !!S.ended,
      actors: [...S.actors.values()], stats: { ...S.stats, moments: per.get(S.sid) || 0 }, branch: S.branch,
    })).sort((a, b) => a.start - b.start);
  }

  // ---------- retention ----------
  /** Derived state at `at`, for a trim that removes the raw events of `sids`. Everything else replays from the log. */
  snapshot(sids, at) {
    const prev = this.snap ? [...this.snap.sids] : [];
    const all = new Set([...prev, ...sids]);
    const sess = [...all].map((sid) => this.sessions.get(sid)).filter(Boolean).map((S) => ({
      sid: S.sid, start: S.start, end: S.end, parent: S.parent, source: S.source, model: S.model, title: S.title || null, demo: S.demo, headless: S.headless || null,
      events: S.events, ended: S.ended, branch: S.branch, stats: S.stats, actors: [...S.actors.values()], status: S.status,
    }));
    return JSON.parse(JSON.stringify({
      v: 1, at, sids: [...all], sessions: sess, moments: [...this.moments.values()], threads: [...this.threads.values()],
      dismissals: this.dismissals, tags: [...(this.tags || new Map())], receipts: this.receipts || [], lastExtract: this.lastExtract || null, lastAuto: this.lastAuto || null,
      failHist: [...(this.failHist || new Map())], files: [...(this.files || new Map())].map(([f, r]) => [f, { s: Object.fromEntries(Object.entries(r.s).filter(([sid]) => all.has(sid))), c: r.c }]), warm: [...this.warm.values()].filter((w) => all.has(w.sid)),
    }));
  }
  /** Load a snapshot before replaying the log (Project.init does this). */
  restore(snap) {
    this.snap = { at: snap.at, sids: new Set(snap.sids) };
    for (const m of snap.moments) { this.moments.set(m.id, m); this._restored.add(m.id); }
    for (const th of snap.threads) this.threads.set(th.id, th);
    this.dismissals = { ...snap.dismissals };
    if (snap.tags) this.tags = new Map(snap.tags);
    if (snap.receipts.length) this.receipts = snap.receipts;
    if (snap.lastExtract) this.lastExtract = snap.lastExtract;
    if (snap.lastAuto) this.lastAuto = snap.lastAuto;
    if (snap.failHist) this.failHist = new Map(snap.failHist);
    if (snap.files) this.files = new Map(snap.files);
    for (const w of snap.warm || []) this.warm.set(w.id, w);
    for (const x of snap.sessions) {
      const S = this.S(x.sid);
      Object.assign(S, { start: x.start, end: x.end, parent: x.parent, source: x.source, model: x.model, title: x.title, demo: x.demo, headless: x.headless || null, events: x.events, ended: x.ended, branch: x.branch, stats: x.stats, status: x.status || {} });
      S.actors = new Map(x.actors.map((a) => [a.id, a]));
    }
    this.lastTs = Math.max(this.lastTs, ...snap.sessions.map((x) => x.end || 0)); // the trimmed events' times
    this._arcs = null;
  }
  header(sid) {
    const S = sid ? this.sessions.get(sid) : [...this.sessions.values()].sort((a, b) => b.end - a.end)[0];
    if (!S) return null;
    return {
      sid: S.sid, start: S.start, end: S.end, model: S.model, events: S.events, openThreads: this.openThreads().length, ended: !!S.ended,
      actors: [...S.actors.values()].map((a) => ({ ...a, status: S.status[a.id] || null })),
    };
  }

  /** Arcs: moments that share a file, a non-main branch or a thread (within 5 days), or sit close together in one session. */
  arcs() {
    if (this._arcs) return this._arcs;
    const ms = this.listMoments({ min: 30 }).filter((m) => m.kind !== 'wait');
    const parent = new Map(ms.map((m) => [m.id, m.id]));
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
    const DAY = 86400000;
    for (let i = 0; i < ms.length; i++) {
      for (let j = i - 1; j >= 0; j--) {
        const a = ms[j], b = ms[i];
        const gap = b.t0 - a.t1;
        if (gap > 5 * DAY) break;
        const shareFile = a.files.some((f) => b.files.includes(f));
        const shareBranch = a.branch && a.branch === b.branch && !this.isMain(a.branch);
        const shareThread = a.thread && a.thread === b.thread;
        const near = a.sid === b.sid && gap <= 90 * MIN;
        if (shareFile || shareBranch || shareThread || near) { union(a.id, b.id); }
      }
    }
    const groups = new Map();
    for (const m of ms) { const r = find(m.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(m); }
    const arcs = [];
    for (const list of groups.values()) {
      list.sort((a, b) => a.t0 - b.t0);
      const kinds = new Set(list.map((m) => m.kind));
      const lastShip = [...list].reverse().find((m) => m.kind === 'shipped');
      const outcome = lastShip && lastShip === list[list.length - 1] ? lastShip : lastShip || null;
      const struggle = list.some((m) => ['fight', 'broke', 'refusal', 'reversal', 'memory-cut', 'escalation', 'misread', 'frustration', 'recurring', 'detour'].includes(m.kind));
      const days = (list[list.length - 1].t1 - list[0].t0) / DAY;
      const agentActors = new Set(list.flatMap((m) => m.actors).filter((a) => a.startsWith('agent:')));
      let shape;
      if (kinds.has('disagreement') && agentActors.size >= 1) shape = 'team disagreement';
      else if (kinds.has('pivot')) shape = 'pivot';
      else if (outcome && struggle) shape = 'comeback';
      else if (!outcome && kinds.has('fight')) shape = 'dead end';
      else if (days >= 3 && list.length >= 3) shape = 'slow burn';
      else if (outcome) shape = 'clean ship';
      else shape = 'in progress';
      const open = !outcome;
      const ageDays = (this.lastTs - list[list.length - 1].t1) / DAY;
      arcs.push({
        id: list[0].id, shape, moments: list.map((m) => m.id), t0: list[0].t0, t1: list[list.length - 1].t1, duration_ms: list[list.length - 1].t1 - list[0].t0,
        actors: [...new Set(list.flatMap((m) => m.actors))], sessions: [...new Set(list.map((m) => m.sid))], outcome: outcome ? outcome.id : null,
        status: open ? (ageDays >= this.cfg.arcOpenDays ? 'unfinished' : 'open') : 'closed',
        title: (outcome || list.slice().sort((a, b) => b.score - a.score)[0]).headline, score: Math.max(...list.map((m) => m.score)),
        demo: list.every((m) => m.demo),
      });
    }
    this._arcs = arcs.sort((a, b) => a.t0 - b.t0);
    return this._arcs;
  }
}

/** Package names from the arguments of one install/remove: stops at the first shell operator, skips flags and redirections. */
function pkgSet(s) {
  const args = String(s || '').split(/\s*(?:&&|\|\||;|\||\n)\s*/)[0];
  return new Set(args.split(/\s+/).filter((x) => x && !x.startsWith('-') && !/[<>&]/.test(x))
    .map((x) => x.replace(/^(@?[^@\s]+)@[\w^~.*<>=-]+$/, '$1'))
    .filter((x) => /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(x)));
}
