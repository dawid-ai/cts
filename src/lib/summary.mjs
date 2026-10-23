import { trunc } from './util.mjs';

/** One-line human summary of an event, for the timeline. */
export function summarize(ev) {
  const d = ev.d || {}, i = d.input || {};
  const what = i.command || i.file_path || i.path || i.pattern || i.description || i.url || (i.questions && i.questions[0]) || '';
  switch (ev.kind) {
    case 'session.start': return `session ${d.source || 'start'}${d.model ? ' · ' + d.model : ''}`;
    case 'session.end': return `session end${d.reason ? ' · ' + d.reason : ''}`;
    case 'prompt': return trunc(d.text, 160);
    case 'tool.pre': return `${d.tool} ${trunc(what, 90)}`;
    case 'tool.post': {
      if (d.test) return `${d.test.red ? '✗' : d.test.red === false ? '✓' : '·'} ${trunc(i.command, 60)}${d.test.total ? ` · ${d.test.pass}/${d.test.total}` : ''}`;
      if (d.git) return `git ${d.git.op}${d.git.subject ? ': ' + trunc(d.git.subject, 70) : ''}${d.git.branch ? ' @' + d.git.branch : ''}`;
      return `${d.tool} ${trunc(what, 90)}`;
    }
    case 'tool.fail': return `✗ ${d.tool} ${trunc(what, 70)}${d.out ? ' — ' + trunc(String(d.out).split('\n').filter(Boolean).slice(-1)[0] || '', 70) : ''}`;
    case 'subagent.start': return `started ${d.name || d.agent_type || 'subagent'}`;
    case 'subagent.stop': return trunc(d.last || 'finished', 160);
    case 'turn.end': return trunc(d.last || 'turn end', 160);
    case 'turn.fail': return `turn failed ${trunc(d.error, 80)}`;
    case 'compact.pre': return 'compaction starting';
    case 'compact.post': return 'compacted';
    case 'model.pre': case 'model.post': return `model ${d.from || '?'} → ${d.to || '?'}`;
    case 'permission.request': return `asked permission: ${d.tool || ''}`;
    case 'permission.denied': return `denied: ${d.tool || ''}`;
    case 'mark': return d.note ? `mark: ${d.note}` : 'mark';
    case 'dismiss': return 'dismissed a moment';
    case 'confirm': return 'confirmed a moment';
    case 'thread.close': return 'closed a thread';
    case 'pause': return 'capture paused';
    case 'resume': return 'capture resumed';
    case 'notify': return trunc((d.extra && (d.extra.message || d.extra.notification_type)) || 'notification', 100);
    default: return ev.kind + (d.extra ? ' ' + trunc(JSON.stringify(d.extra), 80) : '');
  }
}

export function slim(ev) {
  const d = { ...ev.d };
  if (d.out) d.out = String(d.out).slice(-400);
  if (d.text && d.text.length > 1500) d.text = d.text.slice(0, 1500) + '…';
  if (d.last && d.last.length > 1500) d.last = d.last.slice(0, 1500) + '…';
  delete d.summary;
  return { id: ev.id, sid: ev.sid, seq: ev.seq ?? ev._seq, ts: ev.ts, t: ev.t ?? ev._t ?? Date.parse(ev.ts), kind: ev.kind, actor: ev.actor, agent_type: ev.agent_type || null, prompt_id: ev.prompt_id, d, tp: !!ev.tp, sum: summarize(ev) };
}

/** Hotspots as text (CLI and MCP): the hottest areas, then files, each with what made it hot. */
export function hotspotText(H, { limit = 10 } = {}) {
  if (!H.files.length) return 'No hotspots yet: files show up once sessions edit them.';
  const why = (r) => [[r.struggles, 'struggle'], [r.corrections, 'correction'], [r.fails, 'red run'], [r.edits, 'edit'], [r.commits, 'commit']].filter(([n]) => n).map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`).join(', ');
  const row = (name, r) => `  ${String(r.heat).padStart(4)}  ${trunc(name, 56).padEnd(56)}  ${why(r)} · ${r.sessions} session${r.sessions === 1 ? '' : 's'}`;
  return [`Hottest areas (heat = 3 per struggle or correction, 1 per red run after an edit, 1 per 5 edits or commits):`,
    ...H.areas.slice(0, Math.min(limit, 8)).map((a) => row(`${a.area} (${a.files} file${a.files === 1 ? '' : 's'})`, a)),
    `Hottest files (${Math.min(limit, H.files.length)} of ${H.total}):`, ...H.files.slice(0, limit).map((r) => row(r.file, r))].join('\n');
}
