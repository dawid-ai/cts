// Main status line setup. A plugin cannot set it, so `cts init --statusline [--global]` writes it into Claude Code settings
// and SessionStart shows a one-time tip when none is set. Never replaces a status line that is not CTS's. Light: the hook imports it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ctsHome } from './consent.mjs';
import { readJson } from './util.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'cts');
export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const tipFile = () => path.join(ctsHome(), 'statusline-tip');
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command to run. From the plugin cache (<cache>/<market>/cts/<version>/) it resolves the newest version at run time, so updates don't break it. */
export function statusCommand(bin = BIN) {
  const ver = path.resolve(bin, '..', '..'), plugin = path.dirname(ver);
  const cached = path.basename(plugin) === 'cts' && path.resolve(plugin).includes(`${path.sep}plugins${path.sep}cache${path.sep}`);
  if (!cached || process.platform === 'win32') return `node "${path.resolve(bin)}" statusline`;
  return `d=$(ls -d ${q(plugin)}/*/ 2>/dev/null | sort -V | tail -1); [ -n "$d" ] && node "\${d}bin/cts" statusline`;
}

export const isCts = (sl) => !!sl && /\bcts\b/.test(String(sl.command || '')) && /\bstatusline\b/.test(String(sl.command || ''));

/** Write statusLine into a settings file. Returns 'set', or 'other' (left alone: a non-CTS status line is there and force is off). */
export function install(file, { force = false, command = statusCommand() } = {}) {
  const cur = readJson(file, {}) || {};
  if (cur.statusLine && !isCts(cur.statusLine) && !force) return 'other';
  cur.statusLine = { type: 'command', command };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cur, null, 2) + '\n');
  return 'set';
}

/** Settings files Claude Code reads a statusLine from, broadest first. */
export const settingsFiles = (root) => [path.join(claudeHome(), 'settings.json'), path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json')];

/** The one-time SessionStart tip: only when no status line is set anywhere, shown once per CTS home. Temp dirs never see it (tests). */
export function tip(root) {
  if (!process.env.CTS_HOME && path.resolve(root).startsWith(path.resolve(os.tmpdir()))) return null;
  if (fs.existsSync(tipFile())) return null;
  if (settingsFiles(root).some((f) => (readJson(f, {}) || {}).statusLine)) return null;
  fs.mkdirSync(ctsHome(), { recursive: true });
  fs.writeFileSync(tipFile(), new Date().toISOString());
  return 'CTS: run /cts:init --statusline --global to show moments and threads in your status line (shown once).';
}
