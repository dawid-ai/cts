// Share images: SVG cards drawn from the log (receipt, release, poster, boss fight) with jokes written per post. Drawing is
// pure and self-contained (fonts embedded, so the SVG renders the same anywhere). PNG needs a headless Chromium; the upload
// goes to the GitHub repo in images.github with `gh`, only when a post with an image is sent.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paths, trunc } from './util.mjs';
import { redact } from './redact.mjs';
import { redactOpts } from './share.mjs';
import { tagValues, repoStats } from './tags.mjs';
import { consentMoment } from './consent.mjs';
import { askApi, askClaude, parseAnswer } from './extract.mjs';
import { writeHumanEvent } from './log.mjs';
import { resolveSource } from './narrative.mjs';

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dashboard', 'fonts');
const FONTS = {
  anton: ['Anton', 400, 'normal'], 'oswald-300': ['Oswald', 300, 'normal'], 'oswald-500': ['Oswald', 500, 'normal'],
  'playfair-italic-700': ['Playfair Display', 700, 'italic'], 'jbmono-400': ['JetBrains Mono', 400, 'normal'], 'jbmono-700': ['JetBrains Mono', 700, 'normal'],
  pressstart: ['Press Start 2P', 400, 'normal'], 'intertight-400': ['Inter Tight', 400, 'normal'], 'intertight-800': ['Inter Tight', 800, 'normal'], 'intertight-900': ['Inter Tight', 900, 'normal'],
};
const fontCache = new Map();
const fontFace = (keys) => keys.map((k) => {
  if (!fontCache.has(k)) { try { fontCache.set(k, fs.readFileSync(path.join(FONT_DIR, k + '.woff2')).toString('base64')); } catch { fontCache.set(k, null); } }
  const b = fontCache.get(k), [fam, w, st] = FONTS[k];
  return b ? `@font-face{font-family:'${fam}';font-weight:${w};font-style:${st};src:url(data:font/woff2;base64,${b}) format('woff2')}` : '';
}).join('');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Greedy word wrap by an estimated character budget. */
function wrap(text, max, lines = 9) {
  const out = []; let cur = '';
  for (const w of String(text || '').split(/\s+/).filter(Boolean)) {
    if (cur && (cur + ' ' + w).length > max) { out.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) out.push(cur);
  if (out.length > lines) { const keep = out.slice(0, lines); keep[lines - 1] = trunc(keep[lines - 1] + ' ' + out.slice(lines).join(' '), max).replace(/…?$/, '…'); return keep; }
  return out;
}
const tspans = (lines, x, lh) => lines.map((l, i) => `<tspan x="${x}" dy="${i ? lh : 0}">${esc(l)}</tspan>`).join('');
const logo = (x, y, s, rail, a = '#E07B4F', b = '#EDEBE4', c = '#3FA06B') => `<g transform="translate(${x},${y}) scale(${s / 26})"><line x1="5" y1="3" x2="5" y2="23" stroke="${rail}" stroke-width="2.4" stroke-linecap="round"/><line x1="13" y1="3" x2="13" y2="23" stroke="${rail}" stroke-width="2.4" stroke-linecap="round"/><line x1="21" y1="3" x2="21" y2="23" stroke="${rail}" stroke-width="2.4" stroke-linecap="round"/><circle cx="5" cy="8" r="3.6" fill="${a}"/><circle cx="13" cy="17" r="3.6" fill="${b}"/><circle cx="21" cy="11" r="3.6" fill="${c}"/></g>`;
const svg = (w, h, fonts, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><style>${fontFace(fonts)}</style>${body}</svg>`;
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'], DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const dayLabel = (t) => { const d = new Date(t); return `${DAYS[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()}`; };

// ---------- templates ----------
export const TEMPLATES = {
  receipt: {
    label: 'Receipt', w: 1200, h: 675,
    slots: { headline: 'the punchline, up to 70 characters', items: 'two funny receipt lines as [[label, value], [label, value]]: labels up to 20 characters, values up to 6 characters, uppercase', total: 'the TOTAL value, up to 10 characters, uppercase', footer: 'a closing line, up to 30 characters, uppercase' },
    defaults: (d) => ({ headline: d.title || 'Another session, another post.', items: [['AGENT SAID “DONE”', 'MANY'], ['I SAID “WAIT”', 'SOME']], total: '1 POST', footer: 'THANK YOU FOR STRUGGLING' }),
    draw(d, j) {
      const S = d.session || {}, rows = [['HOURS', S.session_hours], ['MY PROMPTS', S.session_prompts], ['RED RUNS', S.session_red_runs, '#B8352B'], ['COMMITS', S.session_commits]].filter((r) => r[1] != null && r[1] !== '' && r[1] !== 0).slice(0, 3);
      const items = [...rows.map(([a, b, c]) => [a, String(b), c]), ...(j.items || []).slice(0, 2).map(([a, b]) => [String(a).toUpperCase(), String(b).toUpperCase()])];
      const head = wrap(j.headline, 20, 4), hs = head.length > 3 ? 50 : 60;
      let y = 214;
      const rowSvg = items.map(([a, b, c]) => { const r = `<text x="30" y="${y}" font-family="JetBrains Mono" font-size="16" fill="#191816">${esc(trunc(a, 24))}</text><text x="370" y="${y}" text-anchor="end" font-family="JetBrains Mono" font-size="16" fill="${c || '#191816'}">${esc(b)}</text>`; y += 30; return r; }).join('');
      const totY = y + 30;
      return svg(1200, 675, ['jbmono-400', 'jbmono-700', 'intertight-800'], `<rect width="1200" height="675" fill="#2B2A27"/>
<g transform="translate(64,40) rotate(-2 215 297)"><rect width="430" height="595" fill="#FBFAF6"/>${logo(200, 26, 30, '#C9C3B6', '#D2693E', '#191816', '#2F8A59')}
<text x="215" y="90" text-anchor="middle" font-family="JetBrains Mono" font-weight="700" font-size="20" letter-spacing="2.8" fill="#191816">CAPTURE THE STRUGGLE</text>
<text x="215" y="116" text-anchor="middle" font-family="JetBrains Mono" font-size="13" fill="#6B665C">SESSION RECEIPT · ${esc(dayLabel(d.when))}</text>
<line x1="30" y1="160" x2="400" y2="160" stroke="#B9B3A6" stroke-width="2" stroke-dasharray="6 6"/>
<g transform="translate(0,-20)">${rowSvg}</g>
<line x1="30" y1="${totY - 34}" x2="400" y2="${totY - 34}" stroke="#B9B3A6" stroke-width="2" stroke-dasharray="6 6"/>
<text x="30" y="${totY}" font-family="JetBrains Mono" font-weight="700" font-size="22" fill="#191816">TOTAL</text><text x="400" y="${totY}" text-anchor="end" font-family="JetBrains Mono" font-weight="700" font-size="22" fill="#191816">${esc(trunc(String(j.total).toUpperCase(), 12))}</text>
<text x="215" y="548" text-anchor="middle" font-family="JetBrains Mono" font-size="13" fill="#6B665C">${esc(trunc(String(j.footer).toUpperCase(), 34))}</text>
<text x="215" y="570" text-anchor="middle" font-family="JetBrains Mono" font-size="13" fill="#6B665C">${esc(d.repo || 'captured with CTS')}</text></g>
${d.angle ? `<rect x="558" y="${300 - head.length * hs / 2 - 70}" width="${d.angle.length * 11 + 26}" height="30" fill="#E8A64C"/><text x="571" y="${300 - head.length * hs / 2 - 49}" font-family="JetBrains Mono" font-weight="700" font-size="14" letter-spacing="1.7" fill="#191816">${esc(d.angle.toUpperCase())}</text>` : ''}
<text x="558" y="${300 - head.length * hs / 2 + hs * 0.8}" font-family="Inter Tight" font-weight="800" font-size="${hs}" letter-spacing="-1.8" fill="#F4F1EA">${tspans(head, 558, hs * 1.05)}</text>
<text x="558" y="${300 + head.length * hs / 2 + 70}" font-family="JetBrains Mono" font-size="16" fill="#A8A397">${esc([d.handle, `building ${d.project}`].filter(Boolean).join(' · '))}</text>`);
    },
  },
  release: {
    label: 'Release progress', w: 1200, h: 675,
    slots: { subline: 'one dry line about this run of releases, up to 90 characters' },
    defaults: () => ({ subline: 'Each one fixed something the previous one had just found.' }),
    draw(d, j) {
      const R = d.releases || [], n = R.length, max = Math.max(1, ...R.map((r) => r.size));
      const days = n ? Math.max(1, Math.ceil((R[n - 1].t - R[0].t) / 86400000)) : 0;
      const head = n ? `${n} release${n === 1 ? '' : 's'}. ${days} day${days === 1 ? '' : 's'}.` : 'No releases yet.';
      const bw = n ? Math.min(60, (1072 - (n - 1) * 6) / n) : 0;
      const bars = R.map((r, i) => { const h = Math.round(20 + 60 * (r.size / max)); const x = 64 + i * (bw + 6); return `<rect x="${x}" y="${560 - h}" width="${bw}" height="${h}" rx="4" fill="${i === n - 1 ? '#3FA06B' : '#3B4A5E'}"/><text x="${x + bw / 2}" y="582" text-anchor="middle" font-family="JetBrains Mono" font-size="12" fill="#8D99AA">${esc(trunc(r.v, 8))}</text>`; }).join('');
      const span = n ? `${MON[new Date(R[0].t).getMonth()]} ${new Date(R[0].t).getDate()} → ${MON[new Date(R[n - 1].t).getMonth()]} ${new Date(R[n - 1].t).getDate()}` : '';
      return svg(1200, 675, ['jbmono-400', 'jbmono-700', 'intertight-400', 'intertight-800', 'intertight-900'], `<rect width="1200" height="675" fill="#16202E"/>${logo(64, 52, 40, '#3B4A5E', '#E07B4F', '#EEF1F5', '#3FA06B')}
<text x="120" y="78" font-family="Inter Tight" font-weight="800" font-size="28" fill="#EEF1F5">${esc(d.project)}</text><text x="120" y="100" font-family="JetBrains Mono" font-size="14" fill="#8D99AA">${esc(d.repo || '')}</text>
<text x="1136" y="88" text-anchor="end" font-family="JetBrains Mono" font-weight="700" font-size="40" fill="#3FA06B">${esc(d.version ? 'v' + d.version : '')}</text>
<text x="64" y="240" font-family="Inter Tight" font-weight="900" font-size="76" letter-spacing="-3" fill="#EEF1F5">${esc(head)}</text>
<text x="64" y="292" font-family="Inter Tight" font-size="28" fill="#B8C1CD">${tspans(wrap(j.subline, 62, 2), 64, 38)}</text>
${bars}
<text x="64" y="626" font-family="JetBrains Mono" font-size="14" fill="#8D99AA">${esc(span)}${span ? ' · bar height = lines changed' : ''}</text>
<text x="1136" y="626" text-anchor="end" font-family="JetBrains Mono" font-size="14" fill="#8D99AA">${esc(['captured with CTS', d.handle].filter(Boolean).join(' · '))}</text>`);
    },
  },
  poster: {
    label: 'Movie poster', w: 1080, h: 1350,
    slots: { title: 'the film title, up to 40 characters', tagline: 'a one-line tagline, up to 60 characters', quote1: 'a fake critic quote as [quote up to 40 characters, attribution up to 34 characters]', quote2: 'a second one, the same shape', credits: 'six to eight short fake film credits, each up to 40 characters, e.g. "Stunts by git push"', rating: 'the reason for an R rating, up to 50 characters' },
    defaults: (d) => ({ title: d.postTitle || `${d.project}: the movie`, tagline: 'Based on events that really happened in my terminal.', quote1: ['It said it was done.', 'the main agent, wrongly'], quote2: ['I meant something else.', 'me, again'], credits: ['Written by my prompts', 'Directed by nobody in particular', 'Edited by the honesty guard', 'Continuity by the handover file', 'Stunts by git push', 'Music by the fan of my laptop'], rating: d.arc && d.arc.counts.broke ? `red builds (${d.arc.counts.broke}) and strong language` : 'strong language and one misunderstanding' }),
    draw(d, j) {
      const title = String(j.title || '').toUpperCase(), tl = title.length;
      let fs0 = 168, tlines;
      for (fs0 of [168, 140, 116, 96, 80]) { tlines = wrap(title, Math.floor(960 / (fs0 * 0.47)), 9); if (tlines.length <= 2) break; }
      tlines = tlines.slice(0, 2).map((l, i, a) => (i === 1 && wrap(title, Math.floor(960 / (fs0 * 0.47)), 9).length > 2 ? trunc(l + ' …', Math.floor(960 / (fs0 * 0.47))) : l));
      const ty = 956 - (tlines.length - 1) * fs0 * 0.86;
      const c = (d.arc && d.arc.counts) || {};
      const stats = [[d.arc && d.arc.moments.length, 'MOMENTS'], [c.shipped, 'RELEASES'], [c.broke, 'RED BUILDS'], [c.detour, 'SIDE QUEST']].filter((x) => x[0]).map(([n, w]) => `${n} ${n === 1 ? w.replace(/S$/, '') : w}`).join(' · ');
      const credits = wrap([d.cast, ...(j.credits || [])].filter(Boolean).join(' · ').toUpperCase(), 100, 3);
      const q = (a, x, anchor) => `<text x="${x}" y="134" text-anchor="${anchor}" font-family="Oswald" font-weight="500" font-size="17" fill="#F6EFE3">${esc('“' + trunc(a[0], 44) + '”')}</text><text x="${x}" y="158" text-anchor="${anchor}" font-family="Oswald" font-weight="300" font-size="16" fill="#C9B79C">${esc('— ' + trunc(a[1], 36))}</text>`;
      return svg(1080, 1350, ['anton', 'oswald-300', 'oswald-500', 'playfair-italic-700', 'jbmono-400', 'jbmono-700'], `<defs><radialGradient id="g" cx="50%" cy="38%" r="60%"><stop offset="0%" stop-color="#FF5A1F" stop-opacity="0.95"/><stop offset="30%" stop-color="#B3200E" stop-opacity="0.75"/><stop offset="65%" stop-color="#2A0606" stop-opacity="0.6"/><stop offset="100%" stop-color="#070708" stop-opacity="0"/></radialGradient>
<linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#FFE2B8" stop-opacity="0.38"/><stop offset="100%" stop-color="#FFE2B8" stop-opacity="0"/></linearGradient>
<linearGradient id="m" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#FFFFFF"/><stop offset="46%" stop-color="#F3D9B0"/><stop offset="54%" stop-color="#C98A3E"/><stop offset="100%" stop-color="#FFE8C2"/></linearGradient></defs>
<rect width="1080" height="1350" fill="#070708"/><rect width="1080" height="1350" fill="url(#g)"/>
<polygon points="540,0 330,640 750,640" fill="url(#b)"/><polygon points="140,0 60,620 330,620" fill="url(#b)" opacity="0.5"/><polygon points="940,0 750,620 1020,620" fill="url(#b)" opacity="0.5"/>
<g><line x1="390" y1="200" x2="390" y2="560" stroke="#1C1414" stroke-width="20" stroke-linecap="round"/><line x1="540" y1="185" x2="540" y2="575" stroke="#1C1414" stroke-width="20" stroke-linecap="round"/><line x1="690" y1="200" x2="690" y2="560" stroke="#1C1414" stroke-width="20" stroke-linecap="round"/>
<circle cx="390" cy="300" r="100" fill="#FF4A1C" opacity="0.18"/><circle cx="390" cy="300" r="56" fill="#FF4A1C"/><circle cx="540" cy="470" r="108" fill="#FFF3DF" opacity="0.14"/><circle cx="540" cy="470" r="56" fill="#FFF3DF"/><circle cx="690" cy="370" r="100" fill="#3FC07A" opacity="0.16"/><circle cx="690" cy="370" r="56" fill="#3FC07A"/></g>
<text x="60" y="72" font-family="Oswald" font-weight="300" font-size="20" letter-spacing="6.8" fill="#E9DCC8">A CTS PRODUCTION</text><text x="1020" y="72" text-anchor="end" font-family="Oswald" font-weight="300" font-size="20" letter-spacing="6.8" fill="#E9DCC8">BASED ON A TRUE LOG</text>
${q(j.quote1 || ['', ''], 60, 'start')}${q(j.quote2 || ['', ''], 1020, 'end')}
<text x="540" y="${ty - fs0 * 0.86 - 10}" text-anchor="middle" font-family="Playfair Display" font-style="italic" font-weight="700" font-size="38" fill="#FFB547">${esc(trunc(j.tagline, 64))}</text>
<text x="540" y="${ty}" text-anchor="middle" font-family="Anton" font-size="${fs0}" fill="url(#m)">${tspans(tlines, 540, fs0 * 0.86)}</text>
<text x="540" y="${ty + (tlines.length - 1) * fs0 * 0.86 + 74}" text-anchor="middle" font-family="Oswald" font-weight="500" font-size="24" letter-spacing="7" fill="#F6EFE3">${esc(stats)}</text>
<g transform="translate(540,1140) scale(1,1.35)"><text x="0" y="0" text-anchor="middle" font-family="Oswald" font-weight="300" font-size="15" fill="#CFC2AE">${tspans(credits, 0, 19)}</text></g>
<rect x="60" y="1256" width="40" height="44" fill="none" stroke="#F6EFE3" stroke-width="2"/><text x="80" y="1292" text-anchor="middle" font-family="Anton" font-size="34" fill="#F6EFE3">R</text>
<text x="114" y="1272" font-family="Oswald" font-weight="300" font-size="13" letter-spacing="1.3" fill="#CFC2AE">${tspans(wrap(String(j.rating).toUpperCase(), 32, 2), 114, 18)}</text>
<text x="540" y="1286" text-anchor="middle" font-family="Anton" font-size="40" letter-spacing="2.4" fill="#F6EFE3">IN TERMINALS NOW</text>
<text x="540" y="1312" text-anchor="middle" font-family="JetBrains Mono" font-size="14" fill="#CFC2AE">${esc([d.version ? 'v' + d.version : '', d.repo].filter(Boolean).join(' · '))}</text>
<text x="1020" y="1280" text-anchor="end" font-family="JetBrains Mono" font-size="13" fill="#CFC2AE">captured with</text><text x="1020" y="1304" text-anchor="end" font-family="JetBrains Mono" font-weight="700" font-size="20" fill="#F6EFE3">CTS</text>`);
    },
  },
  boss: {
    label: 'Boss fight', w: 1200, h: 675,
    slots: { miss: 'one battle-log line about the agent, like: MAIN AGENT used “DONE!”. It missed. Up to 50 characters', moves: 'four menu moves, each one word up to 8 characters, uppercase, like FIGHT STASH REVERT RUN' },
    defaults: () => ({ miss: 'MAIN AGENT used “DONE!”. It missed.', moves: ['FIGHT', 'STASH', 'REVERT', 'RUN'] }),
    draw(d, j) {
      const [b, b2, b3] = d.bosses || [];
      if (!b) return svg(1200, 675, ['pressstart'], `<rect width="1200" height="675" fill="#12082A"/><text x="600" y="340" text-anchor="middle" font-family="'Press Start 2P'" font-size="20" fill="#F4EEFF">NO BOSSES YET</text>`);
      const base = b.file, dir = b.dir || '.';
      const C = { k: '#1A1030', r: '#E0453A', R: '#9E1E1E', w: '#F7F1DE', g: '#3FA06B' };
      const pix = (rows, x0, y0, n) => rows.map((row, y) => row.split('').map((ch, x) => (C[ch] ? `<rect x="${x0 + x * n}" y="${y0 + y * n}" width="${n}" height="${n}" fill="${C[ch]}"/>` : '')).join('')).join('');
      const boss = ['.....kkkk.....', '.....kwwk.....', '.....kwwk.....', '....kkwwkk....', '...kwwwwwwk...', '..kwrrrrrrwk..', '.kwrgrrrrRrwk.', '.kwrrgrrRrrwk.', '.kwrrrrrrrrwk.', '.kwrRRRRRRrwk.', '..kwrrrrrrwk..', '...kkwwwwkk...', '...kk....kk...', '..kk......kk..'];
      const hero = ['..........', '.k..k..k..', '.k..k..k..', 'rrr.k..k..', '.k..k.ggg.', '.k..k..k..', '.k.www.k..', '.k..k..k..', '.k..k..k..'];
      const log = [`A wild ${base} appeared!`, b.fails ? `It used RED RUN. It's super effective! ×${b.fails}` : null, b.edits ? `MAIN AGENT used EDIT ×${b.edits}. ${j.miss}` : j.miss, [b.corrections ? `YOU used CORRECTION${b.corrections > 1 ? ' ×' + b.corrections : ''}.` : '', b.commits ? `${b.commits} COMMIT${b.commits === 1 ? '' : 'S'} landed.` : ''].filter(Boolean).join(' '), [b2, b3].filter(Boolean).length ? `Next: ${[b2, b3].filter(Boolean).map((x) => `${x.file} (Lv${x.heat})`).join(' · ')} ▶` : null].filter(Boolean).slice(0, 5);
      const mv = (j.moves || []).slice(0, 4).map((m, i) => `<text x="${928 + (i % 2) * 120}" y="${525 + Math.floor(i / 2) * 44}" font-family="'Press Start 2P'" font-size="13" fill="#1A1030">${i ? '' : '▶ '}${esc(trunc(String(m).toUpperCase(), 8))}</text>`).join('');
      const box = (x, y, w, h) => `<rect x="${x + 6}" y="${y + 6}" width="${w}" height="${h}" fill="#1A1030"/><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#F7F1DE" stroke="#1A1030" stroke-width="5"/>`;
      const bar = (x, y, w, f, col) => `<rect x="${x}" y="${y}" width="${w}" height="20" fill="#E9E1C8" stroke="#1A1030" stroke-width="3"/><rect x="${x + 2}" y="${y + 2}" width="${Math.max(0, (w - 4) * f)}" height="16" fill="${col}"/>`;
      return svg(1200, 675, ['pressstart', 'jbmono-400'], `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2B1B5E"/><stop offset="100%" stop-color="#3D2A7A"/></linearGradient></defs>
<rect width="1200" height="324" fill="url(#sky)"/><rect y="324" width="1200" height="351" fill="#4E7A3A"/>
<ellipse cx="840" cy="250" rx="190" ry="35" fill="#2F5224"/><ellipse cx="220" cy="412" rx="150" ry="28" fill="#2F5224"/>
${pix(boss, 742, 32, 14)}${pix(hero, 150, 282, 14)}
${box(36, 30, 470, 118)}<text x="58" y="66" font-family="'Press Start 2P'" font-size="14" fill="#1A1030">${esc(trunc(base, 22))}</text><text x="484" y="66" text-anchor="end" font-family="'Press Start 2P'" font-size="14" fill="#1A1030">Lv${b.heat}</text>
<text x="58" y="96" font-family="'Press Start 2P'" font-size="11" fill="#C0392B">HP</text>${bar(92, 82, 392, 1, '#E0453A')}
<text x="58" y="132" font-family="JetBrains Mono" font-size="14" fill="#3A2E58">${esc(trunc(`${dir === '.' ? '' : dir + '/ · '}met in ${b.sessions} session${b.sessions === 1 ? '' : 's'} · ${b.struggles} struggle${b.struggles === 1 ? '' : 's'}${b.corrections ? ` · ${b.corrections} correction${b.corrections === 1 ? '' : 's'}` : ''}`, 54))}</text>
${box(694, 300, 470, 112)}<text x="716" y="336" font-family="'Press Start 2P'" font-size="14" fill="#1A1030">${esc(trunc(d.party, 22))}</text><text x="1142" y="336" text-anchor="end" font-family="'Press Start 2P'" font-size="14" fill="#1A1030">${esc(d.version ? 'v' + d.version : '')}</text>
<text x="716" y="368" font-family="'Press Start 2P'" font-size="10" fill="#1A1030">PATIENCE</text>${bar(840, 354, 302, 0.18, '#E0A23A')}
<text x="716" y="398" font-family="'Press Start 2P'" font-size="10" fill="#1A1030">CONFIDENCE</text>${bar(840, 384, 302, 1, '#3FA06B')}
<rect x="24" y="457" width="866" height="196" fill="#1A1030" stroke="#F7F1DE" stroke-width="5"/>
<text font-family="'Press Start 2P'" font-size="13" fill="#F7F1DE">${log.map((l, i) => `<tspan x="48" y="${494 + i * 34}">${esc(trunc(l, 62))}</tspan>`).join('')}</text>
<rect x="904" y="457" width="272" height="196" fill="#F7F1DE" stroke="#1A1030" stroke-width="5"/>${mv}
<text x="928" y="630" font-family="JetBrains Mono" font-size="12" fill="#3A2E58">${esc(trunc(['CTS', d.repo].filter(Boolean).join(' · '), 34))}</text>`);
    },
  },
};
export const TEMPLATE_IDS = Object.keys(TEMPLATES);
/** Which template suits a post: by its angle, else by what it is about. */
export function pickTemplate(d, avoid) {
  const by = { fuckup: 'boss', argument: 'boss', grind: 'receipt', lesson: 'receipt', irony: 'poster', discovery: 'poster', surprise: 'poster', decision: 'release' };
  const order = [by[d.angle], d.kind === 'shipped' ? 'release' : null, d.arc ? 'poster' : null, 'receipt', 'boss', 'release', 'poster'].filter(Boolean);
  return order.find((t) => t !== avoid) || 'receipt';
}

// ---------- data ----------
const repoLink = (root) => { try { const u = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); const m = /github\.com[:/]([^/]+\/[^/.]+)/.exec(u); return m ? `github.com/${m[1]}` : ''; } catch { return ''; } };
/** Everything a template may show, for a draft (or a source with no draft), redacted like any shared output. */
export function imageData(pr, { draft, src } = {}) {
  const e = pr.engine, C = pr.cfg.images || {};
  const ms = src ? src.ms : [];
  const top = ms.slice().sort((a, b) => b.score - a.score)[0];
  const r = repoStats(pr.root);
  const counts = {}; for (const m of ms) counts[m.kind] = (counts[m.kind] || 0) + 1;
  const shipped = e.listMoments().filter((m) => m.kind === 'shipped' && !m.demo).sort((a, b) => a.t0 - b.t0).slice(-16);
  const H = e.hotspots(pr.root, { limit: 3 });
  const vista = ((pr.cfg.publishing.channels || {}).x || {}).vista;
  const d = {
    project: C.project || path.basename(pr.root).toUpperCase(), repo: C.repo ?? repoLink(pr.root), version: r.version,
    handle: C.handle || (vista && /^@/.test(vista.name || '') ? vista.name : ''),
    party: 'ME + MAIN AGENT', cast: 'ME · THE MAIN AGENT · AND A CAST OF SUBAGENTS',
    when: top ? top.t1 : Date.now(), title: draft ? draft.title : top ? top.headline : '', postTitle: draft && draft.writer !== 'template' ? draft.title : '', angle: draft ? draft.angle : null, kind: top ? top.kind : null,
    session: top ? tagValues(pr, { sid: top.sid }) : {},
    arc: src && src.type === 'arc' ? { title: (draft && draft.title) || src.arc.title, moments: ms.map((m) => ({ kind: m.kind })), counts } : null,
    releases: shipped.map((m) => ({ v: ((/\d+\.\d+(?:\.\d+)?/.exec((m.evidence || {}).subject || m.headline) || [])[0]) || '', size: (m.evidence && m.evidence.stat) ? m.evidence.stat.ins + m.evidence.stat.del : 1, t: m.t0 })),
    bosses: H.demo ? [] : H.files.slice(0, 3).map((f) => ({ file: f.file, heat: f.heat, fails: f.fails, edits: f.edits, commits: f.commits, struggles: f.struggles, corrections: f.corrections, sessions: f.sessions })),
  };
  if (top) Object.assign(d, { title: d.title || consentMoment(pr, top).headline });
  const opts = imageRedactOpts(pr, d.repo), red = (s) => (typeof s === 'string' ? redact(s, opts).text : s);
  if (C.identity === false) { d.repo = ''; d.project = 'THIS PROJECT'; }
  for (const k of ['title', 'handle', 'postTitle']) d[k] = red(d[k]);
  if (d.arc) d.arc.title = red(d.arc.title);
  // A boss is named by its file name; its folder only when the redactor leaves it alone.
  for (const b of d.bosses) { const dir = path.dirname(b.file); b.file = red(path.basename(b.file)); b.dir = dir === '.' || /\[/.test(red(dir + '/')) ? '' : dir; }
  return d;
}
/** Images show the project's own name and repo link (images.identity, on by default): those names are allowed through. */
export function imageRedactOpts(pr, repo) {
  const o = redactOpts(pr);
  return (pr.cfg.images || {}).identity === false ? o : { ...o, allow: [...(o.allow || []), ...(o.names || []), repo].filter(Boolean) };
}
/** The numbers an image may show: everything in its data. A joke with any other number is refused. */
const numbersIn = (v, acc = new Set()) => { if (typeof v === 'number') acc.add(String(v)); else if (typeof v === 'string') (v.match(/\d+(?:\.\d+)?/g) || []).forEach((x) => acc.add(x)); else if (v && typeof v === 'object') Object.values(v).forEach((x) => numbersIn(x, acc)); return acc; };

// ---------- jokes ----------
export const JOKE_RULES = `You write the jokes for a share image of a developer's post about coding with AI agents. Dry, deadpan, slightly sarcastic,
the fast tech-news kind; at the developer's, the agent's or the hype's expense, never at other people. Fill every slot exactly as
described, keep to the lengths, no hashtags, no emoji. Any number you write must appear in the data. No file paths or names except
ones in the data. Reply with ONLY a JSON object with the slot names as keys.`;
export function checkJokes(t, jokes, data) {
  const allowed = numbersIn(data), p = [];
  const flat = JSON.stringify(jokes);
  const bad = (flat.match(/\d+(?:\.\d+)?/g) || []).filter((n) => !allowed.has(n));
  if (bad.length) p.push(`numbers not in the data: ${[...new Set(bad)].join(', ')}`);
  for (const k of Object.keys(TEMPLATES[t].slots)) if (jokes[k] == null) p.push(`missing slot ${k}`);
  if (/#\w/.test(flat)) p.push('no hashtags');
  return p;
}
/** Jokes for a template: the model's when asked (one repair round), else the defaults. Returns { jokes, writer, note }. */
export async function writeJokes(pr, t, data, { via, ask, post = '' } = {}) {
  const T = TEMPLATES[t], dflt = T.defaults(data);
  if (via !== 'claude' && via !== 'api') return { jokes: dflt, writer: 'template' };
  const model = pr.cfg.drafts.model || 'claude-sonnet-5-5';
  ask = ask || (via === 'api' ? (s, u) => askApi(s, u, { model }) : (s, u) => askClaude(s, u, { model }));
  const { session, releases, bosses, arc, title, angle, version } = data;
  const user = JSON.stringify({ template: T.label, slots: T.slots, post: trunc(post, 1200), data: { title, angle, version, session, arc, releases: releases.length, bosses } });
  const opts = imageRedactOpts(pr, data.repo);
  try {
    let a = parseAnswer(await ask(JOKE_RULES, user)), p = a ? checkJokes(t, a, data) : ['no JSON'];
    if (p.length) { a = parseAnswer(await ask(JOKE_RULES, `${user}\n\nRejected: ${p.join('; ')}. Fix it and reply with the JSON only.`)); p = a ? checkJokes(t, a, data) : ['no JSON']; }
    if (p.length) return { jokes: dflt, writer: 'template', note: `the jokes were refused (${p.join('; ')}); kept the defaults` };
    const clean = JSON.parse(redact(JSON.stringify({ ...dflt, ...a }), opts).text);
    return { jokes: clean, writer: via };
  } catch (e) { return { jokes: dflt, writer: 'template', note: `no jokes from the model (${String(e.message || e).slice(0, 120)}); kept the defaults` }; }
}
export const drawImage = (t, data, jokes) => TEMPLATES[t].draw(data, { ...TEMPLATES[t].defaults(data), ...(jokes || {}) });

// ---------- PNG and upload ----------
/** A headless Chromium: CTS_CHROMIUM, Playwright's, then the system's. */
export function chromium() {
  if (process.env.CTS_CHROMIUM) return fs.existsSync(process.env.CTS_CHROMIUM) ? process.env.CTS_CHROMIUM : null;
  const pw = path.join(os.homedir(), '.cache', 'ms-playwright');
  const found = [];
  try { for (const d of fs.readdirSync(pw).sort().reverse()) { if (d.startsWith('chromium_headless_shell-')) found.push(path.join(pw, d, 'chrome-linux', 'headless_shell'), path.join(pw, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell')); if (/^chromium-\d/.test(d)) found.push(path.join(pw, d, 'chrome-linux', 'chrome')); } } catch { /* none */ }
  found.push('/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  return found.find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;
}
/** SVG file to PNG next to it. Resolves the PNG path, or rejects with a reason. */
export function renderPng(svgFile, w, h) {
  const bin = chromium();
  if (!bin) return Promise.reject(new Error('PNG needs Chromium: install one, or set CTS_CHROMIUM to its path'));
  const out = svgFile.replace(/\.svg$/, '.png');
  const page = svgFile.replace(/\.svg$/, '.html');
  fs.writeFileSync(page, `<!doctype html><html><head><style>html,body{margin:0;background:#000}</style></head><body><img src="${path.basename(svgFile)}" width="${w}" height="${h}" style="display:block"></body></html>`);
  return new Promise((ok, no) => execFile(bin, ['--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${w},${h}`, '--virtual-time-budget=4000', `--screenshot=${out}`, 'file://' + page], { timeout: 45000 }, (err) => {
    try { fs.rmSync(page); } catch { /* gone */ }
    if (err && !fs.existsSync(out)) return no(new Error('Chromium could not render the image: ' + String(err.message).slice(0, 160)));
    ok(out);
  }));
}
/** Upload a file to images.github ({repo, branch, dir}) with gh. Resolves the public raw URL. */
export function uploadGithub(pr, file, name) {
  const G = (pr.cfg.images || {}).github || {};
  if (!G.repo || !/^[\w.-]+\/[\w.-]+$/.test(G.repo)) return Promise.reject(new Error('set the GitHub repo for images in Settings (images.github.repo, owner/name)'));
  const branch = G.branch || 'main', rel = [G.dir, name].filter(Boolean).join('/').replace(/^\/+/, '');
  const body = path.join(os.tmpdir(), `cts-upload-${crypto.randomBytes(6).toString('hex')}.json`);
  fs.writeFileSync(body, JSON.stringify({ message: `CTS image ${name}`, content: fs.readFileSync(file).toString('base64'), branch }));
  return new Promise((ok, no) => execFile('gh', ['api', '--method', 'PUT', `repos/${G.repo}/contents/${rel}`, '--input', body], { timeout: 60000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
    try { fs.rmSync(body); } catch { /* gone */ }
    if (err) return no(new Error('GitHub upload failed: ' + String(stderr || err.message).trim().slice(0, 200)));
    try { const j = JSON.parse(stdout); ok((j.content && j.content.download_url) || `https://raw.githubusercontent.com/${G.repo}/${branch}/${rel}`); } catch { ok(`https://raw.githubusercontent.com/${G.repo}/${branch}/${rel}`); }
  }));
}
export const imagesDir = (root) => path.join(paths(root).cts, 'images');

// ---------- images on drafts ----------
export const imageFile = (root, id, n, ext) => path.join(imagesDir(root), `${id}-${n}.${ext}`);
/**
 * Make an image for a draft: the template (or 'surprise'), jokes from the model when `via` is claude or api, the SVG now and
 * the PNG when Chromium is there. The new image is attached to the post. Returns { n, template, note, png, pngError }.
 */
export async function createImage(pr, id, { template = 'surprise', via, ask, render = true } = {}) {
  const x = pr.engine.drafts.get(id);
  if (!x) return { error: 'no such draft' };
  if (['published', 'declined', 'replaced', 'discarded'].includes(x.status)) return { error: `draft is ${x.status}` };
  const src = resolveSource(pr, x.source.id);
  if (!src) return { error: 'the draft\'s moment or arc is gone' };
  const data = imageData(pr, { draft: x, src });
  const last = x.images.length ? x.images[x.images.length - 1].template : null;
  const t = template === 'surprise' || !TEMPLATES[template] ? pickTemplate(data, last) : template;
  const j = await writeJokes(pr, t, data, { via, ask, post: x.text });
  const n = x.images.length ? Math.max(...x.images.map((i) => i.n)) + 1 : 0;
  fs.mkdirSync(imagesDir(pr.root), { recursive: true });
  const f = imageFile(pr.root, x.id, n, 'svg'), T = TEMPLATES[t];
  fs.writeFileSync(f, drawImage(t, data, j.jokes));
  writeHumanEvent(pr.root, 'draft.image', { draft: x.id, n, template: t, w: T.w, h: T.h, writer: j.writer, jokes: j.jokes }, { sid: x.sid, actor: 'human' });
  writeHumanEvent(pr.root, 'draft.attach', { draft: x.id, n }, { sid: x.sid, actor: 'human' });
  pr.sync();
  let png = false, pngError = null;
  if (render) { try { await renderPng(f, T.w, T.h); png = true; } catch (e) { pngError = e.message; } }
  return { n, template: t, note: j.note || null, png, pngError };
}
export function attachImage(pr, id, n) {
  const x = pr.engine.drafts.get(id);
  if (!x) return { error: 'no such draft' };
  if (n != null && !x.images.some((i) => i.n === n)) return { error: 'no such image' };
  writeHumanEvent(pr.root, 'draft.attach', { draft: x.id, n: n ?? null }, { sid: x.sid, actor: 'human' });
  pr.sync();
  return { ok: true };
}
/** The attached image as a public URL: rendered if needed, uploaded once (draft.upload), then reused. */
export async function attachedUrl(pr, x, { upload = uploadGithub, render = renderPng } = {}) {
  if (x.attached == null) return null;
  if (x.uploads[x.attached]) return x.uploads[x.attached];
  const im = x.images.find((i) => i.n === x.attached);
  const svgF = imageFile(pr.root, x.id, x.attached, 'svg'), pngF = imageFile(pr.root, x.id, x.attached, 'png');
  if (!fs.existsSync(pngF)) { if (!fs.existsSync(svgF)) throw new Error('the attached image file is missing: make it again'); await render(svgF, im.w, im.h); }
  const slug = String((pr.cfg.images || {}).project || path.basename(pr.root)).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const hash = crypto.createHash('sha1').update(fs.readFileSync(pngF)).digest('hex').slice(0, 10);
  const url = await upload(pr, pngF, `${slug}/${x.id}-${x.attached}-${hash}.png`);
  writeHumanEvent(pr.root, 'draft.upload', { draft: x.id, n: x.attached, url }, { sid: x.sid, actor: 'cts' });
  pr.sync();
  return url;
}
