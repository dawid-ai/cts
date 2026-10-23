// Classification of Bash commands: tests, git operations, deploys, dependency changes.
/**
 * The command as the shell would execute it: heredoc bodies and quoted strings removed, `bash -c '...'` unwrapped.
 * Classifiers run on this so `echo "git revert"` or a heredoc that writes a test file never counts as an action.
 */
export function skeleton(cmd) {
  let c = String(cmd || '');
  const wrap = /\b(?:bash|sh|zsh)\s+-l?c\s+(["'])([\s\S]*)\1\s*$/.exec(c);
  if (wrap) c = wrap[2];
  // The body goes; the rest of the opening line (`<<'EOF' && npx vitest`) and the newline after the delimiter stay.
  c = c.replace(/<<-?\s*(["']?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2(?=\n|$)/g, ' $3');
  c = c.replace(/<<-?\s*(["']?)(\w+)\1([^\n]*)\n[\s\S]*$/, ' $3');
  c = c.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'[^']*'/g, "''");
  return c;
}

// Anchored at the start of a shell segment: `ls vitest.config.*` or `cat jest.setup.js` is not a test run.
const TEST_RUNNERS = [
  ['pytest', /^(?:pytest|py\.test)\b/],
  ['vitest', /^vitest(?![.\w-])/],
  ['jest', /^jest(?![.\w-])/],
  ['go', /^go\s+test\b/],
  ['cargo', /^cargo\s+(?:test|nextest)\b/],
  ['rspec', /^rspec\b/],
  ['dotnet', /^dotnet\s+test\b/],
  ['node', /^node\s+(?:--[\w-]+(?:=\S+)?\s+)*--test\b/],
  ['npm-test', /^(?:npm|pnpm|yarn|bun)\s+(?:(?:-w|--workspace)\s+\S+\s+)?(?:run\s+)?test\b/],
  ['make-test', /^make\s+(?:test|check)\b/],
  ['tox', /^tox\b/],
];
const SEG_PREFIX = /^(?:(?:export\s+)?[A-Za-z_]\w*=\S*\s+|(?:time|nice|sudo)\s+|timeout\s+\S+\s+|env\s+)+/;
const RUNNER_PREFIX = /^(?:npx|bunx|pnpx|(?:pnpm|yarn)\s+(?:exec|dlx)|bundle\s+exec|python3?\s+-m|uv\s+run|poetry\s+run)\s+/;
/**
 * The test run inside a command: `{runner, seg, last}`, or null. `seg` is the runner's segment with env, `timeout` and
 * redirections stripped (`npx vitest run packages/cli`); `last` says whether the command's exit code is the runner's.
 */
export function testSegment(cmd) {
  if (!cmd) return null;
  const parts = skeleton(cmd).split(/\s*(&&|\|\||;|\n|\|)\s*/);
  for (let i = 0; i < parts.length; i += 2) {
    const seg = parts[i].trim().replace(SEG_PREFIX, '');
    const bare = seg.replace(RUNNER_PREFIX, '');
    for (const [runner, re] of TEST_RUNNERS) {
      if (re.test(seg) || re.test(bare)) return { runner, seg: seg.replace(/\s*\d?>>?\s*(?:&\d|\S+)/g, '').trim(), last: i === parts.length - 1 };
    }
  }
  return null;
}
// Name filters and file arguments narrow a run; without them it is the whole suite.
const NARROW = /\s(?:--test-name-pattern|--testNamePattern|-t|-k|--grep|-g|-run|--filter|-m)\b/;
/** Whether a test segment runs the whole suite: no name filter and no positional (file or package) argument after the runner. */
export function wholeSuite(seg) {
  const s = String(seg || '').replace(RUNNER_PREFIX, '').replace(/\s+--(?=\s|$)/, ' ');
  if (NARROW.test(s + ' ')) return false;
  const rest = s.replace(/^(?:(?:npm|pnpm|yarn|bun)\s+(?:(?:-w|--workspace)\s+\S+\s+)?(?:run\s+)?test|node\s+(?:--[\w-]+(?:=\S+)?\s+)*--test|go\s+test|cargo\s+(?:test|nextest(?:\s+run)?)|dotnet\s+test|make\s+(?:test|check)|py\.?test|vitest(?:\s+run)?|jest|rspec|tox)\b/, '');
  return !rest.split(/\s+/).some((a) => a && !a.startsWith('-') && !/^(?:''|""|\.\/\.\.\.|\.\.\.|\.)$/.test(a));
}
export function testRunner(cmd) { const t = testSegment(cmd); return t ? t.runner : null; }
// A failure line survives `| tail`: node's `✖ failing tests:` and assertion details come after its summary.
const FAIL_MARK = /^\s*(?:FAIL|FAILED|×|✗|✕|✖)\s|^\s*Tests?:?\s+\d+ failed|\bAssertionError\b|\bERR_ASSERTION\b|^--- FAIL|^not ok \d/m;
/**
 * Red, green, or null when nothing tells: counts win, then a runner's failure line, then the exit code, but only when
 * it is the runner's own (not `| tail`, `| grep`, or a later `&& tsc`).
 */
export function testVerdict(ts, counts, out, ok) {
  if (counts && counts.total) return counts.fail > 0;
  if (FAIL_MARK.test(out || '')) return true;
  return ts.last ? !ok : null;
}
/** The `d.test` record for a Bash command and its output, or null when it runs no tests. */
export function testInfo(cmd, out, ok) {
  const ts = testSegment(cmd);
  if (!ts) return null;
  const c = parseCounts(out);
  return { ...ts, ...(c || {}), red: testVerdict(ts, c, out, ok) };
}

// One failing test per line, per runner: node spec, jest, vitest, pytest, go, cargo, rspec, TAP.
const FAILED_TEST = [
  /^\s*✖ (.+?) \(\d[\d.]*m?s\)\s*$/gm, /^\s*● (?!Console\b)(.+?)\s*$/gm, /^\s*(?:×|✗|FAIL)\s+(\S+\s+>\s+.+?)(?:\s+\d+m?s)?\s*$/gm,
  /^FAILED (\S+::\S+)/gm, /^--- FAIL: (\S+)/gm, /^test (\S+) \.\.\. FAILED/gm, /^rspec (\.\/\S+:\d+)/gm, /^not ok \d+ - (.+?)\s*$/gm,
];
/** Names of the failing tests in runner output (at most 5), the signature that follows a failure across sessions. */
export function failedTests(out) {
  const names = new Set();
  for (const re of FAILED_TEST) for (const m of String(out || '').matchAll(re)) if (!/^failing tests:?$/.test(m[1])) names.add(m[1].trim().slice(0, 120));
  return [...names].slice(0, 5);
}

/** Pull pass/fail counts out of runner output. Returns {pass,fail,total} or null. */
export function parseCounts(text) {
  if (!text) return null;
  const num = (m, i) => (m && m[i] != null ? Number(m[i]) : 0);
  let m;
  // cargo
  if ((m = /test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed/.exec(text))) return mk(num(m, 1), num(m, 2));
  // node --test (TAP `# pass`, spec reporter `ℹ pass`)
  const np = /^(?:#|ℹ) pass (\d+)/m.exec(text), nf = /^(?:#|ℹ) fail (\d+)/m.exec(text);
  if (np && nf) return mk(num(np, 1), num(nf, 1));
  // rspec
  if ((m = /(\d+) examples?, (\d+) failures?/.exec(text))) return mk(num(m, 1) - num(m, 2), num(m, 2));
  // dotnet
  if ((m = /Failed:\s+(\d+),\s+Passed:\s+(\d+)/.exec(text))) return mk(num(m, 2), num(m, 1));
  if ((m = /Passed!.*?Passed:\s+(\d+)/.exec(text))) return mk(num(m, 1), 0);
  // jest
  if ((m = /Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(?:(\d+) passed)/.exec(text))) return mk(num(m, 2), num(m, 1));
  // vitest
  if ((m = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(text))) return mk(num(m, 2), num(m, 1));
  // pytest
  const pp = /(\d+) passed/.exec(text), pf = /(\d+) failed/.exec(text);
  if (pp || pf) return mk(num(pp, 1), num(pf, 1));
  // go
  if (/^--- FAIL|^FAIL\b/m.test(text)) return mk((text.match(/^ok\s/gm) || []).length, (text.match(/^--- FAIL/gm) || []).length || 1);
  if (/^ok\s/m.test(text)) return mk((text.match(/^ok\s/gm) || []).length, 0);
  return null;
  function mk(pass, fail) { return { pass, fail, total: pass + fail }; }
}

const GIT_RE = /(?:^|[;&|(]\s*|\s)git(?:\s+-C\s+\S+|\s+-c\s+\S+)*\s+(commit|revert|reset|checkout|switch|merge|stash|tag|rebase|push|worktree|cherry-pick|rm)\b([^;&|\n]*)/;
/** The name `git tag <args>` creates, or null when the command lists, deletes or verifies tags. */
export function tagName(args) {
  const a = String(args || '').trim().split(/\s+/).filter(Boolean);
  if (!a.length || a.some((x) => /^(-l|--list|-d|--delete|-v|--verify|-n\d*|--contains|--points-at|--merged|--no-merged|--sort.*|--format.*)$/.test(x))) return null;
  for (let i = 0; i < a.length; i++) {
    if (/^-(m|F|u|-message|-file|-local-user)$/.test(a[i])) { i++; continue; }
    if (a[i].startsWith('-')) continue;
    return a[i].replace(/^["']|["']$/g, '') || null;
  }
  return null;
}
export function gitOp(cmd) {
  if (!cmd) return null;
  const sk = skeleton(cmd);
  if (/\bgh\s+pr\s+merge\b/.test(sk)) return { op: 'pr-merge', args: '' };
  const m = GIT_RE.exec(sk);
  if (!m) return null;
  const args = m[2].trim();
  if (/(^|\s)(--help|-h)(\s|$)/.test(args)) return null;
  return { op: m[1], args };
}

// A deploy is a command segment that STARTS with a deploy tool. A command that merely mentions "deploy" (grep deploy,
// cat deploy.txt, LAST_DEPLOY=...) is not one: on a real project that alone made most "shipped" moments false.
export const DEPLOY_RE = /^(?:sudo\s+)?(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?deploy(?::[\w-]+)?\b|(?:npm|pnpm|yarn)\s+publish\b|make\s+deploy\b|(?:(?:bash|sh)\s+)?\.?\/?[\w./-]*deploy[\w-]*\.sh\b|railway\s+up\b|vercel\s+(?:deploy\s+)?(?:\S+\s+)*--prod\b|netlify\s+deploy\s+(?:\S+\s+)*--prod\b|fly(?:ctl)?\s+deploy\b|firebase\s+deploy\b|wrangler\s+(?:deploy|publish)\b|(?:serverless|sls)\s+deploy\b|gcloud\s+(?:[\w-]+\s+)*deploy\b|git\s+push\s+heroku\b|kubectl\s+apply\b|helm\s+(?:upgrade|install)\b|terraform\s+apply\b|cargo\s+publish\b|twine\s+upload\b|docker\s+push\b)/;
/** The deploy segment of a (skeleton) command, or null. Env assignments and `cd` before it are skipped. */
export function deploySegment(cmd) {
  for (let seg of String(cmd || '').split(/\s*(?:&&|\|\||;|\n|\|)\s*/)) {
    seg = seg.trim().replace(/^(?:(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
    if (DEPLOY_RE.test(seg)) return seg;
  }
  return null;
}
export const DEP_REMOVE_RE = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:uninstall|remove|rm)|pip3?\s+uninstall|cargo\s+remove|poetry\s+remove|go\s+mod\s+edit\s+-droprequire)\b\s*(.*)/;
export const DEP_ADD_RE = /\b(?:(?:npm|pnpm|bun)\s+(?:install|add|i)|yarn\s+add|pip3?\s+install|cargo\s+add|poetry\s+add|go\s+get)\b\s*(.*)/;
export const RM_RE = /\b(?:git\s+rm|rm)\s+(?:-[a-zA-Z]+\s+)*([^;&|\n]+)/;

export const HEDGE_RE = /\b(for now|temporar(?:y|ily)|TODO|revisit|(?<!\b(?:be|not|n't) )good enough(?!\s+to\b)|quick hack|placeholder|come back to|not sure yet|punt(?:ing)?|for the time being)\b/i;
export const DECISIVE_RE = /\b(decid(?:ed|e)|let'?s (?:go|use|keep|do)|go(?:ing)? with|final(?:ly)?|settled|resolved|permanent(?:ly)?|make it (?:real|permanent|proper)|not temporary|keep it)\b/i;

/** Inside a "…", “…” or `…` span on its own line (apostrophes are not quotes). */
const quoted = (t, i) => {
  const ln = t.slice(t.lastIndexOf('\n', i - 1) + 1, i);
  return (ln.split('"').length - 1) % 2 === 1 || (ln.split('`').length - 1) % 2 === 1 || ln.lastIndexOf('“') > ln.lastIndexOf('”');
};
/** Sentence containing the hedge (<=200 chars), or null. Hedge words that are quoted or in code spans are discussion, not decisions. */
export function hedgeSentence(text) {
  const t = String(text || '');
  const re = new RegExp(HEDGE_RE.source, 'gi');
  let m;
  while ((m = re.exec(t))) {
    const before = t[m.index - 1], after = t[m.index + m[0].length];
    if (/["'`“‘]/.test(before || '') && /["'`”’]/.test(after || '')) continue;
    if (quoted(t, m.index)) continue;
    const sents = [];
    let pos = 0;
    for (const part of t.split(/(?<=[.!?])\s+|\n+/)) { const i = t.indexOf(part, pos); sents.push({ i, part }); pos = i + part.length; }
    const hit = sents.find((x) => m.index >= x.i && m.index < x.i + x.part.length);
    const sentence = (hit ? hit.part : t.slice(Math.max(0, m.index - 60), m.index + 100)).replace(/^[\s>*#-]+|\*\*/g, '').trim();
    if (sentence.length >= 15) return sentence.slice(0, 200);
  }
  return null;
}

const STOP = new Set(['the', 'this', 'that', 'with', 'for', 'now', 'and', 'will', 'use', 'using', 'used', 'temporary', 'temporarily', 'revisit', 'later', 'good', 'enough', 'todo', 'placeholder', 'quick', 'hack', 'come', 'back', 'sure', 'yet', 'time', 'being', 'have', 'from', 'into', 'just', 'here', 'there', 'then', 'than', 'also', 'need', 'needs', 'some', 'code', 'should', 'would', 'could']);
/** Topic tokens: file-like names and meaningful identifiers (>=4 chars). */
export function topicsOf(text) {
  const out = new Set();
  const t = String(text || '');
  for (const m of t.matchAll(/[\w./\\-]+\.[A-Za-z]{1,5}\b/g)) out.add(m[0].split(/[\\/]/).pop().toLowerCase());
  for (const m of t.matchAll(/\b[A-Za-z][A-Za-z0-9_]{3,}\b/g)) {
    const w = m[0].toLowerCase();
    if (!STOP.has(w)) out.add(w);
  }
  return [...out].slice(0, 12);
}

// Error lines that name a problem: an exception class with its message, TypeScript and rustc codes. Assertion errors are the test runner's, not a signature.
const ERROR_LINE = /(?:^|\):\s|\s-\s)\s*(?:Uncaught\s+)?((?!AssertionError\b)(?:[A-Z][A-Za-z]*)?(?:Error|Exception)|error TS\d{4,5}|error\[E\d{4}\])(?:\s*\[\w+\])?:\s*(\S.*?)\s*$/gm;
/** Normalized error signatures in output or a pasted log (at most 5): paths become basenames, numbers and hex become N, so the same error matches across runs. */
export function errorSigs(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(ERROR_LINE)) {
    const msg = m[2].replace(/(?:[A-Za-z]:)?[\w.~-]*[\\/][\w.\\/-]+/g, (p) => p.split(/[\\/]/).pop()).replace(/0x[0-9a-f]+|\d+/gi, 'N').slice(0, 100);
    if (msg.replace(/\W/g, '').length >= 3) out.add(`${m[1]}: ${msg}`);
  }
  return [...out].slice(0, 5);
}
// A prompt that brings a problem, as opposed to a habitual opener ("resume, check the handover").
export const PROBLEM_RE = /\b(crash(?:ed|es|ing)?|error|exception|fail(?:s|ed|ing|ure)?|broken|bug|segfault|SIG(?:SEGV|ABRT|BUS|ILL|TRAP|FPE|KILL)|panic(?:ked)?|traceback|(?:doesn'?t|does not|isn'?t|is not|not) work(?:ing)?|stopped working|hangs?|freez(?:e|es|ing)|core dump(?:ed)?)\b/i;
/** Every topic word of a prompt, uncapped: the fingerprint compared with other sessions' first prompts. */
export function promptTopics(text) {
  const out = new Set();
  for (const m of String(text || '').slice(0, 4000).matchAll(/\b[A-Za-z][A-Za-z0-9_]{3,}\b/g)) { const w = m[0].toLowerCase(); if (!STOP.has(w)) out.add(w); }
  return [...out].slice(0, 80);
}
/** Same problem asked again: 5+ shared topics, 80% overlap, and no swapped subject (one side's topics all appear in the other). */
export function sameAsk(a, b) {
  const B = new Set(b), shared = a.filter((x) => B.has(x)).length;
  return shared >= 5 && shared / (a.length + b.length - shared) >= 0.8 && (shared === a.length || shared === b.length);
}
const INTERP = /^(?:python3?|node|ruby|perl|bun|deno)\b/;
/** Files a shell command plainly writes (`> f`, `>> f`, `tee`, `sed -i`, `perl -pi`, `open('f', 'w')`, `writeFileSync('f'`), joined to its `cd`. Temp and device paths are left out. */
export function writtenFiles(cmd) {
  const out = new Set(), raw = String(cmd || '');
  let dir = '';
  const add = (f) => { f = f && dir && !/^(?:\/|~|[A-Za-z]:)/.test(f) ? `${dir}/${f.replace(/^\.\//, '')}` : f; if (f && !/^(?:&|-|''|""|\/dev\/|\/tmp\/|\/var\/(?:tmp|folders)\/)|\$/.test(f)) out.add(f); };
  for (const part of skeleton(raw).split(/\s*(?:&&|\|\||;|\n|\|)\s*/)) {
    const seg = part.trim().replace(SEG_PREFIX, ''), cd = /^cd\s+(\S+)$/.exec(seg);
    if (cd) { dir = /^(?:\/|~|[A-Za-z]:)/.test(cd[1]) || !dir ? cd[1] : `${dir}/${cd[1]}`; continue; }
    for (const r of seg.matchAll(/(?:^|[^\d&<>])>>?\s*([^\s<>&|;()]+)/g)) add(r[1]);
    const args = seg.split(/\s+/).slice(1).filter((x) => !x.startsWith('-') && !/^(?:''|"")$/.test(x) && !/[<>]/.test(x));
    if (/^tee\s/.test(seg)) args.forEach(add);
    else if (/^(?:sed\s+(?:-\S+\s+)*-[a-zA-Z]*i|perl\s+(?:-\S+\s+)*-p?i)/.test(seg)) args.forEach(add);
  }
  // Script writes count only in code an interpreter runs: a heredoc fed to it, or its -c/-e argument (not `cat > f <<EOF` source text).
  const scripts = [];
  for (const m of raw.matchAll(/^([^\n]*?)<<-?\s*(["']?)(\w+)\2[^\n]*\n([\s\S]*?)\n\s*\3(?=\n|$)/gm)) if (INTERP.test(m[1].split(/&&|\|\||;|\|/).pop().trim().replace(SEG_PREFIX, ''))) scripts.push(m[4]);
  for (const m of raw.matchAll(/(?:^|[;&|(]\s*)(?:python3?|node|ruby|perl|bun|deno)\s+(?:-\S+\s+)*?-[ce]\s+(["'])([\s\S]*?)\1/g)) scripts.push(m[2]);
  for (const code of scripts) {
    for (const m of code.matchAll(/\b(?:open\(\s*(['"])([^'"\n]+)\1\s*,\s*['"][wa]|writeFileSync\(\s*(['"])([^'"\n]+)\3)/g)) add(m[2] || m[4]);
    // `p = 'src/x.mjs'` … `open(p, 'w')`: the variable's nearest quoted assignment before the write.
    for (const m of code.matchAll(/\b(?:open\(\s*([A-Za-z_]\w*)\s*,\s*['"][wa]|writeFileSync\(\s*([A-Za-z_]\w*)\s*,)/g)) {
      const v = m[1] || m[2], set = [...code.slice(0, m.index).matchAll(new RegExp(`(?:^|[\\s;(])(?:const\\s+|let\\s+)?${v}\\s*=\\s*(['"])([^'"\\n]+)\\1`, 'g'))].pop();
      if (set) add(set[2]);
    }
  }
  return [...out].slice(0, 20);
}
