// Kimi Code (Moonshot) quota reader. Kimi DOES expose quota — the /usage panel
// calls GET https://api.kimi.com/coding/v1/usages (plural) with the OAuth bearer
// token, returning a weekly window (`usage`) and rate windows (`limits[]`, the
// 5-hour one has window.duration=300min). Server-authoritative (agrees across
// machines).
//
// The access token is SHORT-LIVED (~15 min, `expires_in: 900`) and is only
// refreshed when the kimi CLI itself runs. So unless you've used kimi in the
// last quarter of an hour, a live read will 401. We therefore:
//   1. check `expires_at` before spending a request we know will fail,
//   2. fall back to the last good reading — but ONLY while its windows are
//      still open. A cached percentage whose reset time has passed is
//      meaningless (the server has rolled the window over, possibly many
//      times), so it must never be rendered as a live bar.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KIMI_DIR = path.join(os.homedir(), '.kimi-code');
const CREDS = path.join(KIMI_DIR, 'credentials', 'kimi-code.json');
const USAGES_URL = 'https://api.kimi.com/coding/v1/usages';
const CACHE = path.join(KIMI_DIR, '.quotamax-usages-cache.json');

const pct = (used, limit) => {
  const u = Number(used);
  const l = Number(limit);
  return Number.isFinite(u) && Number.isFinite(l) && l > 0 ? Math.round((u / l) * 100) : null;
};

// Map the /usages payload to windowed limits: 5h (limits[] duration≈300min) + weekly (usage).
export function limitsFromUsages(data) {
  const out = [];
  const five = (data?.limits ?? []).find((l) => {
    const w = l?.window;
    const mins =
      w?.timeUnit === 'TIME_UNIT_MINUTE' ? w.duration : w?.timeUnit === 'TIME_UNIT_HOUR' ? w.duration * 60 : null;
    return mins != null && mins <= 360;
  });
  if (five?.detail) out.push({ label: '5h window', percent: pct(five.detail.used, five.detail.limit), unit: '%', resetsAt: five.detail.resetTime ?? null });
  if (data?.usage) out.push({ label: 'weekly', percent: pct(data.usage.used, data.usage.limit), unit: '%', resetsAt: data.usage.resetTime ?? null });
  return out.filter((l) => l.percent != null);
}

// A cached reading is only meaningful while its windows are still open. Once a
// window's reset has passed, the server has started a new one and the stored
// percentage describes a period that no longer exists — drop it rather than
// draw a bar from it.
export function openLimits(limits, now = Date.now()) {
  return (limits ?? []).filter((l) => l.resetsAt == null || Date.parse(l.resetsAt) > now);
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  } catch {
    return null;
  }
}
function writeCache(data) {
  try {
    fs.writeFileSync(CACHE, JSON.stringify({ at: new Date().toISOString(), data }));
  } catch {
    /* best effort */
  }
}

function readCreds() {
  try {
    return JSON.parse(fs.readFileSync(CREDS, 'utf8'));
  } catch {
    return null;
  }
}

const label = (lvl) => `Kimi Code${lvl ? ' (' + lvl.replace(/^LEVEL_/, '') + ')' : ''}`;

// Shared fallback: serve the last good reading, but only the windows that are
// still open. If none are, say so plainly instead of showing stale numbers.
function fromCache(reason) {
  const c = readCache();
  if (!c?.data) {
    return { id: 'kimi', label: 'Kimi Code', configured: true, ok: false, note: reason, limits: [] };
  }
  const ageM = Math.round((Date.now() - Date.parse(c.at)) / 60000);
  const age = ageM >= 120 ? `${Math.round(ageM / 60)}h` : `${ageM}m`;
  const open = openLimits(limitsFromUsages(c.data));
  if (open.length === 0) {
    return {
      id: 'kimi',
      label: label(c.data?.user?.membership?.level),
      configured: true,
      ok: false,
      note: `usage unavailable — last reading ${age} old, its windows have since reset (${reason})`,
      limits: [],
    };
  }
  return {
    id: 'kimi',
    label: label(c.data?.user?.membership?.level),
    configured: true,
    ok: true,
    note: `usage as of ${age} ago (${reason})`,
    limits: open,
  };
}

export async function kimiProvider() {
  const creds = readCreds();
  const tok = creds?.access_token ?? null;
  if (!tok) {
    return {
      id: 'kimi',
      label: 'Kimi Code',
      configured: fs.existsSync(KIMI_DIR),
      ok: false,
      note: fs.existsSync(KIMI_DIR) ? 'not logged in — run `kimi login`' : 'Kimi not found (~/.kimi-code)',
      limits: [],
    };
  }

  // `expires_at` is unix SECONDS. If it has passed, the request is guaranteed to
  // 401 — skip it and report precisely how stale the token is.
  const expSec = Number(creds?.expires_at);
  if (Number.isFinite(expSec) && expSec * 1000 <= Date.now()) {
    const mins = Math.round((Date.now() - expSec * 1000) / 60000);
    return fromCache(`token expired ${mins}m ago — run any \`kimi\` command to refresh`);
  }

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(USAGES_URL, { headers: { Authorization: 'Bearer ' + tok }, signal: ctrl.signal });
    clearTimeout(t);
    if (r.ok) {
      const data = await r.json();
      writeCache(data);
      return { id: 'kimi', label: label(data?.user?.membership?.level), configured: true, ok: true, limits: limitsFromUsages(data) };
    }
    return fromCache(r.status === 401 ? 'token rejected — run any `kimi` command to refresh' : `usages HTTP ${r.status}`);
  } catch (e) {
    return fromCache(`offline: ${e.name}`);
  }
}
