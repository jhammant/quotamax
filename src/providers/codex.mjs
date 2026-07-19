// Codex (ChatGPT subscription) quota, read from the local session rollout logs.
// Codex writes under ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. Each turn
// emits a `token_count` event whose `rate_limits` carries `primary` and
// `secondary` windows, each with `used_percent`/`resets_at`/`window_minutes`.
//
// IMPORTANT: which slot holds which window is NOT fixed — recent Codex reports
// the *weekly* cap (window_minutes 10080 = 7d) in `primary` with `secondary`
// null; older builds split 5h `primary` + weekly `secondary`. So we derive each
// window's label from its own `window_minutes`, never from the slot name.
//
// There is no live endpoint; this reflects the most recent Codex run, so it can
// be stale between runs. When a window's `resets_at` has already passed, the
// reading is from a prior cycle — we mark it stale rather than inventing a %.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paceSurplus } from './index.mjs';

const SESSIONS = path.join(os.homedir(), '.codex', 'sessions');

// Rollout filenames are `rollout-<ISO timestamp>-<uuid>.jsonl`, so lexical
// order is chronological. Walk newest year→month→day and return recent files.
function recentRolloutFiles(limit = 5) {
  const found = [];
  const descend = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (depth === 3) {
      entries
        .filter((e) => e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl'))
        .sort((a, b) => b.name.localeCompare(a.name))
        .forEach((e) => found.push(path.join(dir, e.name)));
      return;
    }
    entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => b.name.localeCompare(a.name))
      .forEach((e) => {
        if (found.length < limit) descend(path.join(dir, e.name), depth + 1);
      });
  };
  descend(SESSIONS, 0);
  return found.slice(0, limit);
}

function lastRateLimits(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('rate_limits')) continue;
    try {
      const e = JSON.parse(lines[i]);
      const rl = e.payload?.rate_limits;
      if (rl?.primary || rl?.secondary) return { rl, at: e.timestamp };
    } catch {
      /* skip malformed line */
    }
  }
  return null;
}

// Name a window by its length, not its slot: ~300min → 5h, ~10080min → weekly,
// anything else → an explicit Nh/Nd window. Returns the display label + cycle
// length in days (for surplus pacing).
export function windowMeta(minutes) {
  if (minutes == null) return { label: 'window', cycleDays: null };
  if (minutes <= 360) return { label: '5h window', cycleDays: minutes / 1440 };
  if (minutes >= 8640) return { label: 'weekly', cycleDays: minutes / 1440 }; // ≥6d ⇒ the weekly cap
  const h = minutes / 60;
  return { label: h >= 48 ? `${Math.round(h / 24)}d window` : `${Math.round(h)}h window`, cycleDays: minutes / 1440 };
}

export function windowLimit(w) {
  if (!w || w.used_percent == null) return null;
  const { label, cycleDays } = windowMeta(w.window_minutes);
  const resetsAtMs = w.resets_at ? w.resets_at * 1000 : null;
  // resetsAt is an ISO string to match the other providers and fmtReset (which
  // parses strings, not epoch numbers).
  const resetsAt = resetsAtMs ? new Date(resetsAtMs).toISOString() : null;
  // A window whose resets_at has already passed rolled over after this reading —
  // the % is from a prior cycle, so flag it stale rather than trusting it.
  const stale = resetsAtMs != null && resetsAtMs <= Date.now();
  return {
    label: stale ? `${label} (stale — window reset, rerun codex)` : label,
    percent: w.used_percent,
    unit: '%',
    resetsAt,
    stale,
    surplus: !stale && cycleDays >= 1 ? paceSurplus(w.used_percent, resetsAt, cycleDays) : false,
  };
}

export async function codexProvider() {
  let hit = null;
  for (const f of recentRolloutFiles()) {
    hit = lastRateLimits(f);
    if (hit) break;
  }
  if (!hit) {
    return {
      id: 'codex',
      label: 'Codex',
      configured: fs.existsSync(SESSIONS),
      ok: false,
      note: fs.existsSync(SESSIONS)
        ? 'no rate-limit data yet — run a `codex exec` once so it records usage'
        : 'Codex not found (~/.codex/sessions missing) — run `codex login`',
      limits: [],
    };
  }
  const { rl, at } = hit;
  const ageH = at ? (Date.now() - Date.parse(at)) / 3.6e6 : null;
  return {
    id: 'codex',
    label: `Codex (ChatGPT ${rl.plan_type ?? 'plan'})`,
    configured: true,
    ok: true,
    note: ageH != null && ageH > 1 ? `usage as of last run ${ageH.toFixed(1)}h ago` : undefined,
    // Map whichever windows are present; the label comes from each window's own
    // length, so the weekly cap shows as "weekly" wherever Codex reports it.
    limits: [windowLimit(rl.primary), windowLimit(rl.secondary)].filter(Boolean),
  };
}
