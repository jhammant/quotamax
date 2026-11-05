// A second Claude subscription (the "claude-work" pool), used by headless
// `claude-work` workers through CLAUDE_CODE_OAUTH_TOKEN.
//
// Why not the usage endpoint the main account uses (quota.mjs)? The token is a
// `claude setup-token` token, and env-var / setup-token sessions carry the
// `user:inference` scope only, which /api/oauth/usage refuses. What an
// inference-only token CAN see is the unified rate-limit state Claude Code
// reports in its stream-json `rate_limit_event`:
//
//   {"type":"rate_limit_event","rate_limit_info":{"status":"allowed",
//    "unifiedWindows":{"seven_day":{"utilization":0.27,"resetsAt":1794297600}}}}
//
// So the reading comes from a probe: one Haiku turn with no tools, no MCP
// servers, no settings (so no hooks) and no saved session, about 500 input
// tokens. Probes run detached and at most once per PROBE_TTL_MS; readers get
// the last reading with its age and never wait on a probe.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_DIR } from '../store.mjs';

export const ACCOUNT_ID = 'claude-work';
const LABEL = 'Claude (work)';
export const KEYCHAIN_SERVICE = process.env.QUOTAMAX_CLAUDE_WORK_KEYCHAIN || 'claude-work-oauth';
export const PROBE_TTL_MS = 10 * 60_000;
const PROBE_LOCK_MS = 90_000;
const PROBE_TIMEOUT_MS = 60_000;
const READING_MAX_AGE_MS = 6 * 3.6e6;

export const CACHE = path.join(STATE_DIR, `${ACCOUNT_ID}-ratelimit.json`);
const LOCK = path.join(STATE_DIR, `${ACCOUNT_ID}-probe.lock`);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');

// Raw setup-token string: CLAUDE_WORK_OAUTH_TOKEN, else the Keychain item that
// `claude-work login` writes. Never logged, never cached.
export function readWorkToken() {
  if (process.env.CLAUDE_WORK_OAUTH_TOKEN) return process.env.CLAUDE_WORK_OAUTH_TOKEN.trim();
  if (process.platform !== 'darwin') return null;
  try {
    const raw = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return raw || null;
  } catch {
    return null;
  }
}

const WINDOW_LABELS = { five_hour: '5h window', seven_day: 'weekly' };

// unifiedWindows -> quotamax limits. Per-model windows (any key other than the
// two account-wide ones) keep their model as `scope`, so a router can gate a
// Fable arm on the Fable window without one spent model window making the
// whole pool look exhausted.
export function limitsFromRateLimitInfo(info) {
  const out = [];
  for (const [key, w] of Object.entries(info?.unifiedWindows ?? {})) {
    const utilization = Number(w?.utilization);
    if (!Number.isFinite(utilization)) continue;
    const resetsAt = Number.isFinite(Number(w?.resetsAt)) ? new Date(Number(w.resetsAt) * 1000).toISOString() : null;
    const limit = { label: WINDOW_LABELS[key] ?? key, percent: Math.round(utilization * 100), unit: '%', resetsAt };
    if (!WINDOW_LABELS[key]) {
      const model = key.replace(/^(seven_day|five_hour)_?/, '');
      limit.scope = model ? model[0].toUpperCase() + model.slice(1) : key;
      limit.label = `${limit.scope} ${key.startsWith('five_hour') ? '5h' : 'weekly'}`;
    }
    out.push(limit);
  }
  // A refused account is out of quota whatever the windows say.
  if (info?.status === 'rejected' && !out.some((l) => !l.scope && l.percent >= 100)) {
    out.push({ label: 'rejected', percent: 100, unit: '%', resetsAt: info.resetsAt ? new Date(info.resetsAt * 1000).toISOString() : null });
  }
  return out;
}

// The rate_limit_event from a stream-json transcript (the last one wins).
export function rateLimitInfoFrom(streamJson) {
  let info = null;
  for (const line of String(streamJson).split('\n')) {
    if (!line.includes('rate_limit_event')) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'rate_limit_event' && event.rate_limit_info) info = event.rate_limit_info;
    } catch {
      /* not a JSON line */
    }
  }
  return info;
}

export const PROBE_ARGS = [
  '-p', 'ok',
  '--model', 'claude-haiku-4-5',
  '--system-prompt', 'Reply ok.',
  '--tools', '',
  '--setting-sources', '',
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--no-session-persistence',
  '--output-format', 'stream-json', '--verbose',
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function recordReading(info, source, { cache = CACHE, now = Date.now() } = {}) {
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, JSON.stringify({ at: now, source, info }));
}

// One synchronous probe with the work token. Throws with a plain reason.
export function runProbe({ token = readWorkToken(), run = spawnSync, cache = CACHE } = {}) {
  if (!token) throw new Error(`no work token (run \`claude-work login\`, or set CLAUDE_WORK_OAUTH_TOKEN)`);
  const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_SESSION_ID']) delete env[k];
  const res = run('claude', PROBE_ARGS, {
    env,
    cwd: os.tmpdir(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: PROBE_TIMEOUT_MS,
  });
  const info = rateLimitInfoFrom(res.stdout ?? '');
  if (!info) {
    const why = (res.error?.message || res.stderr || res.stdout || '').trim().split('\n').slice(-1)[0];
    throw new Error(`probe returned no rate-limit reading${why ? `: ${why.slice(0, 200)}` : ''}`);
  }
  recordReading(info, 'probe', { cache });
  return info;
}

// Start a detached probe unless one is already running or the reading is fresh.
export function refreshInBackground({ now = Date.now(), lock = LOCK, launch = spawn } = {}) {
  const held = readJson(lock);
  if (held && now - held.at < PROBE_LOCK_MS) return false;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ at: now }));
  const child = launch(process.execPath, [CLI, 'probe', ACCOUNT_ID, '--quiet'], { detached: true, stdio: 'ignore' });
  child.unref?.();
  return true;
}

const minutesAgo = (ms) => Math.max(0, Math.round(ms / 60e3));

export async function claudeWorkProvider({
  token = readWorkToken(),
  cache = CACHE,
  now = Date.now(),
  refresh = refreshInBackground,
} = {}) {
  const base = { id: ACCOUNT_ID, label: LABEL };
  if (!token) {
    return { ...base, configured: false, ok: false, note: 'not set up (run `claude-work login`)', limits: [] };
  }
  const reading = readJson(cache);
  const age = reading ? now - reading.at : Infinity;
  if (age >= PROBE_TTL_MS) refresh({ now });
  if (!reading || age > READING_MAX_AGE_MS) {
    return { ...base, configured: true, ok: false, note: 'first reading in progress (a probe takes ~10 s)', limits: [] };
  }
  // A window whose reset has passed belongs to a period that no longer exists.
  const limits = limitsFromRateLimitInfo(reading.info).filter((l) => !l.resetsAt || Date.parse(l.resetsAt) > now);
  const note = `read ${minutesAgo(age)}m ago from a ${reading.source}` +
    (limits.some((l) => l.label === '5h window') ? '' : '; no 5h window reported (idle)');
  return { ...base, configured: true, ok: limits.length > 0, note, limits, readAt: new Date(reading.at).toISOString() };
}
