import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFrom } from '../src/lib/log.mjs';
import { Project } from '../src/lib/project.mjs';
import { paths } from '../src/lib/util.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hook.mjs');
const hooksJson = JSON.parse(fs.readFileSync(path.join(path.dirname(HOOK), '..', 'hooks', 'hooks.json'), 'utf8'));
const proj = (cfg = { capture: true }) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-hook-')); fs.mkdirSync(path.join(d, '.git')); if (cfg) { fs.mkdirSync(path.join(d, '.cts')); fs.writeFileSync(path.join(d, '.cts', 'cts.json'), JSON.stringify(cfg)); } return d; };
const fire = (root, payload, env = {}) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 'sess1', cwd: root, transcript_path: path.join(root, 't.jsonl'), prompt_id: 'p1', permission_mode: 'default', ...payload }), env: { ...process.env, CTS_NO_SERVER: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', ...env }, encoding: 'utf8' });
const lines = (root, sid = 'sess1') => { const f = path.join(paths(root).sessions, sid + '.jsonl'); return fs.existsSync(f) ? readFrom(f).events : []; };

// One payload per registered hook. Shapes follow the Claude Code docs where verified; the rest are best-effort.
const PAYLOADS = {
  SessionStart: { source: 'startup', model: 'claude-sonnet-5-5' },
  UserPromptSubmit: { prompt: 'add a limiter, key sk-ant-abcdefghijklmnopqrstuvwxyz123456' },
  PreToolUse: { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'tu1' },
  PostToolUse: { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'tu1', tool_response: { stdout: 'Tests: 3 passed, 3 total', stderr: '' } },
  PostToolUseFailure: { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'tu2', error: 'Tests: 1 failed, 2 passed, 3 total' },
  PostToolBatch: {},
  SubagentStart: { agent_id: 'a1', agent_type: 'planner' },
  SubagentStop: { agent_id: 'a1', agent_type: 'planner', last_assistant_message: 'The plan is complete.' },
  Stop: { last_assistant_message: 'Done.' },
  StopFailure: { error: 'rate_limit' },
  PreCompact: { trigger: 'auto' },
  PostCompact: { trigger: 'auto', summary: 'summary text' },
  PreModelSwitch: { from_model: 'claude-sonnet-5-5', to_model: 'claude-opus-5-5' },
  PostModelSwitch: { from_model: 'claude-sonnet-5-5', to_model: 'claude-opus-5-5' },
  SessionEnd: { reason: 'other' },
  Notification: { message: 'Claude needs your permission', notification_type: 'permission_prompt' },
  PermissionRequest: { tool_name: 'Bash', tool_input: { command: 'rm -rf x' } },
  PermissionDenied: { tool_name: 'Bash', tool_input: { command: 'rm -rf x' }, reason: 'denied' },
  TaskCreated: { task_id: 't1', task_subject: 'write tests' },
  TaskCompleted: { task_id: 't1' },
  TeammateIdle: { teammate_name: 'qa' },
  CwdChanged: { new_cwd: '/tmp/x' },
  DirectoryAdded: { directory: '/tmp/y' },
  Elicitation: { mcp_server_name: 'x', message: 'pick one' },
  ElicitationResult: { mcp_server_name: 'x', action: 'accept' },
};

test('hooks.json registers exactly the hooks we have payloads for; only SessionStart is synchronous', () => {
  assert.deepEqual(Object.keys(hooksJson.hooks).sort(), Object.keys(PAYLOADS).sort());
  for (const [name, arr] of Object.entries(hooksJson.hooks)) {
    const h = arr[0].hooks[0];
    assert.equal(h.type, 'command'); assert.match(h.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/src\/hook\.mjs/);
    assert.equal(!!h.async, name !== 'SessionStart', name);
  }
});

test('every hook event produces exactly one valid, attributed JSONL line and no stdout/stderr', () => {
  const root = proj();
  const names = Object.keys(PAYLOADS);
  for (const [i, name] of names.entries()) {
    const r = fire(root, { hook_event_name: name, ...PAYLOADS[name] });
    assert.equal(r.status, 0, name);
    assert.equal(r.stderr, '', name);
    if (name !== 'SessionStart') assert.equal(r.stdout, '', name);
    const evs = lines(root);
    assert.equal(evs.length, i + 1, `${name} wrote exactly one line`);
    assert.equal(evs[i].hook, name);
    assert.ok(evs[i].id && evs[i].ts && evs[i].kind && evs[i].actor);
  }
  const evs = lines(root);
  assert.equal(evs.find((e) => e.hook === 'UserPromptSubmit').actor, 'human');
  assert.equal(evs.find((e) => e.hook === 'SubagentStop').actor, 'agent:a1');
  assert.equal(evs.find((e) => e.hook === 'SubagentStop').agent_type, 'planner');
  assert.equal(evs.find((e) => e.hook === 'Stop').actor, 'main');
  assert.equal(evs.find((e) => e.hook === 'PostToolUse').d.test.pass, 3);
  assert.equal(evs.find((e) => e.hook === 'PostToolUseFailure').d.test.red, true);
  assert.match(evs.find((e) => e.hook === 'UserPromptSubmit').d.text, /\[redacted\]/, 'secrets never enter the log');
  assert.ok(!JSON.stringify(evs).includes('abcdefghijklmnopqrstuvwxyz123456'));
  assert.deepEqual(evs.find((e) => e.hook === 'Notification').d.extra.message, 'Claude needs your permission');
  assert.match(fs.readFileSync(path.join(paths(root).cts, '.gitignore'), 'utf8'), /^\*$/m, '.cts/ stays out of git by default');
});

test('three concurrent subagents produce three attributed lanes joined to their own transcripts', () => {
  const root = proj();
  const sub = path.join(root, 't', 'subagents'); fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(root, 't.jsonl'), '{"type":"user"}\n');
  for (const id of ['a1', 'a2', 'a3']) fs.writeFileSync(path.join(sub, `agent-${id}.jsonl`), `{"type":"assistant","who":"${id}"}\n`);
  const procs = ['a1', 'a2', 'a3'].flatMap((id) => ['SubagentStart', 'PreToolUse', 'PostToolUse', 'SubagentStop'].map((h) => ({ id, h })));
  for (const { id, h } of procs) fire(root, { hook_event_name: h, agent_id: id, agent_type: { a1: 'planner', a2: 'evaluator', a3: 'cts:reviewer' }[id], tool_name: 'Read', tool_input: { file_path: 'a.js' }, tool_use_id: id + h, last_assistant_message: 'ok done here' });
  const evs = lines(root);
  assert.equal(evs.length, 12);
  for (const id of ['a1', 'a2', 'a3']) {
    const mine = evs.filter((e) => e.actor === 'agent:' + id);
    assert.equal(mine.length, 4);
    assert.ok(mine.every((e) => e.tp && e.tp.path.endsWith(`agent-${id}.jsonl`)), 'joined to the subagent transcript');
  }
  const pr = Project.open(root);
  const lanes = pr.engine.sessions.get('sess1').actors;
  assert.deepEqual([...lanes.keys()], ['human', 'main', 'agent:a1', 'agent:a2', 'agent:a3']);
  assert.equal(lanes.get('agent:a3').label, 'cts:reviewer');
  pr.close();
});

test('transcript byte offsets point at real positions', () => {
  const root = proj(); fs.writeFileSync(path.join(root, 't.jsonl'), 'x'.repeat(1234));
  fire(root, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  assert.deepEqual(lines(root)[0].tp, { path: path.join(root, 't.jsonl'), off: 1234 });
});

test('a git commit through Bash is enriched with branch, subject, files and diff stat', () => {
  const root = proj(null);
  const g = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'a@b.c'); g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(root, 'a.js'), 'one\ntwo\n'); g('add', '.'); g('commit', '-q', '-m', 'first commit');
  fs.mkdirSync(path.join(root, '.cts')); fs.writeFileSync(path.join(root, '.cts', 'cts.json'), JSON.stringify({ capture: true }));
  fire(root, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m "first commit"' }, tool_use_id: 'g1', tool_response: { stdout: '[main abc] first commit' } });
  const e = lines(root)[0];
  assert.equal(e.d.git.op, 'commit'); assert.equal(e.d.git.branch, 'main'); assert.equal(e.d.git.subject, 'first commit');
  assert.deepEqual(e.d.git.files, ['a.js']); assert.deepEqual(e.d.git.stat, { files: 1, ins: 2, del: 0 });
  const pr = Project.open(root);
  assert.ok(pr.engine.listMoments().some((m) => m.kind === 'shipped' && /first commit/.test(m.headline)));
  pr.close();
});

test('pause: nothing is recorded while paused; broken input never surfaces', () => {
  const root = proj();
  fire(root, { hook_event_name: 'UserPromptSubmit', prompt: 'before' });
  fs.writeFileSync(paths(root).paused, 'x');
  fire(root, { hook_event_name: 'UserPromptSubmit', prompt: 'secret work' });
  fs.rmSync(paths(root).paused);
  fire(root, { hook_event_name: 'UserPromptSubmit', prompt: 'after' });
  const evs = lines(root);
  assert.deepEqual(evs.map((e) => e.d.text), ['before', 'after']);
  assert.ok(!fs.readFileSync(path.join(paths(root).sessions, 'sess1.jsonl'), 'utf8').includes('secret work'));
  const r = spawnSync(process.execPath, [HOOK], { input: '{not json', cwd: root, encoding: 'utf8', env: { ...process.env, CTS_NO_SERVER: '1' } });
  assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
});

test('SessionStart injects open threads and the last moment as additional context', () => {
  const root = proj();
  fs.mkdirSync(paths(root).cts, { recursive: true });
  fs.writeFileSync(paths(root).context, JSON.stringify({ threads: [{ id: 'x', text: 'Redis or in-memory for the limiter?', opened_ts: new Date(Date.now() - 3 * 86400e3).toISOString(), opened_by: 'main' }], last: { headline: 'evaluator rejected plan', kind: 'disagreement', score: 70 } }));
  const r = fire(root, { hook_event_name: 'SessionStart', source: 'resume' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /1 open thread/);
  assert.match(out.hookSpecificOutput.additionalContext, /Redis or in-memory/);
  assert.match(out.hookSpecificOutput.additionalContext, /evaluator rejected plan/);
});

test('SessionStart recaps where the last session left off, on a fresh start only', () => {
  const root = proj();
  fs.mkdirSync(paths(root).cts, { recursive: true });
  const recap = { sid: 'old', end: Date.now() - 2 * 3600e3, prompt: 'make the limiter pass', failing: [{ seg: 'npm test', fail: 2, names: ['refills tokens'] }], streaks: ['2 failed attempts at npm run build so far'], recurring: [], question: 'Should I keep the old refill logic?' };
  fs.writeFileSync(paths(root).context, JSON.stringify({ threads: [], recap }));
  const ctx = (src) => { const r = fire(root, { hook_event_name: 'SessionStart', source: src }); return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : ''; };
  const note = ctx('startup');
  assert.match(note, /Where the last session \(2h ago\) left off\. The user last asked: "make the limiter pass"/);
  assert.match(note, /Tests still failing at the end: npm test \(2 failing: refills tokens\)/);
  assert.match(note, /Unresolved: 2 failed attempts at npm run build so far/);
  assert.match(note, /never answered: "Should I keep the old refill logic\?"/);
  assert.match(ctx('clear'), /left off/);
  for (const src of ['resume', 'compact']) assert.doesNotMatch(ctx(src), /left off/, src);
});

test('hook overhead: median time CTS adds per event on top of Node startup stays under 50 ms', () => {
  // The acceptance budget is 100 ms per event. Node's own startup varies by platform (about 70-200 ms on Windows), so the
  // test checks what CTS adds, with runs interleaved with bare Node so background load hits both sides equally.
  const root = proj();
  const times = [], bare = [];
  for (let i = 0; i < 25; i++) {
    let t = process.hrtime.bigint(); fire(root, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'a' }, tool_use_id: 'u' + i }); times.push(Number(process.hrtime.bigint() - t) / 1e6);
    t = process.hrtime.bigint(); spawnSync(process.execPath, ['-e', '0']); bare.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  times.sort((a, b) => a - b); bare.sort((a, b) => a - b);
  const med = times[12], base = bare[12];
  console.log(`# hook median ${med.toFixed(1)} ms (bare node ${base.toFixed(1)} ms; CTS adds ~${(med - base).toFixed(1)} ms)`);
  assert.ok(med - base < 50, `CTS adds ${(med - base).toFixed(1)} ms`);
  assert.equal(lines(root).length, 25);
});

test('killing mid-write loses at most the last line and the log stays parseable', () => {
  const root = proj();
  for (let i = 0; i < 5; i++) fire(root, { hook_event_name: 'UserPromptSubmit', prompt: 'p' + i });
  const f = path.join(paths(root).sessions, 'sess1.jsonl');
  fs.appendFileSync(f, '{"v":1,"id":"01TRUNC');
  const r = readFrom(f);
  assert.equal(r.events.length, 5);
  fire(root, { hook_event_name: 'UserPromptSubmit', prompt: 'after crash' });
  // the truncated fragment fuses with the next line; that one line is lost, the rest are intact
  assert.ok(readFrom(f).events.length >= 5);
});

test('SessionStart shows the user one line about drafts awaiting review, unless notify.terminal is off', () => {
  const root = proj();
  fs.mkdirSync(paths(root).cts, { recursive: true });
  fs.writeFileSync(paths(root).context, JSON.stringify({ threads: [], pending_drafts: 2 }));
  let out = JSON.parse(fire(root, { hook_event_name: 'SessionStart', source: 'startup' }).stdout);
  assert.match(out.systemMessage, /^CTS: 2 drafted posts await your review/);
  assert.match(out.hookSpecificOutput.additionalContext, /Do not approve or publish them yourself/);
  fs.writeFileSync(paths(root).config, JSON.stringify({ capture: true, notify: { terminal: false } }));
  out = JSON.parse(fire(root, { hook_event_name: 'SessionStart', source: 'startup' }).stdout);
  assert.equal(out.systemMessage, undefined);
});

test('a background task notification injected as a user turn is not a human prompt', () => {
  const root = proj();
  fire(root, { hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>a1</task-id>\n<result>keep it for now, revisit later</result>\n</task-notification>' });
  fire(root, { hook_event_name: 'UserPromptSubmit', prompt: 'wait, keep it for now' });
  const evs = lines(root);
  assert.deepEqual(evs.map((e) => [e.kind, e.actor]), [['notify', 'main'], ['prompt', 'human']]);
  assert.equal(evs[0].d.synthetic, 'task-notification');
  assert.match(evs[1].d.who, /^[0-9a-f]{12}$/);
});

test('a prompt in a headless session (`CLAUDE_CODE_ENTRYPOINT=sdk-cli`) is attributed to the caller', () => {
  const root = proj({ capture: true, captureHeadless: true });
  fire(root, { hook_event_name: 'SessionStart', source: 'startup' }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
  fire(root, { hook_event_name: 'UserPromptSubmit', prompt: 'Reply with JSON only.' }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
  fire(root, { hook_event_name: 'UserPromptSubmit', prompt: 'and from the IDE' }, { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' });
  const [start, p, q] = lines(root);
  assert.equal(start.d.headless, 'sdk-cli');
  assert.equal(p.actor, 'caller'); assert.equal(p.d.who, undefined);
  assert.equal(q.actor, 'human'); assert.ok(q.d.who, 'interactive surfaces other than the CLI are still you');
});

test('SessionStart tips about the status line once, and only when none is set', () => {
  const root = proj(), home = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-home-')), claude = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-claude-'));
  const env = { CTS_HOME: home, CLAUDE_CONFIG_DIR: claude };
  const msg = () => { const o = fire(root, { hook_event_name: 'SessionStart', source: 'startup' }, env).stdout; return o ? JSON.parse(o).systemMessage : undefined; };
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'x' } }));
  assert.equal(msg(), undefined);
  fs.writeFileSync(path.join(claude, 'settings.json'), '{}');
  assert.match(msg(), /\/cts:init --statusline --global/);
  assert.equal(msg(), undefined, 'shown once');
});

test('SessionStart upgrades the old .cts/.gitignore to private, unless git already tracks the logs', () => {
  const legacy = 'index.sqlite*\nserver.json\npaused\nhooks.log\ncontext.json\n';
  const setup = (track) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-git-'));
    const g = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
    g('init', '-q'); g('config', 'user.email', 'a@b.c'); g('config', 'user.name', 'T');
    fs.mkdirSync(path.join(root, '.cts', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(root, '.cts', '.gitignore'), legacy);
    fs.writeFileSync(path.join(root, '.cts', 'cts.json'), JSON.stringify({ capture: true }));
    fs.writeFileSync(path.join(root, '.cts', 'sessions', 'old.jsonl'), '');
    if (track) { g('add', '.cts'); g('commit', '-q', '-m', 'logs'); }
    fire(root, { hook_event_name: 'SessionStart', source: 'startup' });
    return fs.readFileSync(path.join(root, '.cts', '.gitignore'), 'utf8');
  };
  assert.match(setup(false), /^\*$/m);
  assert.equal(setup(true), legacy, 'a team already sharing the logs keeps sharing them');
});

test('capture is off until the project opts in: no .cts/, no server, no context', () => {
  const root = proj(null);
  const r = fire(root, { hook_event_name: 'SessionStart', ...PAYLOADS.SessionStart });
  fire(root, { hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
  assert.equal(r.stdout, ''); assert.equal(fs.existsSync(path.join(root, '.cts')), false);
  const off = proj({ capture: false });
  fire(off, { hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
  assert.equal(lines(off).length, 0);
});

test('headless sessions (`claude -p`, SDKs) are skipped unless captureHeadless is set', () => {
  const root = proj();
  for (const entry of ['sdk-cli', 'sdk-ts', 'sdk-py']) fire(root, { hook_event_name: 'UserPromptSubmit', prompt: 'from an agent' }, { CLAUDE_CODE_ENTRYPOINT: entry });
  assert.equal(lines(root).length, 0);
  fire(root, { hook_event_name: 'UserPromptSubmit', prompt: 'from me' });
  assert.equal(lines(root).length, 1);
});
