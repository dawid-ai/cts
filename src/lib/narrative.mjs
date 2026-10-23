// The only part of CTS that writes prose. Deterministic templates over the log: every draft links to its source moment,
// every number and quote in it must trace to an event (checkDraft), and everything passes through the redactor first.
import fs from 'node:fs';
import path from 'node:path';
import { ulid, trunc, paths } from './util.mjs';
import { redact, redactDeep } from './redact.mjs';
import { redactOpts, evidenceLine, cardSvg } from './share.mjs';
import { writeHumanEvent } from './log.mjs';
import { claimProblems, askApi, askClaude, parseAnswer } from './extract.mjs';
import { summarize } from './summary.mjs';
import { loadVoice, suggestionId } from './voice.mjs';
import { textHash, postsOf, POST_SEP } from './drafts.mjs';
import { consentMoment, consentText, consentEvent } from './consent.mjs';
import { tagValues, fillTags } from './tags.mjs';

const MIN = 60000, DAY = 86400000;
export const SOCIAL = ['x', 'bluesky', 'mastodon', 'threads'];
const firstPerson = (s) => String(s || '').replace(/^You\b/, 'I').replace(/\bon you\b/gi, 'on me').replace(/\bYou\b/g, 'I');

export function quote(s, n = 110) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length <= n) return `“${s}”`;
  const cut = s.slice(0, n).replace(/\s+\S*$/, '');
  return cut ? `“${cut}”…` : '';
}
// Runner summaries and banners (jest `Tests:`, vitest `Test Files  1 failed | 2 passed`, `⎯⎯ Failed Tests 1 ⎯⎯`) are counts, not errors.
const SUMMARY_LINE = /^(?:tests?|test (?:suites?|files)|duration|start at)\b:?\s|^[⎯─=-]+\s*failed tests\b|^\d+ (?:passed|failed)\b/i;
const errLine = (out) => {
  const ls = String(out || '').split('\n').map((l) => l.trim()).filter((l) => l && !SUMMARY_LINE.test(l));
  const hit = [...ls].reverse().find((l) => /^[×✗✕]\s|expected|received|error|assert|fail|cannot|undefined|not found|timeout/i.test(l)) || ls[ls.length - 1];
  return hit ? hit.replace(/\s+\d+ms$/, '').slice(0, 110) : '';
};
const numsIn = (v, acc = []) => {
  if (typeof v === 'number') acc.push(v);
  else if (typeof v === 'string') (v.match(/\d+/g) || []).forEach((x) => acc.push(+x));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => numsIn(x, acc));
  return acc;
};
const label = (pr, m, a) => { const S = pr.engine.sessions.get(m.sid); const x = S && S.actors.get(a); return x ? x.label : a; };

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const minsIn = (s) => { const x = /(\d+) min\b/.exec(String(s)); return x ? +x[1] : null; };
const actorWord = (pr, m, a) => (a === 'human' ? 'I' : a === 'main' ? 'the main agent' : `the ${label(pr, m, a)} agent`);

/**
 * What a moment was, told in plain first-person words. Posts are stories: the log's prompts, commands, branches, paths,
 * test names and error lines are material, never quoted (the dashboard keeps them as evidence). One number at most.
 */
function storyLines(pr, m) {
  const E = m.evidence || {}, h = String(m.headline || '');
  switch (m.kind) {
    case 'fight': return [E.attempts ? `It took ${E.attempts} failed attempts before it finally passed.` : 'I kept hitting the same failure before it finally passed.'];
    case 'broke': { const n = E.counts && E.counts.fail; return [n ? `A change broke ${plural(n, 'test')} that ${n === 1 ? 'was' : 'were'} passing before.` : 'A change broke something that was working before.']; }
    case 'reversal': return [E.prompt ? 'I stopped and pulled the work back to an earlier direction.' : 'I threw a change away and went back to the earlier version.'];
    case 'refusal': return [E.prompt ? 'I said no to what was proposed.' : 'I blocked a step before it ran.'];
    case 'disagreement': { const [b, a] = m.actors || []; return [`${actorWord(pr, m, a || 'main')} pushed back on ${actorWord(pr, m, b || 'main')}.`.replace(/^./, (c) => c.toUpperCase())]; }
    case 'shipped':
      if (E.tag) return [`I released version ${String(E.tag).replace(/^v(?=\d)/, '')}.`];
      if (/^Merged into/.test(h)) return ['I merged the work in.'];
      if (/^Pull request/.test(h)) return ['The pull request went in.'];
      if (/^Deployed again/.test(h)) return ['I deployed it again.'];
      if (/^Deployed/.test(h)) return ['I deployed it.'];
      return ['I shipped it.'];
    case 'pivot':
      if (E.minutes) return [`After ${E.minutes} minutes on one approach, I switched to another.`];
      if (/^Swapped/.test(h)) return ['I swapped one library for another.'];
      if (/^Deleted/.test(h)) { const n = minsIn(h); return [n ? `I deleted something ${plural(n, 'minute')} after writing it.` : 'I deleted something soon after writing it.']; }
      return ['I set the work aside and tried another path in parallel.'];
    case 'memory-cut': { const n = (E.files || []).length; return [n ? `After the context was compacted, the agent re-read ${plural(n, 'file')} it had already seen.` : 'After the context was compacted, the agent re-read files it had already seen.']; }
    case 'escalation': return ['I switched models to get unstuck.'];
    case 'misread': return [E.after_confident ? 'The agent said it was done, but it had answered a different question than the one I asked.' : 'The agent took my request the wrong way, and I had to spell out what I actually meant.'];
    case 'frustration': if (E.repeat_of) return [E.after_confident ? 'It said it was done, and I had to ask for the same thing again.' : 'I had to ask for the same thing again.'];
      return [E.after_confident ? 'It was supposed to be done, and it still was not doing what I needed. I was losing patience.' : 'I was losing patience: it still was not doing what I needed.'];
    case 'recurring': { const n = E.sessions, when = n ? `in ${plural(n, 'earlier session')}` : 'before';
      return [E.via === 'prompt' ? `I came back with a problem I had already brought up ${when}.` : E.via === 'error' ? `An error I had already hit ${when} showed up again.` : `A test I had already fought with ${when} failed again.`]; }
    case 'detour': return ['A failure sent me on a side quest: the fix was in a different part of the code from the one I set out to change.'];
    case 'wait': return [E.minutes ? `The agent sat waiting ${E.minutes} minutes for me.` : 'The agent sat waiting for me.'];
    default: return [m.note || firstPerson(h)];
  }
}

/** One moment as 1-3 lines of first-person prose, plus the events and structural numbers its claims rest on. */
export function beat(pr, m) {
  m = consentMoment(pr, m);
  const E = m.evidence || {};
  const extra = [...numsIn(m.headline), ...numsIn(E.stat), E.stat ? E.stat.ins + E.stat.del : null, ...numsIn(E.counts), E.attempts, E.minutes, (E.files || []).length || null, ...Object.entries(E).filter(([k, v]) => k.endsWith('_ms') && typeof v === 'number').flatMap(([, v]) => [Math.max(1, Math.round(v / MIN)), Math.round(v / 1000)])].filter((x) => x != null);
  const lines = m.tier === 2 ? [m.headline, ...(m.body || []).filter(Boolean).slice(0, 2)] : storyLines(pr, m);
  return { lines: lines.filter(Boolean), refs: m.span.ids, extra, errLine: errLine(E.error) };
}

export function resolveSource(pr, id) {
  const e = pr.engine;
  if (String(id).startsWith('arc:')) {
    const want = String(id).slice(4);
    const arc = e.arcs().find((a) => want === a.id || want.startsWith(a.id + ':') || a.id.startsWith(want));
    return arc ? { type: 'arc', id: 'arc:' + arc.id + ':' + (arc.outcome || arc.status), arc, ms: arc.moments.map((x) => e.view(e.moments.get(x))) } : null;
  }
  const m = e.moments.get(id) || [...e.moments.values()].find((x) => x.id.endsWith(id) || x.id.startsWith(id));
  if (m) return { type: 'moment', id: m.id, m: e.view(m), ms: [e.view(m)] };
  return null;
}
export const formatFor = (src, channel) => (SOCIAL.includes(channel) ? 'short' : channel === 'linkedin' ? 'linkedin' : channel === 'changelog' ? 'devlog' : 'long');

const lineFit = (lines, limit) => {
  lines = [...lines];
  const len = () => lines.join('\n').length;
  while (len() > limit && lines.length > 1) lines.pop();
  let t = lines.join('\n');
  if (t.length > limit) t = t.slice(0, limit - 1).replace(/\s+\S*$/, '') + '…';
  return t;
};
const dateOf = (t) => new Date(t).toISOString().slice(0, 10);

/** Assemble the draft text. Returns { text, refs, extra, title, lead }. */
export function compose(pr, src, channel, format) {
  const voice = loadVoice(pr.root);
  const v = voice.for(channel);
  const chcfg = (pr.cfg.publishing.channels || {})[channel] || {};
  const limit = Math.min(v.max || Infinity, chcfg.limit || Infinity);
  const ms = src.ms.slice().sort((a, b) => a.t0 - b.t0);
  const beats = ms.map((m) => ({ m: consentMoment(pr, m), b: beat(pr, m) }));
  // What a multi-beat post tells: a repeated sentence once, a run of releases as its last one.
  const told = beats.reduce((a, x) => { const p = a[a.length - 1]; if (p && (p.b.lines.join() === x.b.lines.join() || (p.m.kind === 'shipped' && x.m.kind === 'shipped'))) a[a.length - 1] = x; else a.push(x); return a; }, []);
  const refs = [...new Set(beats.flatMap((x) => x.b.refs))].slice(0, 200);
  const extra = [...new Set(beats.flatMap((x) => x.b.extra))];
  // The title is the top moment told as a story, not its dashboard headline.
  const top = (src.type === 'arc' && beats.find((x) => x.m.headline === consentText(pr, src.arc.title, [x.m]))) || beats[0];
  const title = top.b.lines[0].replace(/\.$/, '');
  const report = [];
  const red = (s) => { const r = redact(s, redactOpts(pr)); report.push(...r.report); return r.text; };
  let text;
  if (src.unfinished) {
    const days = Math.max(1, Math.round((pr.engine.lastTs - src.arc.t0) / DAY));
    extra.push(days, ms.length);
    const lines = [`Still unfinished after ${days} days. ${top.b.lines[0]}`, `${ms.length} moments so far, no outcome yet.`];
    text = lineFit(lines.map(red), limit);
  } else if (format === 'short') {
    const lines = beats[0].b.lines.map(red);
    if (!lines.length) return null;
    let t = lineFit(lines, limit);
    if (v.opener && (v.opener + '\n' + t).length <= limit) t = v.opener + '\n' + t;
    if (v.signoff && (t + '\n' + v.signoff).length <= limit) t += '\n' + v.signoff;
    text = t;
  } else if (format === 'thread') {
    const picks = told.filter((x) => x.m.score >= 50).slice(0, 8);
    const use = picks.length ? picks : told.slice(0, 8);
    const N = use.length;
    const posts = use.map((x, i) => `${i + 1}/${N} ` + lineFit(x.b.lines.map(red), Math.max(40, limit - `${i + 1}/${N} `.length)));
    if (v.signoff && (posts[N - 1] + '\n' + v.signoff).length <= limit) posts[N - 1] += '\n' + v.signoff;
    text = posts.join(POST_SEP);
  } else if (format === 'linkedin') {
    const paras = told.map((x) => red(x.b.lines.join(' ')));
    const lesson = ms.find((m) => m.kind === 'learned') || ms.find((m) => m.note);
    let tail = lesson ? `What I took from it: ${red(lesson.note || lesson.headline)}` : '';
    const head = v.opener ? [v.opener] : [];
    const foot = [tail, v.signoff].filter(Boolean);
    let body = [...paras];
    const join = () => [...head, ...body, ...foot].join('\n\n');
    while (join().length > limit && body.length > 1) body.splice(Math.floor(body.length / 2), 1);
    text = join();
    if (text.length > limit) text = text.slice(0, limit - 1).replace(/\s+\S*$/, '') + '…';
  } else if (format === 'long') {
    const tags = [...new Set(ms.map((m) => m.kind))];
    const fm = ['---', `title: "${red(title).replace(/"/g, '\\"')}"`, `date: ${dateOf(ms[ms.length - 1].t1)}`, 'draft: true', `tags: [${tags.join(', ')}]`, 'source: cts', '---', ''];
    text = [...fm, ...told.flatMap((x) => [red(x.b.lines.join(' ')), ''])].join('\n');
  } else if (format === 'devlog') {
    text = beats.map((x) => `- ${dateOf(x.m.t1)}: ${red(x.b.lines[0])}${evidenceLine(x.m) ? ` (${evidenceLine(x.m)})` : ''}`).join('\n');
  } else return null;
  return { text, refs, extra, title: red(title), voiceRev: voice.rev, ms, report };
}

/** The honesty guard for a draft: numbers, number-words and quotes must trace to the cited events or the voice file. */
export function checkDraft(pr, d) {
  const problems = [];
  const evs = (d.claims.refs || []).map((id) => pr.eventById(id)).filter(Boolean);
  if (!evs.length) problems.push('no cited events');
  const voice = loadVoice(pr.root);
  let body = String(d.text);
  body = body.replace(/^---\n[\s\S]*?\n---\n/, '');                                   // front matter is metadata
  body = body.replace(/\d{4}-\d\d-\d\d(?:[ T]\d\d:\d\d)?|\b\d\d:\d\d\b/g, ' ');       // dates and clock times
  body = postsOf(body).map((p) => p.replace(/^\d+\/\d+\s/, '')).join('\n');          // thread numbering
  body = body.replace(/\[redacted\]|\[repo\]|\[masked\]/g, ' ');
  const quotes = [...body.matchAll(/“([^”]+)”/g)].map((m) => m[1]);
  const opts = redactOpts(pr);
  const pm = claimProblems(body.replace(/“[^”]*”/g, ' '), evs, { quotes, extra: d.claims.extra || [], voiceText: voice.text, redactFn: (t) => redact(t, opts).text });
  if (pm) problems.push(pm);
  const low = d.text.toLowerCase();
  for (const w of voice.never) if (w && new RegExp(`(?<![\\w])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i').test(low)) problems.push(`uses "${w}", which your voice profile says to never use`);
  const lim = ((pr.cfg.publishing.channels || {})[d.channel] || {}).limit;
  if (lim && ['short', 'thread'].includes(d.format)) for (const p of postsOf(d.text)) if (p.length > lim) problems.push(`a post is ${p.length} characters; ${d.channel} allows ${lim}`);
  const red = redact(d.text, opts);
  const items = red.report.length + ((d.redaction && d.redaction.count) || 0);
  return { ok: problems.length === 0, problems, redactionClean: items === 0, redactionItems: items };
}

function cardFor(pr, m, channel, id, story) {
  try {
    const opts = redactOpts(pr);
    // A story's card carries its title and angle, not the dashboard headline and diff stats.
    const pub = story ? { id: m.id, kind: m.kind, label: story.angle || 'story', score: '', headline: story.title, actors: m.actors.map((a) => label(pr, m, a)), evidence: {}, evidence_line: '' }
      : { id: m.id, kind: m.kind, score: m.score, headline: redact(firstPerson(m.headline), opts).text, actors: m.actors.map((a) => label(pr, m, a)), evidence: m.evidence, evidence_line: redact(evidenceLine(m), opts).text };
    const dir = path.join(paths(pr.root).cts, 'drafts');
    fs.mkdirSync(dir, { recursive: true });
    const rel = path.join('drafts', `${id}.svg`);
    fs.writeFileSync(path.join(paths(pr.root).cts, rel), cardSvg(pub, channel === 'linkedin' ? 'linkedin' : SOCIAL.includes(channel) ? 'x' : 'og'));
    return rel.replace(/\\/g, '/');
  } catch { return null; }
}

export function modeFor(pr, kind, channel) {
  const m = pr.cfg.drafts.modes || {};
  return m[`${kind}:${channel}`] || m[kind] || m[channel] || 'draft';
}

/** Create one draft (as a draft.create event). Returns the draft id, or null with a reason. */
/** The checks every draft passes before anything is written: private project, source, channel, declined, duplicate. */
function gate(pr, id, { channel, format, force, replace }) {
  if (pr.cfg.private) return { error: 'this project is marked private in cts.json: drafting is disabled' };
  const src = resolveSource(pr, id);
  if (!src) return { error: `no moment or arc matches "${id}"` };
  if (String(src.id).endsWith(':unfinished')) src.unfinished = true;
  const chs = pr.cfg.publishing.channels || {};
  if (!chs[channel]) return { error: `unknown channel "${channel}" (configured: ${Object.keys(chs).join(', ')})` };
  format = format || formatFor(src, channel);
  const store = pr.engine.drafts;
  // replace: a draft id to rewrite, or true for the open draft of this source, channel and format.
  const old = replace === true ? [...store.drafts.values()].find((x) => x.source.id === src.id && x.channel === channel && x.format === format && ['pending', 'approved'].includes(x.status)) : replace && store.get(replace);
  if (replace && (!old || !['pending', 'approved'].includes(old.status))) return { error: 'only a pending or approved draft can be rewritten' };
  if (!force && store.skipped.has(`${src.id}|${channel}|${format}`)) return { error: `the storyteller passed on this one: ${store.skipped.get(`${src.id}|${channel}|${format}`)}` };
  if (!force && store.declined.has(src.id)) return { error: 'you declined a draft of this earlier; pass --force to draft it again' };
  if (store.existsFor(src.id, channel, format, old && old.id)) return { error: 'a draft for this already exists' };
  return { src, format, old };
}

// The intro and signature from settings (drafts.intro / drafts.outro), with {tags} filled from the log and the repo.
// Dev-log lines get neither. Their numbers are added to the draft's traceable numbers: they come from CTS, not the story.
const SEP = '\n\n';
function decoration(pr, src, format, { angle = '', kind } = {}) {
  const D = pr.cfg.drafts;
  if (format === 'devlog' || (!D.intro && !D.outro)) return null;
  const top = src.type === 'arc' ? src.ms.slice().sort((a, b) => b.score - a.score)[0] : src.m;
  const vals = tagValues(pr, { sid: top.sid, angle, kind: kind || top.kind });
  const intro = fillTags(D.intro, vals).trim(), outro = fillTags(D.outro, vals).trim();
  return { intro, outro, nums: [...`${intro} ${outro}`.matchAll(/\d+(?:\.\d+)?/g)].flatMap((m) => [m[0], ...m[0].split('.')]) };
}
/** Characters a story must leave free for the intro and signature (the angle is not known yet: the longest one is assumed). */
const reserveFor = (pr, src, format) => {
  const d = decoration(pr, src, format, { angle: 'discovery' });
  if (!d) return 0;
  const n = (s) => (s ? s.length + SEP.length : 0);
  return format === 'thread' ? Math.max(n(d.intro), n(d.outro)) : format === 'long' ? 0 : n(d.intro) + n(d.outro);
};
function decorate(text, format, d) {
  if (!d) return text;
  if (format === 'thread') {
    const ps = postsOf(text);
    if (d.intro) ps[0] = ps[0].replace(/^(\d+\/\d+ )?/, (m) => m + d.intro + SEP);
    if (d.outro) ps[ps.length - 1] += SEP + d.outro;
    return ps.join(POST_SEP);
  }
  if (format === 'long') { const fm = (/^---\n[\s\S]*?\n---\n/.exec(text) || [''])[0]; return fm + [d.intro, text.slice(fm.length).trim(), d.outro].filter(Boolean).join(SEP) + '\n'; }
  return [d.intro, text, d.outro].filter(Boolean).join(SEP);
}

/** Create one draft (as a draft.create event). `story` is a storyteller text that already passed storyProblems. */
export function createDraft(pr, id, { channel = 'x', format, origin = 'manual', force = false, mode, story, replace, extraNums = [] } = {}) {
  const g = gate(pr, id, { channel, format, force, replace });
  if (g.error) return g;
  const { src } = g; format = g.format;
  const c = compose(pr, src, channel, format);
  if (!c) return { error: 'nothing to say about this one' };
  const opts = redactOpts(pr);
  const deco = decoration(pr, src, format, { angle: story && story.angle });
  const st = story && { ...story, text: redact(decorate(story.text, format, deco), opts).text, title: redact(story.title, opts).text };
  if (!st && deco) c.text = decorate(c.text, format, deco);
  const last = redact(st ? st.text : c.text, opts);
  const red = { report: [...(st ? [] : c.report), ...last.report] };
  const draft = ulid();
  const top = src.type === 'arc' ? src.ms.slice().sort((a, b) => b.score - a.score)[0] : src.m;
  const card = ['short', 'linkedin', 'thread', 'long'].includes(format) ? cardFor(pr, top, channel, draft, st) : null;
  const sid = top.sid;
  writeHumanEvent(pr.root, 'draft.create', {
    draft, source: { type: src.type, id: src.id, moments: src.ms.map((m) => m.id) }, channel, format, text: st ? st.text : c.text, title: st ? st.title : c.title,
    claims: { refs: st ? st.refs : c.refs, extra: [...new Set([...c.extra, ...extraNums, ...(deco ? deco.nums : [])])] }, redaction: { count: red.report.length, summary: Object.entries(red.report.reduce((a, r) => (a[r.rule] = (a[r.rule] || 0) + 1, a), {})).map(([rule, n]) => ({ rule, n })), items: red.report.slice(0, 20) },
    card, origin, score: top.score, kind: top.kind, voice_rev: c.voiceRev, mode: mode || modeFor(pr, top.kind, channel), writer: st ? st.writer : 'template',
    tone: st ? st.tone : null, quotes: st ? !!st.quotes : false, angle: st ? st.angle || null : null, replaces: g.old ? g.old.id : null,
  }, { sid, actor: 'cts' });
  pr.sync();
  return { id: draft };
}

// The storyteller: the same draft told by a model as a story, through the user's Claude Code login or API key. It only
// sees redacted, consent-filtered material, and its text is kept only if storyProblems finds nothing; else the template stays.
export const TONES = {
  wry: `VOICE: dry, deadpan, slightly sarcastic developer humor, the fast tech-news-roundup kind. Understatement, a sharp aside,
a joke at my own expense, at the agent's or at the hype, never at other people. One or two good lines, not a stand-up set.
Like: "I keep changing little things, a few lines at a time. Funny how little things take more time with AI, while massive jobs seem to just happen."`,
  dramatic: `VOICE: dramatic and punchy. Open on the moment it went sideways, not on the setup. Short sentences, real tension: what I
expected, what happened, the beat where I lost patience or pushed back. The agent and I are two characters. End on a turn.`,
  straight: 'VOICE: sincere and direct, no jokes. Still one angle with a point, never a log.',
};
const TONE_ALIAS = { story: 'wry', plain: 'straight' };
export const toneOf = (t) => (TONES[t] ? t : TONES[TONE_ALIAS[t]] ? TONE_ALIAS[t] : 'wry');
export const ANGLES = ['fuckup', 'lesson', 'grind', 'discovery', 'surprise', 'irony', 'decision', 'argument'];
const NO_QUOTES = '- Never quote. No quotation marks, no prompts or messages repeated word for word, no commands, code, flags, file names, paths, branch names, test names or error messages. Say in plain words what they were.';
export const QUOTE_MAX = 15;
const MY_QUOTES = `- Quotes: you may quote MY OWN words, only from events with type prompt and who human, at most 2 times, each at most ${QUOTE_MAX} words, copied exactly between “ and ”. Pick the line with the most feeling. Never quote an agent, and no commands, code, flags, file names, paths, branch names, test names or error messages. Everything else in plain words, never repeated word for word.`;
const LENGTH = { short: 'One post. Usually 1 to 4 sentences; it does not have to fill max_characters.', thread: 'A thread of 2 to 5 posts separated by a line with only --- on it, each one worth reading alone.', linkedin: 'About 500 to 1300 characters in short paragraphs. A first line that makes people click "more".', long: 'An article of 300 to 700 words in Markdown paragraphs (## headings allowed, no front matter) with a real arc.' };
/** The storyteller's instructions: find the angle first, then write it in a voice, with or without my own words as quotes. */
export const storyRules = ({ tone = 'wry', quotes = false, format = 'short' } = {}) => `You are the CTS storyteller. You write one post as me, first person, about what happened in my coding sessions with AI agents.
The material is the log: my prompts, what the agents said and did, and facts per moment. It is what you tell the story from, not what you show.

STEP 1, THE ANGLE. Do not narrate what happened. Find the one thing worth saying about it, the thing a developer would stop scrolling for.
Look past the actions: ${ANGLES.join(', ')} (mine or the agent's). A fuckup someone made. A lesson I actually got. The grind: a slightly bored
keep-going update. Something I found out. A surprise. An irony, like tiny changes eating the afternoon while the big job just happened. A
decision and what it cost. An argument with the agent. Pick ONE angle and leave everything else out; a long arc still gets one angle.
If nothing here would be worth reading, do not write filler: set worth_it to false and say why in one line.

STEP 2, THE POST. ${TONES[toneOf(tone)]}
${LENGTH[format] || LENGTH.short}

HARD RULES (a validator rejects violations):
${quotes ? MY_QUOTES : NO_QUOTES}
- Never report line counts, file counts, test counts, diff stats or version numbers. Nobody cares. No changelog lists, no hashtags.
- Facts (what happened, numbers, causes, who did what) must come from the material. Your take on them (the joke, the observation, the
  lesson, the "funny how") is yours to write, as long as it is about what the material shows and never claims something happened that did not.
- Every number you write must appear in the material. One number at most per post.
- Never name a person, a company or the project. Masked text such as [repo], [path] or [masked] stays out entirely; never guess what it was.
- Stay within max_characters for each post.
- Write as me: the agents are my tools, so what my session did is what I did, unless the agent's part is the point.
- No stock phrases ("back to the drawing board", "what a day", "game-changer", "here's the thing", "lessons learned", "journey"), no
  rhetorical question-and-answer setups, and never write about the material itself or how little it says.
Follow the voice profile when it has one: its samples are how I really write.
Reply with ONLY a JSON object: {"worth_it":true,"angle":"<one of ${ANGLES.join('|')}>","title":"<a short title, no quotes>","text":"<the post>"}
or {"worth_it":false,"why":"<one line>"}`;
export const STORY_RULES = storyRules();

const ctxEvent = (pr, e) => {
  const c = consentEvent(pr, e), d = c.d || {};
  if (c.kind === 'prompt') return { type: 'prompt', who: c.actor, text: trunc(d.text, 600) };
  if (c.kind === 'turn.end' || c.kind === 'subagent.stop') return { type: 'agent said', who: c.actor, text: trunc(d.last, 600) };
  const o = { type: 'action', who: c.actor, text: trunc(summarize(c), 200) };
  if (c.kind === 'tool.fail' || (d.test && d.test.red)) { const r = errLine(d.out); if (r) o.result = r; }
  return o;
};
const HOUR = 3600000;
// What a moment was, for the storyteller: its kind in words and its dashboard headline (consented), never a template sentence.
const KIND_WORDS = { fight: 'a failure I kept hitting before it passed', broke: 'a change broke something that worked', reversal: 'I pulled the work back to an earlier direction', refusal: 'I said no to a step', disagreement: 'one actor pushed back on another', shipped: 'work landed on the main branch', pivot: 'I switched approach', 'memory-cut': 'the agent lost context and re-read files', escalation: 'I switched models to get unstuck', misread: 'the agent misunderstood me', frustration: 'I was losing patience', recurring: 'a problem came back from an earlier session', detour: 'a failure sent the work into an unrelated part of the code', wait: 'the agent sat waiting for me', mark: 'I flagged this moment myself', learned: 'something was learned' };
const whatOf = (pr, m) => { const c = consentMoment(pr, m); return `${KIND_WORDS[m.kind] || m.kind}: ${firstPerson(c.headline)}${c.note ? ` (my note: ${c.note})` : ''}`; };
/** Numbers a story may lean on: time and effort since the moment before, attempts, waits. All go into the guard's traceable numbers. */
function factsOf(pr, m, prev) {
  const E = m.evidence || {}, f = {};
  const from = prev ? prev.t1 : m.t0 - 3 * HOUR;
  const evs = pr.events({ sid: m.sid, from, to: m.t1, limit: 2000, order: 'asc' });
  if (prev) f.minutes_since_previous_moment = Math.max(1, Math.round((m.t0 - prev.t1) / MIN));
  const prompts = evs.filter((e) => e.kind === 'prompt' && e.actor === 'human').length; if (prompts) f.my_prompts_since = prompts;
  const edits = evs.filter((e) => e.kind === 'tool.pre' && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test((e.d && e.d.tool) || '')).length; if (edits) f.file_edits_since = edits;
  const fails = evs.filter((e) => e.kind === 'tool.fail' || (e.d && e.d.test && e.d.test.red)).length; if (fails) f.failed_runs_since = fails;
  if (E.attempts) f.attempts = E.attempts;
  if (E.minutes) f.minutes = E.minutes;
  if (E.elapsed_ms) f.minutes_elapsed = Math.max(1, Math.round(E.elapsed_ms / MIN));
  return f;
}

/** The packet a storyteller reads: per moment, the prompts before it, its own events and what the agents said right after. */
export function storyPacket(pr, src, c, channel, format, { tone = 'wry', quotes = false } = {}) {
  const voice = loadVoice(pr.root), v = voice.for(channel);
  const limit = Math.min(v.max || Infinity, ((pr.cfg.publishing.channels || {})[channel] || {}).limit || Infinity) - reserveFor(pr, src, format);
  const seen = new Set();
  const once = (e) => e && !seen.has(e.id) && seen.add(e.id);
  let prev = null;
  const moments = c.ms.slice(0, 12).map((m) => {
    const ids = m.span.ids.length > 12 ? [...m.span.ids.slice(0, 6), ...m.span.ids.slice(-6)] : m.span.ids;
    // What led up to it: the session's last prompts and agent reports in the 3 hours before. A moment from `cts import git`
    // has no session of its own, so it reads every session in that window.
    const S = pr.engine.sessions.get(m.sid), sid = S && S.events > 5 ? m.sid : undefined;
    const lead = (kinds, limit) => pr.events({ sid, kinds, actors: ['human', 'main'], from: m.t0 - 3 * HOUR, to: m.t0 - 1, limit });
    const evs = [
      ...lead(['prompt'], 3), ...lead(['turn.end'], 2).filter((e) => e.d.last && e.d.last.length > 200),
      ...ids.map((x) => pr.eventById(x)),
      ...pr.events({ sid: m.sid, kinds: ['turn.end', 'subagent.stop'], from: m.t0, to: m.t1 + 10 * MIN, limit: 3, order: 'asc' }),
    ].filter(once);
    const f = factsOf(pr, m, prev); prev = m;
    return { kind: m.kind, when: new Date(m.t0).toISOString().slice(0, 16), what: whatOf(pr, m), facts: f, events: evs.map((e) => ctxEvent(pr, e)) };
  });
  const material = redactDeep(moments, redactOpts(pr)).value;
  const user = JSON.stringify({
    channel, format: format === 'long' ? 'article' : format, max_characters: Number.isFinite(limit) ? limit : null, tone, may_quote_my_words: quotes,
    voice_profile: trunc(voice.text, 3000) || null, moments: material,
  });
  const extra = moments.flatMap((m) => Object.values(m.facts));
  const verbatim = material.flatMap((m) => m.events.filter((e) => e.type !== 'agent said').flatMap((e) => [e.text, e.result || '']));
  const quotable = quotes ? material.flatMap((m) => m.events.filter((e) => e.type === 'prompt' && e.who === 'human').map((e) => e.text)) : null;
  return { system: storyRules({ tone, quotes, format }), user, refs: [...new Set([...c.refs, ...seen])].slice(0, 300), verbatim, quotable, limit, extra };
}

const words = (s) => String(s).toLowerCase().match(/[a-z0-9']+/g) || [];
/** Why a storyteller text cannot be used, as a list (empty = usable). */
const qnorm = (s) => String(s).toLowerCase().replace(/[‘’]/g, "'").replace(/[^\p{L}\p{N}']+/gu, ' ').trim();
const PATHY = /(?:^|\s)--?[a-z][\w-]*|\b[\w-]+\.(?:[mc]js|jsx|tsx?|py|json|md|ya?ml|sh|toml|css|html|lock)\b|\b(?!(?:node|next|vue|nuxt|deno|three)\.js\b)[\w-]+\.js\b|\b[\w.-]+\/[\w.-]+\/[\w.-]+/i;
export function storyProblems(pr, text, { refs = [], extra = [], verbatim = [], quotable = null, limit = Infinity, format = 'short' } = {}) {
  let t = String(text || '').trim().replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  if (t.length < 20) return ['the story is empty'];
  const p = [];
  if (quotable) {
    // My own words may be quoted: short, exact, from my prompts. Each quote is checked, then left out of the other checks.
    const own = quotable.map(qnorm), qs = [...t.matchAll(/“([^”]*)”/g)].map((m) => m[1]);
    if (qs.length > 2 * Math.max(1, postsOf(t).length)) p.push('too many quotes; at most 2 per post');
    for (const q of qs) {
      if (q.split(/\s+/).filter(Boolean).length > QUOTE_MAX) p.push(`a quote is longer than ${QUOTE_MAX} words: ${trunc(q, 40)}`);
      else if (PATHY.test(q) || /[`{}<>$]/.test(q)) p.push(`a quote shows a command, a file or code: ${trunc(q, 40)}`);
      else if (!qnorm(q) || !own.some((o) => (' ' + o + ' ').includes(' ' + qnorm(q) + ' '))) p.push(`a quote is not my own exact words from a prompt: ${trunc(q, 40)}`);
    }
    t = t.replace(/“[^”]*”/g, ' … ');
  }
  const plain = (format === 'thread' ? postsOf(t) : [t]).map((x) => x.replace(/^\d+\/\d+\s/, '')).join('\n');
  if (/[“”"`]/.test(t)) p.push(quotable ? 'it shows code or uses straight quotes; quote only my own words, between “ and ”' : 'it quotes or shows code; tell it in plain words');
  if (/\[(?:repo|path|masked|redacted|url|internal-url|email|host|ip)\]|\[prompt withheld/.test(t)) p.push('it uses a masked placeholder');
  if (/\b\d+\s+(?:lines?|files?|tests?)\b|[+−-]\d+\/[−-]\d+|\bv?\d+\.\d+\.\d+\b/i.test(plain)) p.push('it reports line, file or test counts, diff stats or version numbers; nobody cares, tell the story');
  if (/(?:^|\s)#[a-z]\w+/i.test(plain)) p.push('no hashtags');
  if (PATHY.test(plain)) p.push('it names a command flag, a file or a path');
  if (Number.isFinite(limit) && (format === 'thread' ? postsOf(t) : [t]).some((x) => x.length > limit)) p.push(`a post is longer than ${limit} characters`);
  const grams = new Set();
  for (const s of verbatim) { const w = words(s); for (let i = 0; i + 6 <= w.length; i++) grams.add(w.slice(i, i + 6).join(' ')); }
  const w = words(plain);
  for (let i = 0; i + 6 <= w.length; i++) if (grams.has(w.slice(i, i + 6).join(' '))) { p.push(`it repeats a prompt or a command word for word (${w.slice(i, i + 6).join(' ')}…); say it in your own words${quotable ? ' or quote it' : ''}`); break; }
  const pm = claimProblems(plain, refs.map((id) => pr.eventById(id)).filter(Boolean), { extra, voiceText: loadVoice(pr.root).text });
  if (pm) p.push(pm);
  return p;
}

/** Put the storyteller's answer in the draft's shape: thread numbering, article front matter. */
// A story over the limit loses whole sentences from the end, never words from the middle.
const fitSentences = (t, limit) => {
  if (!Number.isFinite(limit) || t.length <= limit) return t;
  let o = '';
  // A sentence ends at . ! or ? before a space or the end, so 0.2.10 or 3.5 stay whole.
  for (const s of (t.match(/[\s\S]*?(?:[.!?]+(?=\s|$)|$)\s*/g) || []).filter(Boolean)) { if ((o + s).trim().length > limit) break; o += s; }
  return o.trim() || t;
};
function shapeStory(a, c, format, limit, quotes) {
  let text = String(a.text || '').trim();
  if (quotes) text = text.replace(/"([^"\n]{1,200})"/g, '“$1”');
  if (format === 'short' || format === 'linkedin') text = fitSentences(text, limit);
  const title = String(a.title || '').replace(/["“”]/g, '').trim().slice(0, 100) || c.title;
  if (format === 'thread') { const ps = postsOf(text).map((x) => x.replace(/^\d+\/\d+\s+/, '')); text = ps.map((x, i) => `${i + 1}/${ps.length} ` + fitSentences(x, limit - `${i + 1}/${ps.length} `.length)).join(POST_SEP); }
  if (format === 'long') { const fm = (/^---\n[\s\S]*?\n---\n/.exec(c.text) || [''])[0].replace(/^title: .*$/m, `title: "${title}"`); text = fm + '\n' + text.replace(/^---\n[\s\S]*?\n---\n/, '') + '\n'; }
  return { text, title };
}

/**
 * Draft through the storyteller: it picks an angle and writes it, or passes (worth_it false). One repair round if the
 * validator objects; if the story still fails (or the model call does) there is no draft and `error` says why.
 * `ask(system, user)` returns the reply text.
 */
export async function writeStory(pr, id, { channel = 'x', format, via = 'claude', model, ask, force = false, origin = 'manual', mode, replace, tone, quotes } = {}) {
  const g = gate(pr, id, { channel, format, force, replace });
  if (g.error) return g;
  format = g.format;
  tone = toneOf(tone || pr.cfg.drafts.tone);
  quotes = quotes ?? !!pr.cfg.drafts.quotes;
  const c = compose(pr, g.src, channel, format);
  if (!c) return { error: 'nothing to say about this one' };
  const pk = storyPacket(pr, g.src, c, channel, format, { tone, quotes });
  model = model || pr.cfg.drafts.model || 'claude-sonnet-5-5';
  ask = ask || (via === 'api' ? (s, u) => askApi(s, u, { model }) : (s, u) => askClaude(s, u, { model }));
  const opts = redactOpts(pr);
  const check = (a) => {
    if (a && a.worth_it === false) return { skip: String(a.why || 'nothing worth a post here').slice(0, 200) };
    const s = shapeStory(a, c, format, pk.limit, quotes);
    return { s, angle: ANGLES.includes(a && a.angle) ? a.angle : null, probs: storyProblems(pr, redact(s.text, opts).text, { ...pk, extra: [...c.extra, ...pk.extra], format }) };
  };
  let why, skip = false;
  try {
    let r = check(parseAnswer(await ask(pk.system, pk.user)));
    if (!r.skip && r.probs.length) r = check(parseAnswer(await ask(pk.system, `${pk.user}\n\nThe validator rejected your story:\n${r.probs.map((x) => '- ' + x).join('\n')}\nWrite it again and follow every rule. Reply with the JSON object only.`)));
    if (r.skip) { why = r.skip; skip = true; }
    else if (!r.probs.length) return { ...createDraft(pr, id, { channel, format, force, origin, mode, replace: g.old && g.old.id, extraNums: pk.extra, story: { ...r.s, refs: pk.refs, writer: via, tone, quotes, angle: r.angle } }), writer: via, angle: r.angle };
    else why = r.probs.join('; ');
  } catch (e) { why = String((e && e.message) || e); }
  // No log-line filler in place of a story. Autopilot remembers the outcome so it does not ask again on every tick.
  if (origin === 'autopilot') { writeHumanEvent(pr.root, 'draft.skip', { source: g.src.id, channel, format, why, worth_it: !skip }, { sid: (g.src.m || g.src.ms[0]).sid, actor: 'cts' }); pr.sync(); }
  return skip ? { skipped: true, why, error: `nothing worth a post here: ${why}` } : { error: `the story did not pass the checks: ${why}` };
}

/** Plain templates write dev-log lines only; a social post or article needs the storyteller. */
export const templateFormat = (f) => f === 'devlog';
export function draftPlain(pr, id, o = {}) {
  const src = resolveSource(pr, id);
  const f = o.format || (src && formatFor(src, o.channel || 'x'));
  if (src && !templateFormat(f)) return { error: 'plain templates only write dev-log lines; a post needs the storyteller (writer claude or api)' };
  return createDraft(pr, id, o);
}

const effMin = (pr, kind) => {
  const base = pr.cfg.drafts.min;
  let n = 0;
  for (const x of pr.engine.drafts.drafts.values()) if (x.status === 'declined' && x.kind === kind) n++;
  return base + Math.min(20, 5 * n);   // each decline of a kind raises its autopilot bar by 5 points (max +20)
};

/** Autopilot: draft what the user's rules say to draft. Runs in the server tick or `cts draft auto`; never in a hook. */
/** What the autopilot rules want drafted: [{ id, channel }]. Already-drafted and declined sources are filtered by the gate. */
export function autoWanted(pr, now = Date.now()) {
  const out = [];
  if (pr.cfg.private) return out;
  const e = pr.engine, D = pr.cfg.drafts;
  const fresh = (t) => now - t <= D.expireDays * DAY;
  for (const m of e.listMoments()) {
    if (m.demo || m.status === 'dismissed' || m.status === 'merged' || m.status === 'dropped' || !fresh(m.t1)) continue;
    const wanted = m.status === 'confirmed' || m.kind === 'mark' || (D.kinds.includes(m.kind) && m.score >= effMin(pr, m.kind));
    if (wanted) for (const ch of D.channels) out.push({ id: m.id, channel: ch });
  }
  for (const a of e.arcs()) {
    if (a.demo || !fresh(a.t1)) continue;
    if (a.status === 'closed' && a.moments.length > 1 && a.score >= effMin(pr, e.moments.get(a.outcome).kind)) for (const ch of D.arcChannels) out.push({ id: 'arc:' + a.id, channel: ch });
    else if (a.status === 'unfinished' && a.score >= D.min) for (const ch of D.channels) out.push({ id: 'arc:' + a.id, channel: ch });
  }
  return out;
}
export function autoDrafts(pr, now = Date.now()) {
  const made = [];
  for (const w of autoWanted(pr, now)) { const src = resolveSource(pr, w.id); if (!src || !templateFormat(formatFor(src, w.channel))) continue; const r = createDraft(pr, w.id, { channel: w.channel, origin: 'autopilot' }); if (r.id) made.push(r.id); }
  for (const id of made) maybeAutoApprove(pr, id);
  return made;
}
/** Autopilot with "drafts.writer": "claude" | "api": one storyteller call at a time, the template when it fails. */
export async function autoStories(pr, { via = pr.cfg.drafts.writer, ask, now = Date.now() } = {}) {
  const made = [];
  for (const w of autoWanted(pr, now)) {
    if (gate(pr, w.id, { channel: w.channel }).error) continue;
    const r = await writeStory(pr, w.id, { channel: w.channel, via, ask, origin: 'autopilot' });
    if (r.id) { made.push(r.id); maybeAutoApprove(pr, r.id); }
  }
  return made;
}

/** mode:auto drafts are approved by rule, but only if the guard and the redaction report are both clean. */
export function maybeAutoApprove(pr, id) {
  const x = pr.engine.drafts.get(id);
  if (!x || x.status !== 'pending' || x.mode !== 'auto') return false;
  const chk = checkDraft(pr, x);
  const D = pr.cfg.drafts;
  if (!chk.ok || !chk.redactionClean || x.score < effMin(pr, x.kind)) return false;
  approve(pr, id, { via: 'autopilot', rule: `${x.kind}:${x.channel}` });
  return true;
}

export function approve(pr, id, { at, via = 'human', rule, to } = {}) {
  const x = pr.engine.drafts.get(id);
  if (!x) return { error: 'no such draft' };
  if (!['pending', 'approved'].includes(x.status)) return { error: `draft is ${x.status}` };
  if (pr.engine.drafts.statusOf(x) === 'expired') return { error: 'draft expired; ask for a fresh one with cts draft --force' };
  writeHumanEvent(pr.root, 'draft.approve', { draft: x.id, via, rule: rule || null, at: at || null, text_hash: textHash(x.text), ...(to ? { to } : {}) }, { sid: x.sid, actor: via === 'autopilot' ? 'autopilot' : 'human' });
  pr.sync();
  return { id: x.id };
}
/** Throw a draft away without teaching autopilot anything (unlike decline): for clearing out drafts nobody wants. */
export function discard(pr, id, reason = '') {
  const x = pr.engine.drafts.get(id);
  if (!x) return { error: 'no such draft' };
  if (!['pending', 'approved'].includes(x.status)) return { error: `draft is ${x.status}` };
  writeHumanEvent(pr.root, 'draft.discard', { draft: x.id, reason: trunc(reason, 300) }, { sid: x.sid, actor: 'human' });
  pr.sync();
  return { id: x.id };
}
export function restore(pr, id) {
  const x = pr.engine.drafts.get(id);
  if (!x) return { error: 'no such draft' };
  if (x.status !== 'discarded') return { error: `draft is ${x.status}` };
  writeHumanEvent(pr.root, 'draft.restore', { draft: x.id }, { sid: x.sid, actor: 'human' });
  pr.sync();
  return { id: x.id };
}
export function decline(pr, id, reason = '') {
  const x = pr.engine.drafts.get(id);
  if (!x) return { error: 'no such draft' };
  writeHumanEvent(pr.root, 'draft.decline', { draft: x.id, reason: trunc(reason, 300) }, { sid: x.sid, actor: 'human' });
  pr.sync();
  return { id: x.id };
}
export function edit(pr, id, text) {
  const x = pr.engine.drafts.get(id);
  if (!x) return { error: 'no such draft' };
  if (['published', 'declined', 'replaced', 'discarded'].includes(x.status)) return { error: `draft is ${x.status}` };
  if (typeof text !== 'string' || !text.trim()) return { error: 'empty text' };
  const oldLen = x.text.length;
  const red = redact(text, redactOpts(pr));
  const words = (s) => new Set((String(s).toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []));
  const had = words(x.text), now = words(red.text);
  const removed = [...had].filter((w) => !now.has(w)).slice(0, 20);
  writeHumanEvent(pr.root, 'draft.edit', {
    draft: x.id, text: red.text, removed,
    redaction: { count: red.report.length, summary: Object.entries(red.report.reduce((a, r) => (a[r.rule] = (a[r.rule] || 0) + 1, a), {})).map(([rule, n]) => ({ rule, n })), items: red.report.slice(0, 20) },
  }, { sid: x.sid, actor: 'human' });
  pr.sync();
  const sug = suggestFromEdit(pr, x.id, oldLen);
  return { id: x.id, text: red.text, suggestions: sug };
}

/** Offer a voice change, exactly once per distinct (key, value), never for something already in the profile or rejected. */
export function suggestFromEdit(pr, id, oldLen) {
  const x = pr.engine.drafts.get(id); const store = pr.engine.drafts;
  const voice = loadVoice(pr.root);
  const out = [];
  const offer = (key, value, why) => {
    const sid = suggestionId(key, value);
    if (store.suggestions.has(sid)) return;
    writeHumanEvent(pr.root, 'voice.suggest', { id: sid, key, value: String(value), why, draft: x.id }, { sid: x.sid, actor: 'cts' });
    out.push({ id: sid, key, value: String(value), why });
  };
  if (x.text.length <= oldLen * 0.8 && postsOf(x.text).length === 1) {
    const v = Math.max(40, Math.ceil(x.text.length / 10) * 10);
    const cur = voice.for(x.channel).max;
    if (!cur || v < cur) offer(`${x.channel}.max`, v, `you shortened this ${x.channel} draft from ${oldLen} to ${x.text.length} characters`);
  }
  for (const [w, ids] of store.removals) if (ids.size >= 2 && !voice.never.includes(w)) offer('never', w, `you deleted "${w}" from ${ids.size} different drafts`);
  if (out.length) pr.sync();
  return out;
}

export function counts(pr) {
  const l = pr.engine.drafts.list();
  const by = {};
  for (const x of l) by[x.status] = (by[x.status] || 0) + 1;
  return by;
}
export const nextSlot = (cad = { days: [1, 2, 3, 4, 5], time: '09:00' }, now = Date.now()) => {
  const [hh, mm] = String(cad.time || '09:00').split(':').map(Number);
  for (let i = 0; i < 9; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i); d.setHours(hh, mm || 0, 0, 0);
    if (d.getTime() > now && (cad.days || [1, 2, 3, 4, 5]).includes(d.getDay())) return d.getTime();
  }
  return now + DAY;
};
