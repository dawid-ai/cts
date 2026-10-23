import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Project } from '../src/lib/project.mjs';
import { paths, serialize } from '../src/lib/util.mjs';
import * as N from '../src/lib/narrative.mjs';
import * as I from '../src/lib/images.mjs';
import { Sim, JEST_RED, JEST_GREEN } from './helpers.mjs';

function setup(cfg = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-img-')); fs.mkdirSync(path.join(root, '.git')); fs.mkdirSync(paths(root).sessions, { recursive: true });
  fs.writeFileSync(paths(root).config, JSON.stringify(cfg));
  const s = new Sim({ start: Date.now() - 2 * 3600e3 }); s.start();
  s.prompt('make the limiter pass its tests'); s.adv(1);
  s.call('Edit', { file_path: path.join(root, 'src', 'limiter.js') }); s.adv(1);
  for (let i = 0; i < 4; i++) { s.bash('npm test', { ok: false, out: JEST_RED(2) }); s.adv(2); }
  s.bash('npm test', { out: JEST_GREEN }); s.adv(1);
  s.prompt('wait, go back to the old refill logic'); s.adv(1);
  s.bash('git commit -m "limiter 1.2.0: restore refill logic"', { git: { branch: 'main', subject: 'limiter 1.2.0: restore refill logic', files: ['src/limiter.js'], stat: { files: 3, ins: 40, del: 2 } } }); s.adv(1);
  s.stop('Done.');
  fs.writeFileSync(path.join(paths(root).sessions, 's1.jsonl'), s.events.map(serialize).join(''));
  return { root, pr: Project.open(root) };
}
const arcSrc = (pr) => N.resolveSource(pr, 'arc:' + pr.engine.arcs().find((a) => a.moments.length > 1).id);

test('images: every template draws a self-contained SVG from the log, text escaped, fonts embedded', () => {
  const { pr } = setup({ images: { handle: '@me', repo: 'github.com/me/<x>' } });
  const d = I.imageData(pr, { src: arcSrc(pr) });
  assert.equal(d.handle, '@me'); assert.equal(d.releases.length, 1); assert.equal(d.releases[0].v, '1.2.0'); assert.equal(d.releases[0].size, 42);
  assert.ok(d.arc && d.arc.counts.fight === 1, JSON.stringify(d.arc));
  for (const t of I.TEMPLATE_IDS) {
    const s = I.drawImage(t, d);
    assert.match(s, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="\d+"/, t);
    assert.match(s, /@font-face\{font-family:'[^']+';[^}]*src:url\(data:font\/woff2;base64,/, `${t} embeds its fonts`);
    assert.ok(!s.includes('<x>'), `${t} escapes text`);
    assert.doesNotMatch(s.replace(/base64,[^)]+\)/g, ''), /undefined|NaN/, t);
  }
  assert.match(I.drawImage('release', d), /1 release\. 1 day\./);
  assert.match(I.drawImage('poster', d), /THE MOVIE/);
  pr.close();
});

test('images: jokes are checked like a post (no numbers the data lacks, every slot), and fall back to the defaults', async () => {
  const { pr } = setup();
  const d = I.imageData(pr, { src: arcSrc(pr) });
  assert.match(I.checkJokes('receipt', { headline: 'It took 99 tries', items: [], total: '1 POST', footer: 'x' }, d).join(), /99/);
  assert.match(I.checkJokes('release', {}, d).join(), /missing slot subline/);
  const ok = await I.writeJokes(pr, 'release', d, { via: 'claude', ask: async (sys) => { assert.match(sys, /Any number you write must appear in the data/); return JSON.stringify({ subline: 'One release, zero regrets so far.' }); } });
  assert.equal(ok.writer, 'claude'); assert.equal(ok.jokes.subline, 'One release, zero regrets so far.');
  let calls = 0;
  const bad = await I.writeJokes(pr, 'release', d, { via: 'claude', ask: async () => { calls++; return JSON.stringify({ subline: 'Only 77 bugs left.' }); } });
  assert.equal(calls, 2); assert.equal(bad.writer, 'template'); assert.match(bad.note, /77/); assert.equal(bad.jokes.subline, I.TEMPLATES.release.defaults(d).subline);
  assert.equal((await I.writeJokes(pr, 'release', d, {})).writer, 'template', 'no writer: the defaults, no model call');
  pr.close();
});

test('images on drafts: create attaches the new image, Surprise me follows the angle, detach and replay keep the state', async () => {
  const { root, pr } = setup();
  const m = pr.engine.listMoments().find((x) => x.kind === 'fight');
  const id = N.createDraft(pr, m.id, { channel: 'x' }).id;
  const r = await I.createImage(pr, id, { template: 'boss', render: false });
  assert.equal(r.template, 'boss'); assert.equal(r.n, 0);
  assert.ok(fs.existsSync(I.imageFile(root, id, 0, 'svg')));
  const x = pr.engine.drafts.get(id);
  assert.equal(x.attached, 0); assert.deepEqual(x.images.map((i) => i.template), ['boss']);
  const r2 = await I.createImage(pr, id, { template: 'surprise', render: false });
  assert.notEqual(r2.template, 'boss', 'Surprise me does not repeat the last template');
  assert.equal(pr.engine.drafts.get(id).attached, 1);
  assert.equal(I.pickTemplate({ angle: 'fuckup' }), 'boss'); assert.equal(I.pickTemplate({ angle: 'grind' }), 'receipt');
  I.attachImage(pr, id, null); assert.equal(pr.engine.drafts.get(id).attached, null);
  assert.match(I.attachImage(pr, id, 9).error, /no such image/);
  I.attachImage(pr, id, 0);
  pr.close();
  const again = Project.open(root); const y = again.engine.drafts.get(id);
  assert.equal(y.images.length, 2); assert.equal(y.attached, 0); again.close();
});

test('images: the project name and repo link show by default and can be turned off; other names are still masked', () => {
  const { root, pr } = setup({ images: { repo: 'github.com/acme/limiter' } });
  const d = I.imageData(pr, { src: arcSrc(pr) });
  assert.equal(d.project, path.basename(root).toUpperCase()); assert.equal(d.repo, 'github.com/acme/limiter');
  pr.close();
  const off = setup({ images: { identity: false, repo: 'github.com/acme/limiter' } });
  const d2 = I.imageData(off.pr, { src: arcSrc(off.pr) });
  assert.equal(d2.repo, ''); assert.equal(d2.project, 'THIS PROJECT');
  off.pr.close();
});
