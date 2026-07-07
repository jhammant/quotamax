// Live quota from the internal endpoint that Claude Code's /usage command
// uses. Undocumented and unversioned: shapes may change, and it rate-limits
// hard if polled aggressively. Every CLI invocation is a fresh process, so
// caching is two-level: in-memory for hot loops, on-disk so consecutive runs
// (and other tools on this machine) share one upstream cadence. After a 429,
// a persisted cooldown stops all processes retrying while the throttle decays.
import fs from 'node:fs';
import path from 'node:path';
import { readOAuth } from './credentials.mjs';
import { STATE_DIR, readSnapshots, recordSnapshot } from './store.mjs';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const MEM_TTL_MS = 60_000;
const DISK_TTL_MS = 150_000;
const COOLDOWN_MS = 10 * 60_000;
const STALE_MAX_MS = 2 * 3.6e6;
let memCache = { at: 0, value: null };

const DISK_CACHE = path.join(STATE_DIR, 'quota-cache.json');
const COOLDOWN = path.join(STATE_DIR, 'quota-cooldown.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function resetQuotaCache() {
  memCache = { at: 0, value: null };
  fs.rmSync(DISK_CACHE, { force: true });
  fs.rmSync(COOLDOWN, { force: true });
}

async function fetchUsage(accessToken) {
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const err = new Error(`usage endpoint returned HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export function normalize(usage, subscription) {
  const limits = usage.limits ?? [];
  const byKind = (kind) => limits.find((l) => l.kind === kind);
  const session = byKind('session') ?? {
    percent: usage.five_hour?.utilization ?? 0,
    resets_at: usage.five_hour?.resets_at,
  };
  const weekly = byKind('weekly_all') ?? {
    percent: usage.seven_day?.utilization ?? 0,
    resets_at: usage.seven_day?.resets_at,
  };
  return {
    at: new Date().toISOString(),
    subscription: subscription ?? null,
    session: { percent: session.percent ?? 0, resetsAt: session.resets_at ?? null },
    weekly: { percent: weekly.percent ?? 0, resetsAt: weekly.resets_at ?? null },
    scoped: limits
      .filter((l) => l.kind === 'weekly_scoped')
      .map((l) => ({
        label: l.scope?.model?.display_name ?? 'scoped',
        percent: l.percent ?? 0,
        resetsAt: l.resets_at ?? null,
      })),
  };
}

function withAge(quota, fetchedAtMs) {
  return { ...quota, cacheAgeMs: Math.max(0, Date.now() - fetchedAtMs) };
}

// Newest usable data when a live read isn't possible: disk cache or last
// snapshot, whichever is fresher, capped at 2h and marked stale.
function staleFallback(err, disk) {
  const candidates = [];
  if (disk?.quota) candidates.push({ at: disk.fetchedAt, quota: disk.quota });
  const lastSnap = readSnapshots().at(-1);
  if (lastSnap) candidates.push({ at: Date.parse(lastSnap.at), quota: lastSnap });
  const best = candidates.sort((a, b) => b.at - a.at)[0];
  if (best && Date.now() - best.at < STALE_MAX_MS) {
    return { ...withAge(best.quota, best.at), stale: true, staleReason: err.message };
  }
  throw err;
}

// Successful live reads are recorded as snapshots, which is how the trend
// history accumulates with zero daemons.
export async function getQuota() {
  const now = Date.now();
  if (memCache.value && now - memCache.at < MEM_TTL_MS) return memCache.value;

  const disk = readJson(DISK_CACHE);
  if (disk?.quota && now - disk.fetchedAt < DISK_TTL_MS) {
    const quota = withAge(disk.quota, disk.fetchedAt);
    memCache = { at: now, value: quota };
    return quota;
  }

  const cooldown = readJson(COOLDOWN);
  if (cooldown && now < cooldown.until) {
    return staleFallback(
      new Error(`endpoint in 429 cooldown until ${new Date(cooldown.until).toLocaleTimeString()}`),
      disk,
    );
  }

  const oauth = readOAuth();
  try {
    const quota = normalize(await fetchUsage(oauth.accessToken), oauth.subscriptionType);
    fs.writeFileSync(DISK_CACHE, JSON.stringify({ fetchedAt: now, quota }));
    memCache = { at: now, value: quota };
    recordSnapshot(quota);
    return quota;
  } catch (e) {
    if (e.status === 429) {
      fs.writeFileSync(COOLDOWN, JSON.stringify({ until: now + COOLDOWN_MS, reason: e.message }));
    }
    return staleFallback(e, disk);
  }
}
