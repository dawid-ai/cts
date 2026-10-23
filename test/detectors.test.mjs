import test from 'node:test';
import assert from 'node:assert/strict';
import { run, JEST_RED, JEST_GREEN } from './helpers.mjs';
import { testSegment, testInfo } from '../src/lib/parse.mjs';

const has = (r, k) => r.kinds.includes(k);

test('reversal fires on a correction prompt, not on a normal one', () => {
  assert.ok(has(run((s) => { s.start(); s.prompt('wait, go back to the old approach'); }), 'reversal'));
  assert.ok(has(run((s) => { s.start(); s.prompt('actually that is wrong'); }), 'reversal'));
  assert.ok(!has(run((s) => { s.start(); s.prompt('now add tests for the parser'); s.prompt('nothing to see, notable work'); }), 'reversal'));
});
test('reversal fires on git revert and hard reset, not on plain reset', () => {
  assert.ok(has(run((s) => { s.start(); s.bash('git revert HEAD'); }), 'reversal'));
  assert.ok(has(run((s) => { s.start(); s.bash('git reset --hard HEAD~1'); }), 'reversal'));
  assert.ok(!has(run((s) => { s.start(); s.bash('git reset src/a.js'); }), 'reversal'));
  assert.ok(!has(run((s) => { s.start(); s.bash('git reset -q --soft HEAD~1 && git reset -q && git add src/a.js'); }), 'reversal'), 'uncommitting to re-split keeps the work');
});

test('fight: 4 red runs then green gives one moment scored 40+5n; 2 reds do not', () => {
  const r = run((s) => {
    s.start();
    for (let i = 0; i < 4; i++) { s.bash('npm test', { ok: false, out: JEST_RED(2) }); s.adv(2); }
    s.bash('npm test', { out: JEST_GREEN });
  });
  const f = r.moments.filter((m) => m.kind === 'fight');
  assert.equal(f.length, 1);
  assert.equal(f[0].score, 60);
  assert.equal(f[0].evidence.attempts, 4);
  assert.equal(r.eng.sessions.get('s1').stats.redGreen, 1);
  const n = run((s) => { s.start(); s.bash('npm test', { ok: false, out: JEST_RED(1) }); s.bash('npm test', { ok: false, out: JEST_RED(1) }); s.bash('npm test', { out: JEST_GREEN }); });
  assert.ok(!has(n, 'fight'));
});
test('near-miss: a running streak warms up live, a fix below fightMin cools it, a fight replaces it', () => {
  const live = run((s) => { s.start(); s.bash('npm test', { ok: false, out: JEST_RED(1) }); s.adv(1); s.bash('npm test', { ok: false, out: JEST_RED(1) }); });
  const [w] = live.eng.listWarm();
  assert.equal(live.eng.listWarm().length, 1);
  assert.ok(w.live && !w.done && w.attempts === 2);
  assert.match(w.headline, /^2 failed attempts at .* so far$/);
  const fixed = run((s) => { s.start(); s.bash('npm test', { ok: false, out: JEST_RED(1) }); s.bash('npm test', { out: JEST_GREEN }); });
  const [c] = fixed.eng.listWarm();
  assert.ok(c.done && !c.live && c.attempts === 1);
  assert.match(c.headline, /^1 failed attempt at .*, then it passed$/);
  assert.equal(fixed.moments.length, 0, 'a near-miss is not a moment');
  const fight = run((s) => { s.start(); for (let i = 0; i < 3; i++) s.bash('npm test', { ok: false, out: JEST_RED(1) }); s.bash('npm test', { out: JEST_GREEN }); });
  assert.ok(has(fight, 'fight'));
  assert.equal(fight.eng.listWarm().length, 0);
  const stale = run((s) => { s.start(); s.bash('npm test', { ok: false, out: JEST_RED(1) }); s.adv(120); s.bash('npm test', { ok: false, out: JEST_RED(1) }); });
  const ws = stale.eng.listWarm();
  assert.equal(ws.length, 2);
  assert.match(ws[0].headline, /then moved on$/);
  assert.ok(ws[1].live);
});
test('near-miss: a pending question is live until answered; a long wait becomes a wait moment instead', () => {
  const q = (answer, gap) => run((s) => { s.start(); s.prompt('ship it'); const id = s.pre('AskUserQuestion', { questions: ['Which branch?'] }); if (answer) { s.adv(gap); s.post('AskUserQuestion', {}, { id }); } });
  const [w] = q(false).eng.listWarm();
  assert.ok(w && w.of === 'wait' && w.live);
  assert.equal(w.headline, 'Waiting on Which branch?');
  assert.equal(q(true, 2).eng.listWarm().length, 0);
  const long = q(true, 45);
  assert.equal(long.eng.listWarm().length, 0);
  assert.ok(has(long, 'wait'));
});
test('fight score caps at 90 and also fires on repeated edit failures', () => {
  const r = run((s) => {
    s.start();
    for (let i = 0; i < 14; i++) s.post('Edit', { file_path: 'a.js' }, { ok: false, out: 'old_string not found' });
    s.post('Edit', { file_path: 'a.js' });
  });
  assert.equal(r.moments.find((m) => m.kind === 'fight').score, 90);
});
test('fight: failures on different targets do not combine', () => {
  const r = run((s) => {
    s.start();
    s.bash('ls /nope1', { ok: false }); s.bash('ls /nope2', { ok: false }); s.bash('ls /nope3', { ok: false }); s.bash('ls /ok');
  });
  assert.ok(!has(r, 'fight'));
});

test('disagreement: evaluator says missing after planner said done; agreement does not fire', () => {
  const r = run((s) => {
    s.start();
    s.subStart('a1', 'planner', 'planner'); s.adv(3); s.subStop('a1', 'planner', 'The plan is complete and ready to implement.');
    s.adv(2); s.subStart('a2', 'evaluator', 'evaluator'); s.adv(3); s.subStop('a2', 'evaluator', 'Rejected: the rollback step is missing from the plan.');
  });
  const m = r.moments.find((x) => x.kind === 'disagreement');
  assert.ok(m); assert.equal(m.score, 70); assert.deepEqual(m.actors.sort(), ['agent:a1', 'agent:a2']);
  assert.match(m.headline, /evaluator pushed back on planner/);
  const n = run((s) => { s.start(); s.subStop('a1', 'planner', 'The plan is complete and ready.'); s.adv(1); s.subStop('a2', 'evaluator', 'Looks good, approved and ready.'); });
  assert.ok(!has(n, 'disagreement'));
});

test('shipped: commit on main yes, commit on feature branch no, tag and deploy yes', () => {
  assert.ok(has(run((s) => { s.start(); s.bash('git commit -m "x"', { git: { branch: 'main', subject: 'x', files: ['a.js'], stat: { files: 1, ins: 3, del: 1 } } }); }), 'shipped'));
  assert.ok(has(run((s) => { s.start(); s.bash('git commit -m "x"', { git: { branch: 'release/1.2', subject: 'x' } }); }), 'shipped'));
  assert.ok(!has(run((s) => { s.start(); s.bash('git commit -m "x"', { git: { branch: 'feature/x', subject: 'x' } }); }), 'shipped'));
  assert.ok(has(run((s) => { s.start(); s.bash('git tag v1.0.0', { git: { branch: 'main', tag: 'v1.0.0' } }); }), 'shipped'));
  assert.ok(has(run((s) => { s.start(); s.bash('fly deploy --remote-only'); }), 'shipped'));
  assert.ok(!has(run((s) => { s.start(); s.bash('echo deployment notes'); }), 'shipped'));
});

test('broke: green to red fires once; red without prior green does not', () => {
  const r = run((s) => { s.start(); s.bash('pytest -q', { out: '5 passed in 0.1s' }); s.adv(5); s.bash('pytest -q', { ok: false, out: '1 failed, 4 passed' }); s.bash('pytest -q', { ok: false, out: '1 failed, 4 passed' }); });
  assert.equal(r.kinds.filter((k) => k === 'broke').length, 1);
  assert.ok(!has(run((s) => { s.start(); s.bash('pytest -q', { ok: false, out: '1 failed, 4 passed' }); }), 'broke'));
});

test('pivot: long branch then switch, worktree, dependency swap, deleting a just-written file', () => {
  assert.ok(has(run((s) => { s.start(); s.bash('git commit -m a', { git: { branch: 'feature/a', subject: 'a' } }); s.adv(60); s.bash('git checkout -b feature/b', { git: { branch: 'feature/b' } }); }), 'pivot'));
  assert.ok(!has(run((s) => { s.start(); s.bash('git commit -m a', { git: { branch: 'feature/a', subject: 'a' } }); s.adv(5); s.bash('git checkout -b feature/b', { git: { branch: 'feature/b' } }); }), 'pivot'));
  assert.ok(has(run((s) => { s.start(); s.bash('git worktree add ../try-2'); }), 'pivot'));
  assert.ok(has(run((s) => { s.start(); s.bash('npm uninstall moment'); s.adv(2); s.bash('npm install dayjs'); }), 'pivot'));
  assert.ok(!has(run((s) => { s.start(); s.bash('npm install dayjs'); }), 'pivot'));
  assert.ok(has(run((s) => { s.start(); s.post('Write', { file_path: '/work/app/src/old.js' }); s.adv(10); s.bash('rm src/old.js'); }), 'pivot'));
  assert.ok(!has(run((s) => { s.start(); s.post('Write', { file_path: '/work/app/src/old.js' }); s.adv(120); s.bash('rm src/old.js'); }), 'pivot'));
});

test('memory-cut: re-reading files after compaction fires; reading new files does not', () => {
  const r = run((s) => {
    s.start(); s.post('Read', { file_path: 'a.js' }); s.post('Read', { file_path: 'b.js' });
    s.ev('compact.post', { trigger: 'auto' }); s.adv(2); s.post('Read', { file_path: 'a.js' }); s.post('Read', { file_path: 'b.js' });
  });
  assert.ok(has(r, 'memory-cut'));
  const n = run((s) => { s.start(); s.post('Read', { file_path: 'a.js' }); s.ev('compact.post', {}); s.adv(2); s.post('Read', { file_path: 'c.js' }); s.post('Read', { file_path: 'd.js' }); });
  assert.ok(!has(n, 'memory-cut'));
  const late = run((s) => { s.start(); s.post('Read', { file_path: 'a.js' }); s.post('Read', { file_path: 'b.js' }); s.ev('compact.post', {}); s.adv(30); s.post('Read', { file_path: 'a.js' }); s.post('Read', { file_path: 'b.js' }); });
  assert.ok(!has(late, 'memory-cut'));
});

test('refusal: permission denied and rejecting prompt fire; neutral prompt does not', () => {
  assert.ok(has(run((s) => { s.start(); s.ev('permission.denied', { tool: 'Bash', input: { command: 'rm -rf x' } }); }), 'refusal'));
  assert.ok(has(run((s) => { s.start(); s.prompt("don't touch the schema"); }), 'refusal'));
  assert.ok(!has(run((s) => { s.start(); s.prompt('please touch the schema'); }), 'refusal'));
});

test('wait: >30 min after asking the human fires; 5 min does not', () => {
  const mk = (gap) => run((s) => { s.start(); s.ev('permission.request', { tool: 'Bash' }); s.adv(gap); s.prompt('ok go ahead'); });
  assert.ok(has(mk(45), 'wait'));
  assert.ok(!has(mk(5), 'wait'));
  assert.equal(mk(45).moments.find((m) => m.kind === 'wait').score, 20);
});

test('escalation: switching up during a fight fires; switching up with no fight does not; down never', () => {
  const up = (fight, to = 'claude-opus-5-5') => run((s) => {
    s.start();
    if (fight) { s.bash('npm test', { ok: false, out: JEST_RED(1) }); s.bash('npm test', { ok: false, out: JEST_RED(1) }); }
    s.ev('model.post', { from: 'claude-sonnet-5-5', to });
  });
  assert.ok(has(up(true), 'escalation'));
  assert.ok(!has(up(false), 'escalation'));
  assert.ok(!has(up(true, 'claude-haiku-5-5'), 'escalation'));
});

test('mark: creates a 100-score moment, or confirms a fresh auto moment; dismiss lowers that detector weight', () => {
  const r = run((s) => { s.start(); s.prompt('hello'); s.ev('mark', { note: 'this is the bit' }, { actor: 'human' }); });
  const m = r.moments.find((x) => x.kind === 'mark');
  assert.equal(m.score, 100); assert.equal(m.headline, 'this is the bit');
  const c = run((s) => { s.start(); s.prompt('wait, undo that'); s.ev('mark', { note: 'good one' }, { actor: 'human' }); });
  assert.ok(!c.kinds.includes('mark')); assert.equal(c.moments.find((x) => x.kind === 'reversal').score, 100);
  const d = run((s) => { s.start(); s.prompt('wait, undo that'); s.ev('dismiss', {}, { actor: 'human' }); s.prompt('actually, no'); });
  assert.equal(d.moments.find((x) => x.kind === 'reversal' && x.status === 'dismissed').score, 0);
  assert.equal(d.eng.weight('reversal'), 0.9);
  assert.equal(d.moments.find((x) => x.kind === 'reversal' && x.status === 'auto').score, 54);
});

test('moment ids are deterministic across replays', () => {
  const f = (s) => { s.start(); s.prompt('wait no'); s.bash('git revert HEAD'); };
  const a = run(f), b = (() => { const { sim } = run(f); const { Engine } = a.eng.constructor ? { Engine: a.eng.constructor } : {}; const e = new Engine(); for (const ev of sim.events) e.push(structuredClone(ev)); return e; })();
  assert.deepEqual([...a.eng.moments.keys()], [...b.moments.keys()]);
});

test('commands that merely mention git or test runners (heredocs, quoted strings) never fire detectors', () => {
  const r = run((s) => {
    s.start();
    s.bash('cat > t.mjs <<\'EOF\'\ntest("x", () => run("git revert HEAD && git reset --hard HEAD~1 && fly deploy"))\nEOF');
    s.bash('echo "git revert HEAD; npm test"');
    s.bash('git commit -m "revert the old limiter"', { git: { branch: 'feature/x', subject: 'revert the old limiter' } });
  });
  assert.deepEqual(r.kinds, []);
  const w = run((s) => { s.start(); s.bash('bash -c "git revert HEAD"'); });
  assert.ok(w.kinds.includes('reversal'), 'bash -c is unwrapped');
});
test('quoted hedge words and abbreviations do not open threads', async () => {
  const { hedgeSentence } = await import('../src/lib/parse.mjs');
  assert.equal(hedgeSentence('Do not register hooks e.g. the "for now" kind.'), null);
  assert.match(hedgeSentence('Done. We store it in memory for now, and will revisit later. Next.'), /^We store it in memory for now/);
  assert.equal(hedgeSentence('Fine. TODO'), null);
  assert.equal(hedgeSentence('I need to see it live to be good enough to pickup interesting stuff from a session.'), null);
  assert.equal(hedgeSentence('The first draft is not good enough for anyone to read.'), null);
  assert.match(hedgeSentence('Leave the parser as it is, it is good enough for now.'), /good enough for now/);
  assert.match(hedgeSentence("Skip the cache, that's good enough."), /good enough/);
  assert.equal(hedgeSentence('Now `"it\'s good enough"` and "good enough for now" still count as hedges.'), null);
  assert.equal(hedgeSentence('The rule: “keep it for now unless asked” applies to drafts.'), null);
  assert.match(hedgeSentence('I wrote "the parser" and it is fine for now, we can revisit.'), /for now/);
});

test('real-project regressions: a command that only mentions deploy is not a ship; a deploy segment is', () => {
  for (const cmd of ['grep -n "deploy" scripts/deploy-changes.ts', 'ls .claude/skills/lst-deploy', 'cat public/deploy.txt', 'LAST_DEPLOY=$(cat .last-deploy-date); echo $LAST_DEPLOY', 'sed -n 1,9p scripts/deploy-changes.ts'])
    assert.ok(!has(run((s) => { s.start(); s.bash(cmd); }), 'shipped'), cmd);
  const r = run((s) => { s.start(); s.bash('cd app && LOG=1 npm run deploy:changes'); });
  assert.equal(r.moments.find((m) => m.kind === 'shipped').headline, 'Deployed: npm run deploy:changes');
});

test('real-project regressions: a long report that mentions a problem later is not a pushback; a verdict that pushes back is', () => {
  const noise = run((s) => {
    s.start();
    s.stop('Done so far: the price fix and the draft guard are committed and ready.');
    s.adv(2); s.subStart('r1', 'researcher', 'researcher');
    s.subStop('r1', 'researcher', 'Batch 6 is done: 18 tools published.\nTwo logos may be missing a dark variant and 12 rows failed to scrape.');
  });
  assert.ok(!has(noise, 'disagreement'), 'the verdict is positive; problems later in a report do not count');
  const json = run((s) => { s.start(); s.stop('The plan is complete.'); s.subStop('r2', 'researcher', '{"plan": "missing", "status": "rejected"}'); });
  assert.ok(!has(json, 'disagreement'), 'structured output has no verdict');
  const unrelated = run((s) => { s.start(); s.stop('The deploy script is ready.'); s.subStop('r3', 'auditor', 'Rejected: the invoice template is missing a footer.'); });
  assert.ok(!has(unrelated, 'disagreement'), 'a pushback about something else is not a disagreement');
});

test('real-project regressions: a dependency swap names only packages, never shell plumbing', () => {
  const r = run((s) => { s.start(); s.bash('npm uninstall ai @ai-sdk/anthropic 2>&1 | tail -3'); s.adv(2); s.bash('npm i better-sqlite3@^11.0.0 && git diff package.json; grep -n "x" package.json | head'); });
  assert.equal(r.moments.find((m) => m.kind === 'pivot').headline, 'Swapped ai, @ai-sdk/anthropic for better-sqlite3');
  assert.ok(!has(run((s) => { s.start(); s.bash('npm uninstall 2>&1 | tail'); s.adv(1); s.bash('npm i dayjs'); }), 'pivot'), 'nothing removed, nothing swapped');
});

test('real-project regressions: the same deploy repeated within hours is one ship, not six', () => {
  const r = run((s) => { s.start(); for (let i = 0; i < 5; i++) { s.bash('npm run deploy:changes'); s.adv(60); } s.adv(60 * 7); s.bash('npm run deploy:changes'); });
  const ships = r.moments.filter((m) => m.kind === 'shipped');
  assert.equal(ships.filter((m) => m.score >= 50).length, 2, 'the first, and the next one after a 6-hour gap');
  assert.equal(ships.length, 6, 'repeats are still recorded, under the feed threshold');
});

const VT = (pass, fail = 0) => ` Test Files  1 passed (1)\n      Tests  ${fail ? `${fail} failed | ` : ''}${pass} passed (${pass + fail})`;
test('real-project regressions: tests are keyed on the run itself, not on a shared `cd "<project>" &&` prefix', () => {
  const cd = 'cd "/c/Users/me/projects/app one" && ';
  const across = run((s) => { s.start(); s.bash(cd + 'npx vitest run packages/cli 2>&1 | tail -30', { out: VT(13) }); s.adv(1); s.bash(cd + 'npx vitest run packages/analysis 2>&1 | tail -40', { out: VT(17, 2) }); });
  assert.ok(!has(across, 'broke'), 'a green run of one package and a red run of another are different targets');
  const same = run((s) => { s.start(); s.bash(cd + 'npm test 2>&1 | tail -6', { out: VT(313) }); s.adv(5); s.bash(cd + 'npx tsc -b && npm test 2>&1 | grep -E "Tests"', { out: VT(312, 1) }); });
  assert.equal(same.moments.find((m) => m.kind === 'broke').headline, 'Tests went red: npm test');
});

test('real-project regressions: new tests failing on their first run are not a regression', () => {
  const r = run((s) => { s.start(); s.bash('npx vitest run packages/cli', { out: VT(13) }); s.adv(1); s.bash('npx vitest run packages/cli', { ok: false, out: VT(44, 1) }); });
  assert.ok(!has(r, 'broke'), '13 green, then 45 with 1 failing: a new test, not a break');
  const reg = run((s) => { s.start(); s.bash('npx vitest run packages/cli', { out: VT(313) }); s.adv(1); s.bash('npx vitest run packages/cli', { ok: false, out: VT(312, 2) }); });
  assert.ok(has(reg, 'broke'), 'one test added, two failing: something that passed broke');
});

test('real-project regressions: only a runner at the start of a segment is a test run; a pipe owns the exit code', () => {
  for (const c of ['ls vitest.config.* apps/web', 'cat jest.config.js && head -40 src/a.test.ts', 'grep -n vitest package.json']) assert.equal(testSegment(c), null, c);
  const hd = testSegment(`cd "/p" && python - <<'EOF'\nopen('x').write('npx vitest run nope')\nEOF\nnpx vitest run packages/video 2>&1 | tail -4`);
  assert.deepEqual(hd, { runner: 'vitest', seg: 'npx vitest run packages/video', last: false });
  assert.deepEqual(testSegment("cat > x.test.ts <<'EOF' && timeout 300 npx vitest run x\nit('a')\nEOF"), { runner: 'vitest', seg: 'npx vitest run x', last: true }, 'the rest of the heredoc line is still a command');
  assert.equal(testSegment('CI=1 pnpm exec jest --ci').runner, 'jest');
  assert.equal(testSegment('python -m pytest -q').runner, 'pytest');
  assert.equal(testInfo('npx vitest run 2>&1 | grep FAIL', '', false).red, null, 'grep found nothing: unknown, not red');
  assert.equal(testInfo('npx vitest run 2>&1 | grep FAIL', ' FAIL  src/a.test.ts > adds', true).red, true);
  assert.equal(testInfo('npx vitest run 2>&1 | tail -3', 'Tests  9 passed (9)', false).red, false, 'counts win over the exit code');
  assert.equal(testInfo('npx vitest run', '', false).red, true, 'the runner alone: its exit code counts');
});

const NODE_RED = '  ✖ refills tokens (3ms)\n    code: \'ERR_ASSERTION\',\n    expected: 5,';
test('test verdicts read the runner output: node spec counts, and failure lines after `| tail`', () => {
  assert.deepEqual(testInfo('npm test', 'ℹ tests 3\nℹ pass 2\nℹ fail 1', true).fail, 1);
  assert.equal(testInfo('npm test 2>&1 | tail -15', NODE_RED, true).red, true);
  assert.equal(testInfo('npm test 2>&1 | tail -3', 'ℹ pass 3\nℹ fail 0', true).red, false);
  assert.equal(testInfo('npm test | tail', 'done', true).red, null, 'nothing tells: unknown');
  const old = { kind: 'tool.post', d: { tool: 'Bash', input: { command: 'npm test | tail' }, out: NODE_RED, test: { runner: 'npm-test', seg: 'npm test', last: false, red: null } } };
  assert.equal(run(() => {}).eng.testOf(old).red, true, 'reindex re-reads events captured with no verdict');
});

test('misread: "I meant ..." fires, scored higher right after a confident answer; ordinary prompts do not', () => {
  const r = run((s) => { s.start(); s.prompt('make the status line on by default'); s.stop('Done: it is now enabled for every project.'); s.prompt('I meant if this can be on by default for the plugin?'); });
  const m = r.moments.find((x) => x.kind === 'misread');
  assert.ok(m && m.evidence.after_confident);
  assert.equal(m.score, 65);
  assert.equal(run((s) => { s.start(); s.prompt('no, I meant the other file'); }).moments.find((x) => x.kind === 'misread').score, 55);
  for (const p of ['what did you mean by arcs?', 'add a test that "I meant" is handled', 'rename meantime to interim']) assert.ok(!has(run((s) => { s.start(); s.prompt(p); }), 'misread'), p);
});

test('frustration fires on your own words, not on pasted logs, code or quotes', () => {
  assert.ok(has(run((s) => { s.start(); s.prompt('it doesn\'t show anything. This means it doesn\'t work or I\'m not understanding the damn thing'); }), 'frustration'));
  assert.ok(has(run((s) => { s.start(); s.prompt('still failing with the same error'); }), 'frustration'));
  for (const p of ['fix the upload bug, the log says ```\nError: not working\n```', 'search the logs for "not working"', '<pasted_content id="x">ugh this still fails</pasted_content> summarise this', 'add retries to the uploader']) assert.ok(!has(run((s) => { s.start(); s.prompt(p); }), 'frustration'), p);
  assert.ok(!has(run((s) => { s.start(); s.prompt('no, I meant the dashboard, damn'); }), 'frustration'), 'a misread that is also frustrated is one moment');
});

test('recurring: a test that failed in an earlier session fails again; one moment per session, scored by sessions', () => {
  const r = run((s) => {
    for (const sid of ['a', 'b', 'c']) {
      s.sid = sid; s.start();
      s.bash('npm test', { ok: false, out: NODE_RED }); s.adv(1);
      s.bash('npm test', { ok: false, out: NODE_RED }); s.adv(1);
      s.bash('npm test', { out: 'ℹ pass 3\nℹ fail 0' }); s.adv(60 * 24);
    }
  });
  const rec = r.moments.filter((m) => m.kind === 'recurring');
  assert.deepEqual(rec.map((m) => [m.sid, m.evidence.sessions, m.score]), [['b', 1, 55], ['c', 2, 65]]);
  assert.match(rec[1].headline, /refills tokens.*2 earlier sessions/);
  assert.ok(!has(run((s) => { s.start(); s.bash('npm test', { ok: false, out: NODE_RED }); s.bash('npm test', { ok: false, out: NODE_RED }); }), 'recurring'), 'the same session is not a recurrence');
});

let pid = 1000;
const CRASH = (proc, sig) => `A process crashed on this machine and I want to know why.\n\nWhat systemd-coredump recorded:\n  process:  ${proc}\n  PID:      ${pid += 7919}\n  binary:   /usr/bin/${proc}\n  signal:   ${sig}\n\nUse the diagnose-crash skill: it covers how to investigate, what to report, and when a crash is worth reporting upstream.`;
test('recurring from prompts: the same problem opening a later session, but not a different subject in the same template', () => {
  const r = run((s) => {
    for (const [sid, p] of [['a', CRASH('wireplumber', 'SIGSEGV')], ['b', CRASH('chromium', 'SIGTRAP')], ['c', CRASH('wireplumber', 'SIGSEGV')], ['d', CRASH('wireplumber', 'SIGSEGV')]]) { s.sid = sid; s.start(); s.prompt(p); s.adv(60 * 24); }
  });
  const rec = r.moments.filter((m) => m.kind === 'recurring');
  assert.deepEqual(rec.map((m) => [m.sid, m.evidence.via, m.evidence.sessions, m.score]), [['c', 'prompt', 1, 55], ['d', 'prompt', 2, 65]]);
  assert.match(rec[0].headline, /^Back with the same problem \(wireplumber, sigsegv\): “A process crashed on this machine and I want to know why\.”, also in 1 earlier session$/);
  assert.deepEqual(rec[0].actors, ['human']);
  // A habitual opener is not a problem, and only a session's first prompt is a fingerprint.
  const opener = 'resume the work from handover.md, read the checklist, then pick the next unchecked item and build it';
  assert.ok(!has(run((s) => { for (const sid of ['a', 'b']) { s.sid = sid; s.start(); s.prompt(opener); s.adv(60); } }), 'recurring'));
  assert.ok(!has(run((s) => { s.sid = 'a'; s.start(); s.prompt(CRASH('wireplumber', 'SIGSEGV')); s.adv(60); s.sid = 'b'; s.start(); s.prompt('add a dark mode toggle'); s.prompt(CRASH('wireplumber', 'SIGSEGV')); }), 'recurring'));
});

test('recurring from errors: the same normalized error in a failed command or a pasted log in a later session', () => {
  const out = (n) => `node:internal/modules/cjs/loader:${n}\n  throw err;\nError: Cannot find module '/home/u/app/dist/server-${n}.js'\n    at Module._resolveFilename (node:internal:${n}:15)`;
  const r = run((s) => {
    s.sid = 'a'; s.start(); s.bash('node dist/server.js', { ok: false, out: out(1) }); s.adv(60 * 24);
    s.sid = 'b'; s.start(); s.bash('node dist/server.js', { ok: false, out: out(2) }); s.bash('node dist/server.js', { ok: false, out: out(3) }); s.adv(60 * 24);
    s.sid = 'c'; s.start(); s.prompt(`the server will not start:\n${out(4)}`);
  });
  const rec = r.moments.filter((m) => m.kind === 'recurring');
  assert.deepEqual(rec.map((m) => [m.sid, m.evidence.via, m.evidence.sessions]), [['b', 'error', 1], ['c', 'error', 2]]);
  assert.match(rec[0].headline, /^Same error again: Error: Cannot find module 'server-N\.js'/);
  // A test run's assertion output and a successful command are not error signatures.
  assert.ok(!has(run((s) => { for (const sid of ['a', 'b']) { s.sid = sid; s.start(); s.bash('cat log.txt', { out: 'TypeError: x is not a function' }); s.adv(60); } }), 'recurring'));
});

test('errorSigs: exception lines, TypeScript and rustc codes, normalized; source code and assertions ignored', async () => {
  const { errorSigs } = await import('../src/lib/parse.mjs');
  assert.deepEqual(errorSigs('src/a.ts(12,5): error TS2345: Argument of type \'number\' is not assignable'), ['error TS2345: Argument of type \'number\' is not assignable']);
  assert.deepEqual(errorSigs('error[E0382]: borrow of moved value: `v`\n --> src/main.rs:4:5'), ['error[E0382]: borrow of moved value: `v`']);
  assert.deepEqual(errorSigs('Traceback (most recent call last):\n  File "x.py", line 3\nKeyError: \'user_42\''), ['KeyError: \'user_N\'']);
  assert.deepEqual(errorSigs('  throw new TypeError("bad")\nAssertionError [ERR_ASSERTION]: Expected values to be strictly equal'), []);
});

test('recurring survives a retention trim: the failure history is in the snapshot', async () => {
  const { Engine } = await import('../src/lib/engine.mjs');
  const { sim, eng } = run((s) => {
    for (const sid of ['a', 'b', 'c']) { s.sid = sid; s.start(); s.bash('npm test', { ok: false, out: NODE_RED }); s.adv(60 * 24); }
  });
  const snap = eng.snapshot(['a', 'b'], Date.parse(sim.events.find((e) => e.sid === 'c').ts) - 1);
  const e2 = new Engine(); e2.restore(snap);
  for (const e of sim.events.filter((x) => x.sid === 'c')) e2.push(structuredClone(e));
  assert.equal(e2.listMoments().find((m) => m.kind === 'recurring' && m.sid === 'c').evidence.sessions, 2);
});

test('hotspots: files ranked by struggles, corrections, red runs after an edit and edits; paths made relative; areas count a moment once', async () => {
  const { Engine } = await import('../src/lib/engine.mjs');
  const { sim, eng } = run((s) => {
    s.sid = 'a'; s.start();
    s.call('Edit', { file_path: '/work/app/src/lib/limiter.js' }); s.call('Edit', { file_path: '/work/app/src/lib/clock.js' }); s.adv(1);
    for (let i = 0; i < 3; i++) { s.bash('npm test', { ok: false, out: JEST_RED(1) }); s.adv(2); }
    s.bash('npm test', { out: JEST_GREEN }); s.adv(1);
    s.call('Edit', { file_path: '/work/app/theme.css' }); s.adv(60);
    s.call('Edit', { file_path: '/work/app/theme.css' }); s.call('Edit', { file_path: '/work/app/README.md' }); s.adv(1);
    s.prompt('no, don\'t touch the theme'); s.adv(60 * 24);
    s.sid = 'b'; s.start(); s.call('Edit', { file_path: '/work/app/src/lib/limiter.js', old_string: 'x' }, { ok: false }); s.adv(60 * 24);
    s.sid = 'c'; s.demo = true; s.start(); s.call('Edit', { file_path: '/work/app/demo.js' }); s.demo = false;
    s.sid = 'd'; s.start(); s.bash('cd src && sed -i \'s/a/b/\' ../README.md lib/clock.js && npm test 2>&1 | tee /tmp/t.log');
    for (const sid of ['d', 'e']) { s.sid = sid; s.bash('git commit -m "x"', { git: { branch: 'feat', sha: 'abc123', subject: 'x', files: ['README.md'] } }); }
  });
  const H = eng.hotspots('/work/app');
  const row = (f) => H.files.find((r) => r.file === f);
  assert.deepEqual(H.files.map((r) => r.file), ['src/lib/limiter.js', 'src/lib/clock.js', 'theme.css', 'README.md']);
  assert.deepEqual([row('src/lib/limiter.js').struggles, row('src/lib/limiter.js').fails, row('src/lib/limiter.js').edits, row('src/lib/limiter.js').sessions], [1, 4, 1, 2]);
  assert.deepEqual([row('theme.css').corrections, row('theme.css').edits], [1, 2]);
  // Shell writes count as edits (relative to their `cd`, temp files left out); one commit seen in two sessions counts once.
  // Docs and config never take the blame for a nearby moment or red run.
  assert.deepEqual([row('README.md').corrections, row('README.md').struggles, row('README.md').edits, row('README.md').commits], [0, 0, 2, 1]);
  assert.deepEqual([row('src/lib/clock.js').edits, H.total], [2, 4]);
  const lib = H.areas.find((a) => a.area === 'src/lib');
  assert.deepEqual([lib.files, lib.struggles, H.areas[H.areas.length - 1].area], [2, 1, '(top level)']);
  // Trimmed sessions keep their counts through the snapshot, without double counting the sessions that replay.
  const snap = eng.snapshot(['a'], Date.parse(sim.events.find((e) => e.sid === 'b').ts) - 1);
  const e2 = new Engine(); e2.restore(snap);
  for (const e of sim.events.filter((x) => x.sid !== 'a')) e2.push(structuredClone(e));
  assert.deepEqual(e2.hotspots('/work/app'), H);
});

test('writtenFiles: redirects, tee, sed -i, perl -pi and script writes, joined to the cd; reads, temp and device paths are not writes', async () => {
  const { writtenFiles: w } = await import('../src/lib/parse.mjs');
  assert.deepEqual(w("cd /r && sed -i 's/x/y/' src/a.mjs lib/b.mjs"), ['/r/src/a.mjs', '/r/lib/b.mjs']);
  assert.deepEqual(w("cat > notes.md <<'EOF'\nhello > not-a-file\nEOF"), ['notes.md']);
  assert.deepEqual(w("python3 - <<'EOF'\np='src/a.mjs'; s=open(p).read()\nopen(p,'w').write(s)\nopen(\"b.txt\", 'a')\nEOF"), ['b.txt', 'src/a.mjs']);
  assert.deepEqual(w("npm test 2>&1 | tee test.log; perl -pi -e 's/a/b/' x.pl"), ['test.log', 'x.pl']);
  assert.deepEqual(w("cat >> a.mjs <<'EOF'\n// open('f', 'w') in source text is not run\nEOF"), ['a.mjs']);
  assert.deepEqual(w(`node -e "const f = 'x.json'; fs.writeFileSync(f, s)"`), ['x.json']);
  for (const c of ['sed -n 1,5p a.js', 'echo hi >> /tmp/x; ls > /dev/null 2>&1', 'echo $X > "$OUT"', "python3 -c \"p=open('a').read()\"", 'cmd >&2', 'cd $S && sed -i x h2']) assert.deepEqual(w(c), [], c);
});

test('detour: after a real failure, two edits in an area the turn had not touched and the prompt does not name', () => {
  const E = (s, f) => s.call('Edit', { file_path: `/work/app/${f}` });
  const quest = (prompt, after, { fail = { ok: false, out: JEST_RED(1) }, cmd = 'npm test' } = {}) => run((s) => {
    s.start(); s.prompt(prompt);
    E(s, 'src/upload/client.js'); E(s, 'src/upload/retry.js'); s.adv(1);
    s.bash(cmd, fail); s.adv(1);
    after(s);
  });
  const r = quest('add retries to the uploader', (s) => { E(s, 'src/auth/token.js'); E(s, 'src/auth/session.js'); E(s, 'src/auth/token.js'); });
  const d = r.moments.filter((m) => m.kind === 'detour');
  assert.equal(d.length, 1, 'one per turn');
  assert.match(d[0].headline, /^Side quest: a failure while working in src\/upload led to edits in src\/auth$/);
  assert.deepEqual(d[0].evidence.files, ['src/auth/token.js', 'src/auth/session.js']);
  assert.deepEqual(d[0].files, ['/work/app/src/auth/token.js', '/work/app/src/auth/session.js']);
  // Not a side quest: the prompt names the area, only companion files change, one edit, or the turn's own area.
  assert.ok(!has(quest('add retries to the uploader and refresh the auth token', (s) => { E(s, 'src/auth/token.js'); E(s, 'src/auth/session.js'); }), 'detour'));
  assert.ok(!has(quest('add retries to the uploader', (s) => { E(s, 'test/upload.test.js'); E(s, 'README.md'); E(s, 'docs/retries.md'); E(s, 'package.json'); }), 'detour'));
  assert.ok(!has(quest('add retries to the uploader', (s) => { E(s, 'src/auth/token.js'); }), 'detour'));
  assert.ok(!has(quest('add retries to the uploader', (s) => { E(s, 'src/upload/client.js'); E(s, 'src/upload/queue.js'); }), 'detour'));
  // `grep` finding nothing is not a failure; a red run before any edit gives the turn no focus yet.
  assert.ok(!has(quest('add retries to the uploader', (s) => { E(s, 'src/auth/token.js'); E(s, 'src/auth/session.js'); }, { cmd: 'grep -rn retry src', fail: { ok: false, out: '' } }), 'detour'));
  assert.ok(!has(run((s) => { s.start(); s.prompt('fix the failing upload test'); s.bash('npm test', { ok: false, out: JEST_RED(1) }); E(s, 'src/upload/client.js'); E(s, 'src/auth/token.js'); E(s, 'src/auth/session.js'); }), 'detour'));
  // A new prompt is a new turn.
  assert.ok(!has(quest('add retries to the uploader', (s) => { s.prompt('now look at auth'); E(s, 'src/auth/token.js'); E(s, 'src/auth/session.js'); }), 'detour'));
});

test('recap: the latest real session, its last request, red tests, open streaks, recurring problems and an unanswered closing question', () => {
  const { eng } = run((s) => {
    s.sid = 'a'; s.start(); s.prompt('fix the limiter'); s.bash('npm test', { ok: false, out: NODE_RED }); s.adv(60 * 24);
    s.sid = 'b'; s.start(); s.prompt('make the limiter pass again\nmore detail');
    s.bash('npm test', { ok: false, out: NODE_RED }); s.bash('npm run lint', { out: 'ℹ pass 1\nℹ fail 0' });
    s.bash('npm run build', { ok: false, out: 'Error: Cannot find module x' }); s.bash('npm run build', { ok: false, out: 'Error: Cannot find module x' });
    s.stop('I changed the refill.\n\nShould I keep the old refill logic?'); s.adv(60);
    s.sid = 'c'; s.demo = true; s.start(); s.prompt('demo'); s.demo = false;
  });
  const r = eng.recap();
  assert.equal(r.sid, 'b');
  assert.equal(r.prompt, 'make the limiter pass again');
  assert.deepEqual(r.failing, [{ seg: 'npm test', fail: null, names: ['refills tokens'] }]);
  assert.deepEqual(r.streaks, ['2 failed attempts at npm run build so far']);
  assert.match(r.recurring[0], /^Failing again: refills tokens/);
  assert.equal(r.question, 'Should I keep the old refill logic?');
  // Green again, an answered question, or a question mid-answer: nothing left hanging.
  const done = run((s) => { s.start(); s.prompt('fix it'); s.bash('npm test', { ok: false, out: NODE_RED }); s.bash('npm test', { out: 'ℹ pass 3\nℹ fail 0' }); s.stop('Is this right? I checked.\n\nAll green now.'); }).eng.recap();
  assert.deepEqual([done.failing, done.question], [[], null]);
  const narrow = run((s) => { s.start(); s.prompt('fix it'); s.bash('node --test --test-name-pattern="refill" test/a.test.mjs', { ok: false, out: NODE_RED }); s.bash('npm test', { out: 'ℹ pass 3\nℹ fail 0' }); }).eng.recap();
  assert.deepEqual(narrow.failing, [], 'a green whole-suite run settles a narrower red one');
});

test('wholeSuite: the runner alone (or with flags) is the whole suite; files, packages and name filters narrow it', async () => {
  const { wholeSuite: w } = await import('../src/lib/parse.mjs');
  for (const s of ['npm test', 'npm run test', 'pnpm -w x test', 'node --test', 'node --test-concurrency=1 --test', 'go test ./...', 'cargo test', 'pytest -x -q', 'npx vitest run', 'npm test -- --coverage']) assert.ok(w(s), s);
  for (const s of ['node --test test/a.test.mjs', 'node --test --test-name-pattern="x"', 'pytest tests/test_a.py', 'pytest -k refill', 'go test ./pkg/limiter', 'npx vitest run src/a.test.ts', 'jest -t refill', 'cargo test refill']) assert.ok(!w(s), s);
});

test('repeated request: the same ask after the agent had a turn is frustration; follow-ups, quick resends and old asks are not', () => {
  const ask = (a, b, { stop = true, gap = 5 } = {}) => run((s) => { s.start(); s.prompt(a); s.adv(1); if (stop) s.stop('Added it.'); s.adv(gap); s.prompt(b); });
  const r = ask('add a dark mode toggle to the settings page', 'can you add the dark mode toggle to the settings page please');
  const f = r.moments.find((m) => m.kind === 'frustration');
  assert.match(f.headline, /^You asked for the same thing again/);
  assert.equal(f.evidence.repeat_of, 'add a dark mode toggle to the settings page');
  assert.ok(!has(ask('add a dark mode toggle', 'make the dark mode toggle remember the choice across reloads'), 'frustration'), 'a follow-up');
  assert.ok(!has(ask('add a dark mode toggle to the settings page', 'add a dark mode toggle to the settings page', { stop: false }), 'frustration'), 'no turn in between');
  assert.ok(!has(ask('add a dark mode toggle to the settings page', 'add a dark mode toggle to the settings page', { gap: 90 }), 'frustration'), 'over an hour later');
  assert.ok(!has(ask('continue', 'continue'), 'frustration'), 'too short to say');
  const both = ask('add a dark mode toggle to the settings page', 'ugh, add the dark mode toggle to the settings page');
  assert.equal(both.moments.find((m) => m.kind === 'frustration').score, 55, 'impatient and repeated');
});

test('masked build failures: tsc or a build behind `| tail` that printed errors counts as a failed attempt; grep for the same text does not', async () => {
  const TS = 'src/a.ts(3,5): error TS2345: Argument of type number is not assignable\nFound 1 error.';
  const r = run((s) => { s.start(); for (let i = 0; i < 3; i++) { s.bash('npx tsc --noEmit 2>&1 | tail -20', { out: TS }); s.adv(2); } s.bash('npx tsc --noEmit 2>&1 | tail -20', { out: '' }); });
  assert.match(r.moments.find((m) => m.kind === 'fight').headline, /^3 failed attempts at npx tsc --noEmit/);
  assert.ok(!has(run((s) => { s.start(); for (let i = 0; i < 4; i++) s.bash('grep -rn "error TS" src | tail', { out: TS }); s.bash('grep -rn "error TS" src | tail', { out: '' }); }), 'fight'));
  const { maskedBuildFailure: b } = await import('../src/lib/parse.mjs');
  assert.equal(b('cargo build 2>&1 | tail', 'error[E0382]: borrow of moved value'), 'error[E0382]: borrow of moved value');
  assert.equal(b('npm install left-pad || true', 'npm ERR! code E404'), 'npm ERR! code E404');
  assert.equal(b('python3 -m mypy src | tail', 'src/a.py:3: error: Incompatible types'), 'src/a.py:3: error: Incompatible types');
  for (const [c, o] of [['npx tsc --noEmit', TS], ['npx tsc && echo ok', TS], ['npm run build | tail', 'built in 2s'], ['cat build.log | tail', TS]]) assert.equal(b(c, o), null, c);
});
