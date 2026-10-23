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
