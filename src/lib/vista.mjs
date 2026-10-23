// Vista Social, the one network adapter: a minimal MCP client (streamable HTTP, JSON-RPC) for mcp.vistasocial.com, with OAuth
// (dynamic client registration + PKCE, callback on the local dashboard) or a key link. Credentials live in ~/.cts/vista.json
// (mode 0600), never in the event log. Nothing here runs unless a person asks: connect, list, or Post It on an approved draft.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ctsHome } from './consent.mjs';

export const VISTA_MCP = 'https://mcp.vistasocial.com/mcp';
const file = () => path.join(ctsHome(), 'vista.json');
export const loadCreds = () => { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return {}; } };
export function saveCreds(c) {
  fs.mkdirSync(ctsHome(), { recursive: true });
  const f = file(), tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 1), { mode: 0o600 }); fs.renameSync(tmp, f); fs.chmodSync(f, 0o600);
}
/** What the dashboard may see: never a token or a key. */
export function status() {
  const c = loadCreds();
  if (c.url) return { connected: true, method: 'link', since: c.since || null };
  if (c.token && c.token.access_token) return { connected: true, method: 'oauth', since: c.since || null, expires: c.token.expires_at || null };
  return { connected: false };
}
export const disconnect = () => { try { fs.rmSync(file()); } catch { /* not connected */ } };
/** A key link replaces OAuth: only https links on vistasocial.com are accepted. */
export function setLink(url) {
  let u; try { u = new URL(String(url).trim()); } catch { return { error: 'not a link' }; }
  if (u.protocol !== 'https:' || !/(^|\.)vistasocial\.com$/.test(u.hostname)) return { error: 'the link must be https and on vistasocial.com' };
  saveCreds({ url: u.href, since: new Date().toISOString() });
  return { ok: true };
}

// ---------- OAuth ----------
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const pending = new Map();   // state -> { verifier, redirect, client_id, meta, t }
async function meta(f = fetch) {
  const r = await f('https://mcp.vistasocial.com/.well-known/oauth-authorization-server');
  if (!r.ok) throw new Error(`Vista Social OAuth metadata: HTTP ${r.status}`);
  return r.json();
}
/** Start OAuth: register this dashboard's callback (once per callback URL), return the page to send the person to. */
export async function beginOAuth(redirect, f = fetch) {
  const m = await meta(f), c = loadCreds();
  let client = c.clients && c.clients[redirect];
  if (!client) {
    const r = await f(m.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'CTS (Capture The Struggle)', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
    if (!r.ok) throw new Error(`Vista Social client registration: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    client = await r.json();
    saveCreds({ ...loadCreds(), clients: { ...(loadCreds().clients || {}), [redirect]: { client_id: client.client_id, client_secret: client.client_secret || null } } });
    client = loadCreds().clients[redirect];
  }
  const verifier = b64url(crypto.randomBytes(32)), state = b64url(crypto.randomBytes(16));
  for (const [k, v] of pending) if (Date.now() - v.t > 15 * 60000) pending.delete(k);
  pending.set(state, { verifier, redirect, client, meta: m, t: Date.now() });
  const u = new URL(m.authorization_endpoint);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, state, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', resource: 'https://mcp.vistasocial.com' })) u.searchParams.set(k, v);
  return u.href;
}
async function tokenRequest(m, client, params, f = fetch) {
  const body = new URLSearchParams({ client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}), ...params });
  const r = await f(m.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Vista Social token: HTTP ${r.status} ${j.error || ''} ${j.error_description || ''}`.trim());
  return { ...j, expires_at: j.expires_in ? Date.now() + j.expires_in * 1000 : null };
}
/** The OAuth callback: swap the code for tokens. */
export async function finishOAuth(state, code, f = fetch) {
  const p = pending.get(state);
  if (!p) throw new Error('this sign-in link expired or was already used; start again from Settings');
  pending.delete(state);
  const token = await tokenRequest(p.meta, p.client, { grant_type: 'authorization_code', code, redirect_uri: p.redirect, code_verifier: p.verifier, resource: 'https://mcp.vistasocial.com' }, f);
  const c = loadCreds(); delete c.url;
  saveCreds({ ...c, token, client: p.client, since: new Date().toISOString() });
}
async function bearer(f = fetch) {
  const c = loadCreds();
  if (!c.token) return null;
  if (c.token.expires_at && c.token.expires_at - Date.now() < 60000 && c.token.refresh_token) {
    const token = await tokenRequest(await meta(f), c.client, { grant_type: 'refresh_token', refresh_token: c.token.refresh_token }, f);
    saveCreds({ ...c, token: { refresh_token: c.token.refresh_token, ...token } });
    return token.access_token;
  }
  return c.token.access_token;
}

// ---------- MCP over streamable HTTP ----------
/** A JSON-RPC answer, from a JSON body or the last `data:` message of an event stream. */
const answerOf = (text, id) => {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) return [].concat(JSON.parse(t)).find((x) => x.id === id) || null;
  const msgs = t.split(/\n\n+/).map((blk) => blk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')).filter(Boolean);
  for (const m of msgs.reverse()) { try { const j = JSON.parse(m); if (j.id === id) return j; } catch { /* keep looking */ } }
  return null;
};
export async function session(f = fetch) {
  const c = loadCreds();
  const url = c.url || VISTA_MCP;
  const tok = c.url ? null : await bearer(f);
  if (!c.url && !tok) throw new Error('Vista Social is not connected: connect it in Settings');
  let sid = null, n = 0;
  const send = async (method, params, notify = false) => {
    const id = notify ? undefined : ++n;
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(sid ? { 'mcp-session-id': sid } : {}) };
    const r = await f(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notify ? {} : { id }) }) });
    sid = r.headers.get('mcp-session-id') || sid;
    if (r.status === 401) throw new Error('Vista Social refused the credentials (401): reconnect in Settings');
    const text = await r.text();
    if (!r.ok) throw new Error(`Vista Social MCP ${method}: HTTP ${r.status} ${text.slice(0, 200)}`);
    if (notify) return null;
    const a = answerOf(text, id);
    if (!a) throw new Error(`Vista Social MCP ${method}: no answer`);
    if (a.error) throw new Error(`Vista Social MCP ${method}: ${a.error.message || JSON.stringify(a.error)}`);
    return a.result;
  };
  await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cts', version: '1' } });
  await send('notifications/initialized', null, true);
  return {
    tools: async () => { const out = []; let cursor; do { const r = await send('tools/list', cursor ? { cursor } : {}); out.push(...(r.tools || [])); cursor = r.nextCursor; } while (cursor); return out; },
    call: async (name, args) => send('tools/call', { name, arguments: args }),
  };
}
