// Codex (ChatGPT subscription) quota. Two sources, live preferred:
//
//  1. LIVE endpoint (the same one the CLI itself polls):
//       GET https://chatgpt.com/backend-api/wham/usage
//       headers: Authorization: Bearer <access_token>, chatgpt-account-id: <id>
//     from ~/.codex/auth.json. Returns `rate_limit.primary_window` /
//     `secondary_window`, each { used_percent, limit_window_seconds, reset_at }.
//     Always fresh — the CLI keeps the token refreshed. (v0.144 uses /wham/usage;
//     the /api/codex/usage path is the alt route and is bot-gated for non-CLI UAs.)
//
//  2. FALLBACK — the local session rollout logs under
//     ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, whose `rate_limits` carries
//     `primary`/`secondary` windows { used_percent, window_minutes, resets_at }.
//     Used when the token has expired (run `codex` to refresh) or the endpoint
//     is unreachable. Stale between runs.
//
// IMPORTANT: which slot holds which window is NOT fixed — recent Codex reports
// the *weekly* cap in `primary` with `secondary` null; older builds split 5h +
// weekly. So we derive each window's label from its own length, never the slot.
// A rollout window whose reset has already passed is flagged stale, not zeroed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paceSurplus } from './index.mjs';

const SESSIONS = path.join(os.homedir(), '.codex', 'sessions');
const AUTH = path.join(os.homedir(), '.codex', 'auth.json');
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

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

// The live /wham/usage windows are shaped { used_percent, limit_window_seconds,
// reset_at } — seconds, not the rollout's window_minutes. Map to the same limit
// shape, labeling by the window's own length. Always fresh, so never stale.
export function liveWindowLimit(w) {
  if (!w || w.used_percent == null) return null;
  const minutes = w.limit_window_seconds ? w.limit_window_seconds / 60 : null;
  const { label, cycleDays } = windowMeta(minutes);
  const resetsAt = w.reset_at ? new Date(w.reset_at * 1000).toISOString() : null;
  return {
    label,
    percent: w.used_percent,
    unit: '%',
    resetsAt,
    stale: false,
    surplus: cycleDays >= 1 ? paceSurplus(w.used_percent, resetsAt, cycleDays) : false,
  };
}

// Poll the live endpoint the CLI itself uses. Returns { plan, limits } on 200,
// or null on any failure (no creds, expired token → 401, network) so the caller
// falls back to the rollout logs.
async function fetchCodexLiveUsage() {
  let tok, acct;
  try {
    const a = JSON.parse(fs.readFileSync(AUTH, 'utf8'));
    tok = a.tokens?.access_token;
    acct = a.tokens?.account_id;
  } catch {
    return null;
  }
  if (!tok || !acct) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(USAGE_URL, {
      headers: {
        Authorization: 'Bearer ' + tok,
        'chatgpt-account-id': acct,
        'User-Agent': 'codex_cli_rs/0.144.3',
        Accept: 'application/json',
      },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return null; // 401 expired etc. → fall back to logs
    const d = await r.json();
    const rl = d.rate_limit ?? {};
    const limits = [liveWindowLimit(rl.primary_window), liveWindowLimit(rl.secondary_window)].filter(Boolean);
    if (!limits.length) return null;
    return { plan: d.plan_type ?? 'plan', limits };
  } catch {
    return null;
  }
}

export async function codexProvider() {
  // Prefer the live endpoint — always fresh — and only touch the rollout logs
  // when it's unavailable (usually an expired token: run `codex` to refresh).
  const live = await fetchCodexLiveUsage();
  if (live) {
    return { id: 'codex', label: `Codex (ChatGPT ${live.plan})`, configured: true, ok: true, limits: live.limits };
  }

  let hit = null;
  for (const f of recentRolloutFiles()) {
    hit = lastRateLimits(f);
    if (hit) break;
  }
  if (!hit) {
    return {
      id: 'codex',
      label: 'Codex',
      configured: fs.existsSync(SESSIONS) || fs.existsSync(AUTH),
      ok: false,
      note: fs.existsSync(SESSIONS) || fs.existsSync(AUTH)
        ? 'no live usage (token expired? run `codex`) and no rate-limit data in the logs'
        : 'Codex not found (~/.codex missing) — run `codex login`',
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
    note: `from local logs${ageH != null ? `, last run ${ageH.toFixed(1)}h ago` : ''} — run \`codex\` to refresh live`,
    // Map whichever windows are present; the label comes from each window's own
    // length, so the weekly cap shows as "weekly" wherever Codex reports it.
    limits: [windowLimit(rl.primary), windowLimit(rl.secondary)].filter(Boolean),
  };
}
