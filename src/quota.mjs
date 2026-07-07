// Live quota from the internal endpoint that Claude Code's /usage command
// uses. Undocumented and unversioned: shapes may change, and it rate-limits
// hard if polled aggressively — hence the shared cache and snapshot fallback.
import { readOAuth } from './credentials.mjs';
import { readSnapshots, recordSnapshot } from './store.mjs';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_TTL_MS = 120_000;
const STALE_MAX_MS = 2 * 3.6e6;
let memCache = { at: 0, value: null };

export function resetQuotaCache() {
  memCache = { at: 0, value: null };
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

// Cached live read; on failure falls back to the last recorded snapshot
// (< 2h old, marked stale). Successful live reads are recorded as snapshots,
// which is how the trend history accumulates with zero daemons.
export async function getQuota() {
  if (memCache.value && Date.now() - memCache.at < CACHE_TTL_MS) return memCache.value;
  const oauth = readOAuth();
  try {
    const quota = normalize(await fetchUsage(oauth.accessToken), oauth.subscriptionType);
    memCache = { at: Date.now(), value: quota };
    recordSnapshot(quota);
    return quota;
  } catch (e) {
    const last = readSnapshots().at(-1);
    if (last && Date.now() - Date.parse(last.at) < STALE_MAX_MS) {
      return { ...last, stale: true, staleReason: e.message };
    }
    throw e;
  }
}
