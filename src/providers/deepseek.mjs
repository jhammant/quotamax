// DeepSeek pay-as-you-go API credit — the backstop pool when the Claude,
// Codex or Kimi subscriptions run low. There is no usage window to track,
// only remaining prepaid balance, so this provider reports a dollar figure
// (kind: 'credit') rather than percentage limits.
//
// Balance endpoint (server-authoritative):
//   GET https://api.deepseek.com/user/balance
//   Authorization: Bearer <key>
//   → { is_available, balance_infos: [{ currency, total_balance,
//        granted_balance, topped_up_balance }] }
//
// API key resolution, first hit wins:
//   1. $DEEPSEEK_API_KEY
//   2. macOS Keychain: security find-generic-password -a <user> -s deepseek-api-key -w
//      (output captured, never logged)
//   3. DEEPSEEK_API_KEY=... in ~/.config/deepseek/env
//
// Low-credit threshold: $DEEPSEEK_LOW_BALANCE_USD (default 5).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const TIMEOUT_MS = 10_000;
const DEFAULT_LOW_USD = 5;

// Keys never leave this module: any error string that might embed one gets it
// stripped before it reaches a note, log or JSON payload.
export function redactKey(s) {
  return String(s).replace(/sk-[A-Za-z0-9]{8,}/g, 'sk-***');
}

export function lowThreshold(env = process.env) {
  const n = Number(env.DEEPSEEK_LOW_BALANCE_USD);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LOW_USD;
}

// Deps are injectable so tests can stand in for the keychain, the env file and
// the network without touching the real ones.
export function resolveApiKey({
  env = process.env,
  platform = process.platform,
  execFile = execFileSync,
  readFile = (p) => fs.readFileSync(p, 'utf8'),
  envFile = path.join(os.homedir(), '.config', 'deepseek', 'env'),
  user = os.userInfo().username,
} = {}) {
  if (env.DEEPSEEK_API_KEY) return env.DEEPSEEK_API_KEY.trim() || null;
  if (platform === 'darwin') {
    try {
      const out = execFile('security', ['find-generic-password', '-a', user, '-s', 'deepseek-api-key', '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const key = String(out).trim();
      if (key) return key;
    } catch {
      /* no keychain entry */
    }
  }
  try {
    const m = readFile(envFile).match(/^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*"?([^"\n]+?)"?\s*$/m);
    if (m?.[1]) return m[1];
  } catch {
    /* no env file */
  }
  return null;
}

// Map the /user/balance payload to the normalized provider shape. `ok` means
// we got a reading; `available` mirrors the API's own is_available flag.
export function fromBalance(data, threshold = DEFAULT_LOW_USD) {
  const info = data?.balance_infos?.find((b) => b?.currency === 'USD') ?? data?.balance_infos?.[0];
  const balanceUsd = Number(info?.total_balance);
  if (!Number.isFinite(balanceUsd)) {
    return { id: 'deepseek', label: 'DeepSeek', kind: 'credit', configured: true, ok: false, note: 'balance payload unreadable', limits: [] };
  }
  const available = data?.is_available !== false;
  return {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'credit',
    configured: true,
    ok: true,
    available,
    balanceUsd,
    currency: info?.currency ?? 'USD',
    thresholdUsd: threshold,
    low: balanceUsd < threshold,
    note: available ? undefined : 'API reports the balance is currently unavailable',
    limits: [],
  };
}

export async function deepseekProvider(deps = {}) {
  const { env = process.env, fetchImpl = fetch } = deps;
  const threshold = lowThreshold(env);
  const key = resolveApiKey(deps);
  if (!key) {
    return {
      id: 'deepseek',
      label: 'DeepSeek',
      kind: 'credit',
      configured: false,
      ok: false,
      note: 'no API key — set DEEPSEEK_API_KEY, add a `deepseek-api-key` Keychain entry, or ~/.config/deepseek/env',
      limits: [],
    };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const r = await fetchImpl(BALANCE_URL, { headers: { Authorization: 'Bearer ' + key }, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) {
      let detail = '';
      try {
        detail = redactKey((await r.text()).slice(0, 120));
      } catch {
        /* body unreadable */
      }
      return {
        id: 'deepseek',
        label: 'DeepSeek',
        kind: 'credit',
        configured: true,
        ok: false,
        note: `balance HTTP ${r.status}${detail ? `: ${detail}` : ''}`,
        limits: [],
      };
    }
    return fromBalance(await r.json(), threshold);
  } catch (e) {
    return {
      id: 'deepseek',
      label: 'DeepSeek',
      kind: 'credit',
      configured: true,
      ok: false,
      note: redactKey(`balance read failed: ${e.message ?? e.name}`),
      limits: [],
    };
  }
}

// The agent-facing view: is the backstop pool usable right now? Deliberately
// separate from the Claude headroom/advice math — DeepSeek is credit-based
// and must never shift those numbers.
export function backstopEntry(p) {
  const usable = Boolean(p?.configured && p?.ok && p?.available !== false && (p?.balanceUsd == null || p.balanceUsd > 0));
  return { provider: 'deepseek', available: usable, balanceUsd: p?.balanceUsd ?? null, low: p?.low ?? null };
}
