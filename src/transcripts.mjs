// Aggregates real usage from Claude Code session transcripts
// (~/.claude/projects/**/*.jsonl). Per-file results are cached and re-parsed
// only when mtime/size changes, so only the first run is slow. The cache
// stores token *counts* keyed by day and model — never message content.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { CACHE_DIR } from './store.mjs';

const CACHE_FILE = path.join(CACHE_DIR, 'transcript-usage.json');

async function scanFile(file) {
  // day → model → [input, output, cacheWrite, cacheRead]
  const days = {};
  const byId = new Map(); // streaming rewrites repeat message ids; last wins
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"usage"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = obj.message?.usage;
    if (!usage || !obj.timestamp) continue;
    byId.set(obj.message?.id ?? `line-${byId.size}`, {
      day: obj.timestamp.slice(0, 10),
      model: obj.message?.model ?? 'unknown',
      in: usage.input_tokens ?? 0,
      out: usage.output_tokens ?? 0,
      cw: usage.cache_creation_input_tokens ?? 0,
      cr: usage.cache_read_input_tokens ?? 0,
    });
  }
  for (const r of byId.values()) {
    const models = (days[r.day] ??= {});
    const t = (models[r.model] ??= [0, 0, 0, 0]);
    t[0] += r.in;
    t[1] += r.out;
    t[2] += r.cw;
    t[3] += r.cr;
  }
  return days;
}

export async function loadUsage({ maxAgeDays = 95, log = () => {} } = {}) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  let cache = { version: 2, files: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (parsed.version === 2) cache = parsed;
  } catch {
    /* first run */
  }

  let entries = [];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return { files: {}, note: 'no ~/.claude/projects directory found' };
  }

  const cutoff = Date.now() - maxAgeDays * 24 * 3.6e6;
  const live = new Set();
  let scanned = 0;
  for (const dir of entries) {
    if (!dir.isDirectory()) continue;
    const project = dir.name;
    const full = path.join(projectsDir, project);
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(full, f);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff) continue;
      live.add(file);
      const hit = cache.files[file];
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) continue;
      cache.files[file] = { mtimeMs: st.mtimeMs, size: st.size, project, days: await scanFile(file) };
      scanned++;
    }
  }
  for (const k of Object.keys(cache.files)) if (!live.has(k)) delete cache.files[k];
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  if (scanned) log(`scanned ${scanned} changed transcript file(s)`);
  return cache;
}

/** Flatten the cache: day → model → {in,out,cw,cr} summed across files. */
export function byDayModel(cache) {
  const out = {};
  for (const f of Object.values(cache.files ?? {})) {
    for (const [day, models] of Object.entries(f.days)) {
      const d = (out[day] ??= {});
      for (const [model, [i, o, cw, cr]] of Object.entries(models)) {
        const t = (d[model] ??= { in: 0, out: 0, cw: 0, cr: 0 });
        t.in += i;
        t.out += o;
        t.cw += cw;
        t.cr += cr;
      }
    }
  }
  return out;
}

/** day → total output tokens (simple cost proxy for trend comparisons). */
export function dailyOutput(cache) {
  const daily = {};
  for (const [day, models] of Object.entries(byDayModel(cache))) {
    daily[day] = Object.values(models).reduce((s, t) => s + t.out, 0);
  }
  return daily;
}
