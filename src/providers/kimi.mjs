// Kimi Code (Moonshot) quota reader. Kimi DOES expose quota — the /usage panel
// calls GET https://api.kimi.com/coding/v1/usages (plural) with the OAuth bearer
// token, returning a weekly window (`usage`) and rate windows (`limits[]`, the
// 5-hour one has window.duration=300min). Server-authoritative (agrees across
// machines). The access token is short-lived (~15min) and refreshed by the kimi
// CLI, so on a stale-token 401 we fall back to the last good reading with an age.
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

export async function kimiProvider() {
  let tok;
  try {
    tok = JSON.parse(fs.readFileSync(CREDS, 'utf8')).access_token;
  } catch {
    tok = null;
  }
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

  const label = (lvl) => `Kimi Code${lvl ? ' (' + lvl.replace(/^LEVEL_/, '') + ')' : ''}`;
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
    // stale/expired token (or other) → fall back to last good reading
    const c = readCache();
    if (c?.data) {
      const ageM = Math.round((Date.now() - Date.parse(c.at)) / 60000);
      return {
        id: 'kimi',
        label: label(c.data?.user?.membership?.level),
        configured: true,
        ok: true,
        note: `usage as of ${ageM}m ago (token stale — run any kimi cmd to refresh)`,
        limits: limitsFromUsages(c.data),
      };
    }
    return {
      id: 'kimi',
      label: 'Kimi Code',
      configured: true,
      ok: false,
      note: r.status === 401 ? 'token expired — run any `kimi` command to refresh' : `usages HTTP ${r.status}`,
      limits: [],
    };
  } catch (e) {
    const c = readCache();
    if (c?.data) {
      const ageM = Math.round((Date.now() - Date.parse(c.at)) / 60000);
      return {
        id: 'kimi',
        label: label(c.data?.user?.membership?.level),
        configured: true,
        ok: true,
        note: `usage as of ${ageM}m ago (offline: ${e.name})`,
        limits: limitsFromUsages(c.data),
      };
    }
    return { id: 'kimi', label: 'Kimi Code', configured: true, ok: false, note: `read error: ${e.message}`, limits: [] };
  }
}
