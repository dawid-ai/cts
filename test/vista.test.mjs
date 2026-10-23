import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CTS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-vhome-'));
const VS = await import('../src/lib/vista.mjs');

// A fake Vista Social: OAuth metadata, client registration, token endpoint and an MCP endpoint answering as an event stream.
function fake() {
  const calls = [];
  const res = (status, body, headers = {}) => ({ ok: status < 400, status, headers: new Headers(headers), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body });
  const f = async (url, o = {}) => {
    calls.push({ url: String(url), o });
    const u = new URL(url);
    if (u.pathname.endsWith('oauth-authorization-server')) return res(200, { authorization_endpoint: 'https://vistasocial.com/api/oauth/authorize', token_endpoint: 'https://vistasocial.com/api/oauth/token', registration_endpoint: 'https://vistasocial.com/api/oauth/clients' });
    if (u.pathname === '/api/oauth/clients') return res(201, { client_id: 'cid-1' });
    if (u.pathname === '/api/oauth/token') { const p = new URLSearchParams(o.body); return p.get('code_verifier') && p.get('code') === 'the-code' ? res(200, { access_token: 'tok-1', refresh_token: 'ref-1', expires_in: 3600 }) : res(400, { error: 'invalid_grant' }); }
    if (u.pathname === '/mcp') {
      const m = JSON.parse(o.body);
      if (!o.headers.authorization && !u.searchParams.get('key')) return res(401, { error: 'invalid_token' });
      if (m.method === 'initialize') return res(200, `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18' } })}\n\n`, { 'mcp-session-id': 'S1', 'content-type': 'text/event-stream' });
      if (m.method === 'notifications/initialized') return res(202, '');
      if (m.method === 'tools/list') return res(200, { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'create_post', description: 'Create or update a post' }] } });
    }
    return res(404, 'nope');
  };
  return { f, calls };
}

test('vista: a key link must be https on vistasocial.com; status never shows a credential', () => {
  assert.match(VS.setLink('http://mcp.vistasocial.com/mcp?key=x').error, /https/);
  assert.match(VS.setLink('https://evil.example.com/mcp').error, /vistasocial\.com/);
  assert.ok(VS.setLink('https://mcp.vistasocial.com/mcp?key=secret-key').ok);
  assert.equal(JSON.stringify(VS.status()).includes('secret-key'), false);
  assert.equal(VS.status().method, 'link');
  assert.equal(fs.statSync(path.join(process.env.CTS_HOME, 'vista.json')).mode & 0o777, 0o600);
  VS.disconnect(); assert.equal(VS.status().connected, false);
});

test('vista: OAuth registers once per callback, uses PKCE, stores the token; the MCP session reads event streams and keeps the session id', async () => {
  const { f, calls } = fake();
  const go = new URL(await VS.beginOAuth('http://localhost:4848/oauth/vista/callback', f));
  assert.equal(go.searchParams.get('code_challenge_method'), 'S256'); assert.equal(go.searchParams.get('client_id'), 'cid-1');
  await assert.rejects(VS.finishOAuth('wrong-state', 'the-code', f), /expired/);
  await VS.finishOAuth(go.searchParams.get('state'), 'the-code', f);
  assert.equal(VS.status().method, 'oauth');
  await VS.beginOAuth('http://localhost:4848/oauth/vista/callback', f);
  assert.equal(calls.filter((c) => c.url.endsWith('/api/oauth/clients')).length, 1, 'registered once');
  const s = await VS.session(f);
  assert.deepEqual((await s.tools()).map((t) => t.name), ['create_post']);
  const mcp = calls.filter((c) => c.url.endsWith('/mcp'));
  assert.equal(mcp[0].o.headers.authorization, 'Bearer tok-1');
  assert.equal(mcp[mcp.length - 1].o.headers['mcp-session-id'], 'S1');
  VS.disconnect();
  await assert.rejects(VS.session(f), /not connected/);
});

test('Post It: only your approval made for Vista posts; the file queue leaves it alone; a thread goes out with reply comments; no double post', async () => {
  const { Project } = await import('../src/lib/project.mjs');
  const { paths, serialize } = await import('../src/lib/util.mjs');
  const N = await import('../src/lib/narrative.mjs');
  const PB = await import('../src/lib/publish.mjs');
  const { setVistaProfile } = await import('../src/lib/settings.mjs');
  const { Sim, JEST_RED, JEST_GREEN } = await import('./helpers.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-vp-')); fs.mkdirSync(path.join(root, '.git')); fs.mkdirSync(paths(root).sessions, { recursive: true });
  fs.writeFileSync(paths(root).config, '{}');
  const s = new Sim({ start: Date.now() - 3600e3 }); s.start(); s.prompt('make the limiter pass'); s.adv(1);
  for (let i = 0; i < 4; i++) { s.bash('npm test', { ok: false, out: JEST_RED(2) }); s.adv(1); } s.bash('npm test', { out: JEST_GREEN }); s.stop('ok');
  fs.writeFileSync(path.join(paths(root).sessions, 's.jsonl'), s.events.map(serialize).join(''));
  let pr = Project.open(root);
  const m = pr.engine.listMoments().find((x) => x.kind === 'fight');
  const id = N.createDraft(pr, m.id, { channel: 'x', format: 'thread' }).id;
  N.edit(pr, id, '1/2 It failed 4 times.\n\n---\n\n2/2 Then it passed.');
  const calls = [];
  const session = { call: async (name, args) => { calls.push({ name, args }); return { content: [{ type: 'text', text: JSON.stringify({ id: 'pub-77', status: 'PROCESSING' }) }] }; } };
  assert.match((await PB.postToVista(pr, id, { session })).reason, /not approved/);
  N.approve(pr, id);
  assert.match((await PB.postToVista(pr, id, { session })).reason, /your own approval for Vista/, 'a plain approval is for the outbox, not Post It');
  N.approve(pr, id, { to: 'vista' });
  assert.equal(PB.runQueue(pr).length, 0, 'the file queue leaves a Vista approval alone');
  assert.match(PB.publishDraft(pr, id).reason, /use Post It/);
  assert.match((await PB.postToVista(pr, id, { session })).reason, /choose which x profile/);
  setVistaProfile(root, 'x', { profile_id: 470562, name: '@me' });
  pr.close(); pr = Project.open(root);
  const failing = { call: async () => { throw new Error('HTTP 500'); } };
  assert.match((await PB.postToVista(pr, id, { session: failing })).reason, /HTTP 500/);
  assert.equal(pr.engine.drafts.get(id).status, 'approved', 'a failed post keeps the approval for a retry');
  const r = await PB.postToVista(pr, id, { session });
  assert.ok(r.ok, JSON.stringify(r)); assert.equal(r.receipt.post_id, 'pub-77'); assert.equal(r.receipt.profile, '@me');
  const d = pr.engine.drafts.get(id), posts = d.text.split('\n\n---\n\n');
  assert.equal(calls.length, 1); assert.equal(calls[0].name, 'createOrUpdatePost');
  assert.deepEqual({ ...calls[0].args, timezone: 'tz' }, { profile_id: 470562, message: posts[0], publish_at: 'now', timezone: 'tz', customization: { comments: posts.slice(1).map((message) => ({ message })) } });
  assert.equal(d.status, 'published');
  assert.match((await PB.postToVista(pr, id, { session })).reason, /already published/); assert.equal(calls.length, 1);
  const auto = N.createDraft(pr, m.id, { channel: 'x' }).id;
  N.approve(pr, auto, { via: 'autopilot', to: 'vista' });
  assert.match((await PB.postToVista(pr, auto, { session })).reason, /autopilot|own approval|wrong actor|auto-publish/, 'autopilot never posts through Vista');
  pr.close();
});

test('Approve to the Vista queue: asks for the next free slot, refuses a profile with no queue; LinkedIn goes as a text post; X Premium lifts the limit', async () => {
  const { Project } = await import('../src/lib/project.mjs');
  const { paths, serialize, loadConfig } = await import('../src/lib/util.mjs');
  const N = await import('../src/lib/narrative.mjs');
  const PB = await import('../src/lib/publish.mjs');
  const { setVistaProfile } = await import('../src/lib/settings.mjs');
  const { Sim } = await import('./helpers.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-vq-')); fs.mkdirSync(path.join(root, '.git')); fs.mkdirSync(paths(root).sessions, { recursive: true });
  fs.writeFileSync(paths(root).config, JSON.stringify({ publishing: { channels: { x: { premium: true } } } }));
  assert.equal(loadConfig(root).publishing.channels.x.limit, 25000);
  const s = new Sim({ start: Date.now() - 3600e3 }); s.start(); s.prompt('add a limiter'); s.adv(1); s.prompt('wait, go back to the old refill logic'); s.stop('ok');
  fs.writeFileSync(path.join(paths(root).sessions, 's.jsonl'), s.events.map(serialize).join(''));
  setVistaProfile(root, 'linkedin', { profile_id: 470558, name: 'Dawid' }); setVistaProfile(root, 'bluesky', { profile_id: 751366, name: '@bsky' });
  const pr = Project.open(root);
  const m = pr.engine.listMoments().find((x) => x.kind === 'reversal');
  const calls = [];
  const queues = { 470558: [{ schedule: [{ day: 1, slots: [{ hour: 9 }] }] }], 751366: [] };
  const session = { call: async (name, args) => { calls.push({ name, args }); return { content: [{ type: 'text', text: JSON.stringify(name === 'getProfileQueues' ? { queues: queues[args.profile_id] } : { id: 'p1' }) }] }; } };
  const li = N.createDraft(pr, m.id, { channel: 'linkedin' }).id;
  N.approve(pr, li, { to: 'vista' });
  const r = await PB.postToVista(pr, li, { session, when: 'queue' });
  assert.ok(r.ok, JSON.stringify(r)); assert.equal(r.receipt.when, 'queue');
  const post = calls.find((c) => c.name === 'createOrUpdatePost').args;
  assert.equal(post.publish_at, 'queue_available'); assert.deepEqual(post.customization, { publish_as: 'ARTICLE' });
  const bs = N.createDraft(pr, m.id, { channel: 'bluesky' }).id;
  N.approve(pr, bs, { to: 'vista' });
  assert.match((await PB.postToVista(pr, bs, { session, when: 'queue' })).reason, /no posting queue/);
  assert.equal(calls.filter((c) => c.name === 'createOrUpdatePost').length, 1, 'nothing sent for a profile without a queue');
  assert.ok((await PB.postToVista(pr, bs, { session })).ok, 'Post It still works there');
  pr.close();
});

test('Post It with an attached image: rendered, uploaded once, sent as media; LinkedIn goes as an image post', async () => {
  const { Project } = await import('../src/lib/project.mjs');
  const { paths, serialize } = await import('../src/lib/util.mjs');
  const N = await import('../src/lib/narrative.mjs');
  const PB = await import('../src/lib/publish.mjs');
  const I = await import('../src/lib/images.mjs');
  const { setVistaProfile } = await import('../src/lib/settings.mjs');
  const { Sim } = await import('./helpers.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-vi-')); fs.mkdirSync(path.join(root, '.git')); fs.mkdirSync(paths(root).sessions, { recursive: true });
  fs.writeFileSync(paths(root).config, JSON.stringify({ images: { github: { repo: 'me/cts-images' } } }));
  const s = new Sim({ start: Date.now() - 3600e3 }); s.start(); s.prompt('add a limiter'); s.adv(1); s.prompt('wait, go back to the old refill logic'); s.stop('ok');
  fs.writeFileSync(path.join(paths(root).sessions, 's.jsonl'), s.events.map(serialize).join(''));
  setVistaProfile(root, 'linkedin', { profile_id: 470558, name: 'Dawid' });
  const pr = Project.open(root);
  const m = pr.engine.listMoments().find((x) => x.kind === 'reversal');
  const id = N.createDraft(pr, m.id, { channel: 'linkedin' }).id;
  await I.createImage(pr, id, { template: 'receipt', render: false });
  N.approve(pr, id, { to: 'vista' });
  const uploads = [], renders = [];
  const render = async (f, w, h) => { renders.push([w, h]); fs.writeFileSync(f.replace(/\.svg$/, '.png'), 'PNG'); return f.replace(/\.svg$/, '.png'); };
  const upload = async (p, file, name) => { uploads.push(name); assert.equal(fs.readFileSync(file, 'utf8'), 'PNG'); return `https://raw.githubusercontent.com/me/cts-images/main/${name}`; };
  const calls = [];
  const session = { call: async (name, args) => { calls.push({ name, args }); if (name === 'createOrUpdatePost' && calls.length === 1) throw new Error('HTTP 500'); return { content: [{ type: 'text', text: '{"id":"p9"}' }] }; } };
  assert.match((await PB.postToVista(pr, id, { session, upload, render })).reason, /HTTP 500/);
  const r = await PB.postToVista(pr, id, { session, upload, render });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(renders, [[1200, 675]]); assert.equal(uploads.length, 1, 'uploaded once; the retry reused the URL');
  assert.match(uploads[0], new RegExp(`^${path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-')}/${id}-0-[0-9a-f]{10}\\.png$`));
  const post = calls[calls.length - 1].args;
  assert.deepEqual(post.media_url, [`https://raw.githubusercontent.com/me/cts-images/main/${uploads[0]}`]);
  assert.deepEqual(post.customization, { publish_as: 'IMAGE' });
  pr.close();
});
