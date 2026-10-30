// Tags for the post intro and signature (drafts.intro / drafts.outro): {name} is replaced with a number or word from the
// log or the repo when the draft is made. Read-only: git and the index, never a model, never the network.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DAY = 86400000, MIN = 60000;
const git = (root, args) => { try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20, windowsHide: true }).trim(); } catch { return ''; } };
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

/** Lines and files tracked in git (text files only, at most 20000 files and 2 MB each). Cached per HEAD for a minute. */
const repoCache = new Map();
export function repoStats(root) {
  const head = git(root, ['rev-parse', 'HEAD']);
  const hit = repoCache.get(root);
  if (hit && hit.head === head && Date.now() - hit.at < MIN) return hit.v;
  let lines = 0, files = 0;
  for (const f of git(root, ['ls-files', '-z']).split('\0').filter(Boolean).slice(0, 20000)) {
    try {
      const p = path.join(root, f), st = fs.statSync(p);
      if (!st.isFile() || st.size > 2 << 20) continue;
      const b = fs.readFileSync(p);
      if (b.includes(0)) continue;                          // binary
      files++; for (const c of b) if (c === 10) lines++;
      if (b.length && b[b.length - 1] !== 10) lines++;
    } catch { /* deleted or unreadable: skip */ }
  }
  const commits = +git(root, ['rev-list', '--count', 'HEAD']) || 0;
  const first = +git(root, ['log', '--reverse', '--format=%ct', '--max-count=1']) || 0;
  const tag = git(root, ['describe', '--tags', '--abbrev=0']);
  let version = tag.replace(/^v(?=\d)/, '');
  if (!version) { try { version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || ''; } catch { /* none */ } }
  const v = { lines, files, commits, version, ageDays: first ? Math.max(1, Math.ceil((Date.now() - first * 1000) / DAY)) : 0 };
  repoCache.set(root, { head, at: Date.now(), v });
  return v;
}

/** Every tag with its help text, in the order the Settings page lists them. */
export const TAGS = [
  ['project_lines', 'lines of text in files tracked by git'], ['project_files', 'files tracked by git'], ['project_commits', 'commits on this branch'],
  ['project_days', 'days since the first commit'], ['version', 'latest git tag, else package.json version'],
  ['session_minutes', 'minutes this session has run'], ['session_hours', 'hours this session has run (one decimal)'], ['session_prompts', 'my prompts this session'],
  ['session_tool_calls', 'tool calls this session'], ['session_edits', 'file edits this session'], ['session_red_runs', 'failed runs this session'],
  ['session_commits', 'commits this session'], ['session_lines', 'lines added and removed in this session\'s commits'], ['session_agents', 'subagents started this session'],
  ['session_moments', 'moments detected this session'], ['model', 'the model the session ran on'],
  ['total_sessions', 'sessions CTS has recorded here'], ['total_moments', 'moments detected here'], ['total_prompts', 'my prompts here, all sessions'],
  ['streak_days', 'days in a row with a session, up to the latest'], ['date', 'today, YYYY-MM-DD'], ['weekday', 'today\'s weekday'],
  ['angle', 'the story\'s angle (fuckup, lesson, grind…)'], ['kind', 'the moment kind the post is about'],
];

/** Values for one draft: `sid` is the session the post is about (the top moment's). */
export function tagValues(pr, { sid, angle, kind } = {}) {
  const e = pr.engine, v = {};
  const r = repoStats(pr.root);
  Object.assign(v, { project_lines: r.lines, project_files: r.files, project_commits: r.commits, project_days: r.ageDays, version: r.version });
  const S = sid && e.sessions.get(sid);
  const evs = sid ? pr.events({ sid, limit: 200000, order: 'asc' }) : [];
  if (evs.length) {
    const t0 = evs[0].t, t1 = evs[evs.length - 1].t;
    const commits = evs.filter((x) => x.d && x.d.git && x.d.git.op === 'commit' && x.d.git.stat);
    Object.assign(v, {
      session_minutes: Math.max(1, Math.round((t1 - t0) / MIN)), session_hours: Math.round((t1 - t0) / 360000) / 10,
      session_prompts: evs.filter((x) => x.kind === 'prompt' && x.actor === 'human').length,
      session_tool_calls: evs.filter((x) => x.kind === 'tool.pre').length,
      session_edits: evs.filter((x) => x.kind === 'tool.pre' && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test((x.d && x.d.tool) || '')).length,
      session_red_runs: evs.filter((x) => x.kind === 'tool.fail' || (x.d && x.d.test && x.d.test.red)).length,
      session_commits: commits.length, session_lines: commits.reduce((n, x) => n + x.d.git.stat.ins + x.d.git.stat.del, 0),
      session_agents: evs.filter((x) => x.kind === 'subagent.start').length,
      session_moments: e.listMoments().filter((m) => m.sid === sid).length,
      model: (evs.find((x) => x.kind === 'session.start' && x.d && x.d.model) || { d: {} }).d.model || (S && S.model) || '',
    });
  }
  const days = new Set(), all = [...e.sessions.values()];
  for (const s of all) if (!s.demo) for (const t of [s.start, s.end]) if (t) days.add(dayOf(t));
  let streak = 0;
  if (days.size) { let d = [...days].sort().pop(); while (days.has(d)) { streak++; d = dayOf(Date.parse(d) - DAY); } }
  const prompts = pr.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'prompt' AND actor = 'human'").get();
  Object.assign(v, {
    total_sessions: all.filter((s) => !s.demo).length, total_moments: e.listMoments().length, total_prompts: prompts ? prompts.n : 0, streak_days: streak,
    date: dayOf(Date.now()), weekday: new Date().toLocaleDateString('en-US', { weekday: 'long' }), angle: angle || '', kind: kind || '',
  });
  return v;
}

/** Replace {tag} with its value; unknown tags stay as written so a typo is visible in the preview. */
export const fillTags = (text, vals) => String(text || '').replace(/\{([a-z_]+)\}/g, (m, k) => (vals[k] === undefined || vals[k] === '' ? m : String(vals[k])));
