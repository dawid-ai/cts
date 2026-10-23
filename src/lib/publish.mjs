// Publishing: the trust boundary. publishDraft() (files) and postToVista() (the network, Post It) are the ONLY functions that
// act outside .cts/ on behalf of a draft; both pass the same gates() first. Adapters implement preview / validate / publish / status.
import fs from 'node:fs';
import path from 'node:path';
import { ulid, paths } from './util.mjs';
import { writeHumanEvent } from './log.mjs';
import { textHash, postsOf } from './drafts.mjs';
import { checkDraft, modeFor } from './narrative.mjs';
import * as VS from './vista.mjs';

const slug = (s) => String(s || 'post').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'post';
const stamp = (t) => new Date(t).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
function inside(root, rel) {
  const abs = path.resolve(root, rel);
  const r = path.relative(path.resolve(root), abs);
  if (r.startsWith('..') || path.isAbsolute(r)) throw new Error(`channel path "${rel}" escapes the project`);
  return abs;
}
function writeNew(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let f = file, n = 1;
  for (;;) {
    try { fs.writeFileSync(f, text, { flag: 'wx' }); return f; } catch (e) { if (e.code !== 'EEXIST') throw e; f = file.replace(/(\.\w+)?$/, `-${++n}$1`); }
  }
}

export const ADAPTERS = {
  /** Plain text files for the social channels: a human (or a scheduler) takes it from here. Receipts say "outbox", not "live". */
  outbox: {
    preview: (d, c) => ({ posts: postsOf(d.text).map((t) => ({ text: t, chars: t.length, limit: c.limit || null })) }),
    validate: (d, c) => postsOf(d.text).filter((t) => c.limit && t.length > c.limit).map((t) => `a post is ${t.length} characters; limit ${c.limit}`),
    publish: (pr, d, c, now) => {
      const f = writeNew(path.join(paths(pr.root).cts, 'outbox', d.channel, `${stamp(now)}-${d.id.slice(-8)}.txt`), d.text);
      return { kind: 'outbox', path: path.relative(pr.root, f).replace(/\\/g, '/') };
    },
    status: (r) => (fs.existsSync(r.path) ? 'queued in outbox' : 'missing'),
  },
  blog: {
    preview: (d) => ({ markdown: d.text }),
    validate: (d) => (/^---\n[\s\S]*?\n---/.test(d.text) ? [] : ['a blog post needs front matter']),
    publish: (pr, d, c, now) => {
      const f = writeNew(inside(pr.root, c.dir || 'content/posts') + path.sep + `${new Date(now).toISOString().slice(0, 10)}-${slug(d.title)}.md`, d.text);
      return { kind: 'file', path: path.relative(pr.root, f).replace(/\\/g, '/') };
    },
    status: (r) => (fs.existsSync(r.path) ? 'written' : 'missing'),
  },
  newsletter: null,
  changelog: {
    preview: (d) => ({ markdown: d.text }),
    validate: () => [],
    publish: (pr, d, c, now) => {
      const f = inside(pr.root, c.file || 'CHANGELOG.md');
      let cur = ''; try { cur = fs.readFileSync(f, 'utf8'); } catch { /* new file */ }
      const entry = d.text.replace(/\s+$/, '') + '\n';
      let next;
      const m = /^## .*unreleased.*$/im.exec(cur);
      if (m) { const i = m.index + m[0].length; next = cur.slice(0, i) + '\n\n' + entry + cur.slice(i).replace(/^\n+/, '\n'); }
      else if (/^# .*$/m.test(cur)) { const h = /^# .*$/m.exec(cur); const i = h.index + h[0].length; next = cur.slice(0, i) + '\n\n## Unreleased\n\n' + entry + cur.slice(i); }
      else next = '# Changelog\n\n## Unreleased\n\n' + entry + (cur ? '\n' + cur : '');
      const tmp = f + '.cts-tmp';
      fs.writeFileSync(tmp, next); fs.renameSync(tmp, f);
      return { kind: 'file', path: path.relative(pr.root, f).replace(/\\/g, '/'), lines: entry.split('\n').filter(Boolean).length };
    },
    status: (r) => (fs.existsSync(r.path) ? 'written' : 'missing'),
  },
};
ADAPTERS.newsletter = { ...ADAPTERS.blog, publish: (pr, d, c, now) => ADAPTERS.blog.publish(pr, d, { ...c, dir: c.dir || 'content/newsletter' }, now) };

export const isPaused = (pr) => pr.engine.drafts.pubPaused || !!pr.cfg.publishing.paused || fs.existsSync(paths(pr.root).pubPaused);

export function setKillSwitch(pr, on) {
  writeHumanEvent(pr.root, on ? 'publish.pause' : 'publish.resume', {}, { sid: undefined, actor: 'human' });
  pr.sync();
}

/** Every gate both publishers share, in order. Returns { x, chcfg, request_id } or { reason }. */
function gates(pr, id, now) {
  const store = pr.engine.drafts;
  const x = store.get(id);
  const no = (reason) => ({ ok: false, reason });
  if (!x) return no('no such draft');
  if (pr.cfg.private) return no('project is private');
  if (isPaused(pr)) return no('publishing is paused (kill switch)');
  if (x.status === 'published') return no('already published');
  if (x.status !== 'approved' || !x.approval) return no(`not approved (status: ${store.statusOf(x, now)})`);
  if (x.approval.text_hash !== textHash(x.text)) return no('the text changed after approval');
  const ap = x.approval;
  const approver = pr.eventById(ap.event);
  if (!approver || approver.kind !== 'draft.approve') return no('approval event not found in the log');
  if (ap.via === 'autopilot') {
    if (approver.actor !== 'autopilot') return no('autopilot approval has the wrong actor');
    if (modeFor(pr, x.kind, x.channel) !== 'auto') return no(`no auto-publish rule for ${x.kind}:${x.channel} in cts.json`);
    const chk = checkDraft(pr, x);
    if (!chk.ok) return no('honesty guard: ' + chk.problems[0]);
    if (!chk.redactionClean) return no('redaction report is not clean');
  } else if (ap.via === 'human') {
    if (approver.actor !== 'human') return no('human approval has the wrong actor');
  } else return no('unknown approval kind');
  if (ap.at && Date.parse(ap.at) > now) return no(`scheduled for ${ap.at}`);
  const chcfg = (pr.cfg.publishing.channels || {})[x.channel];
  if (!chcfg) return no(`channel "${x.channel}" is not configured`);
  const request_id = `${x.id}:${textHash(x.text).slice(0, 12)}`;
  if (x.receipts.some((r) => r.request_id === request_id)) return no('already published (idempotent request id)');
  const cap = chcfg.cap ?? 3;
  if (store.publishedToday(x.channel, now) >= cap) return no(`daily cap reached for ${x.channel} (${cap})`);
  return { x, chcfg, request_id };
}

/**
 * Publish to files. Returns { ok:true, receipt } or { ok:false, reason }. Nothing is written before all gates pass.
 */
export function publishDraft(pr, id, { now = Date.now() } = {}) {
  const no = (reason) => ({ ok: false, reason });
  const g = gates(pr, id, now);
  if (g.reason) return no(g.reason);
  const { x, chcfg, request_id } = g;
  if (x.approval.to === 'vista') return no('approved for Vista Social: use Post It');
  const ad = ADAPTERS[chcfg.adapter];
  if (!ad) return no(`no adapter "${chcfg.adapter}"`);
  const problems = ad.validate(x, chcfg);
  if (problems.length) return no(problems[0]);
  let receipt;
  try { receipt = ad.publish(pr, x, chcfg, now); } catch (e) {
    writeHumanEvent(pr.root, 'draft.fail', { draft: x.id, error: String(e.message || e).slice(0, 200) }, { sid: x.sid, actor: 'cts' });
    pr.sync(); return no('adapter failed: ' + e.message);
  }
  writeHumanEvent(pr.root, 'draft.publish', { draft: x.id, channel: x.channel, receipt, request_id }, { sid: x.sid, actor: 'cts' });
  pr.sync();
  return { ok: true, receipt, request_id };
}

/** Vista Social profile networks per CTS channel. */
export const VISTA_NETWORK = { x: 'twitter', bluesky: 'bluesky', threads: 'threads', linkedin: 'linkedin', mastodon: 'mastodon' };
const postIdOf = (text) => { try { const j = JSON.parse(text); const o = Array.isArray(j) ? j[0] : j; return String((o && (o.id || o.publication_id || o.post_id || (o.publication && o.publication.id))) || '') || null; } catch { const m = /"?(?:publication_id|post_id|id)"?\s*[:=]\s*"?([\w-]{6,})/.exec(text); return m ? m[1] : null; } };
/**
 * Post It: publish an approved draft now through Vista Social. Only a human approval made for Vista ({to:'vista'}) counts,
 * never autopilot. A thread goes out as one post with the rest as reply comments. `session` is for tests.
 */
export async function postToVista(pr, id, { now = Date.now(), session } = {}) {
  const no = (reason) => ({ ok: false, reason });
  const g = gates(pr, id, now);
  if (g.reason) return no(g.reason);
  const { x, chcfg, request_id } = g;
  if (x.approval.via !== 'human' || x.approval.to !== 'vista') return no('Post It needs your own approval for Vista Social');
  const v = chcfg.vista;
  if (!v || !v.profile_id) return no(`choose which ${x.channel} profile to post as (Settings, Vista Social)`);
  if (!['short', 'thread'].includes(x.format)) return no('Post It sends short posts and threads');
  const problems = ADAPTERS.outbox.validate(x, chcfg);
  if (problems.length) return no(problems[0]);
  const posts = postsOf(x.text); if (posts.length === 1) posts[0] = posts[0].replace(/^1\/1\s+/, '');
  const args = { profile_id: v.profile_id, message: posts[0], publish_at: 'now', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  if (posts.length > 1) args.customization = { comments: posts.slice(1).map((message) => ({ message })) };
  let text;
  try {
    const r = await (session || await VS.session()).call('createOrUpdatePost', args);
    text = (r.content || []).map((c) => c.text || '').join('\n');
    if (r.isError) throw new Error(text.slice(0, 300) || 'Vista Social refused the post');
  } catch (e) {
    writeHumanEvent(pr.root, 'draft.fail', { draft: x.id, error: String(e.message || e).slice(0, 300) }, { sid: x.sid, actor: 'cts' });
    pr.sync(); return no('Vista Social: ' + (e.message || e));
  }
  const receipt = { kind: 'vista', network: VISTA_NETWORK[x.channel] || x.channel, profile: v.name || String(v.profile_id), post_id: postIdOf(text), answer: text.slice(0, 300) };
  writeHumanEvent(pr.root, 'draft.publish', { draft: x.id, channel: x.channel, receipt, request_id }, { sid: x.sid, actor: 'cts' });
  pr.sync();
  return { ok: true, receipt, request_id };
}

/** Publish everything that is approved and due. Called by `cts publish` and by the server tick. */
export function runQueue(pr, { now = Date.now() } = {}) {
  const out = [];
  if (isPaused(pr)) return out;
  for (const x of pr.engine.drafts.list({ status: 'approved' }, now).filter((x) => x.approval.to !== 'vista').sort((a, b) => a.approval.t - b.approval.t)) {
    const r = publishDraft(pr, x.id, { now });
    if (r.ok || !/scheduled for|daily cap/.test(r.reason)) out.push({ id: x.id, ...r });
  }
  return out;
}
