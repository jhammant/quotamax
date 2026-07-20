// Per-run token accounting for delegated coding agents. Dollar amounts are
// API list-price equivalents only: subscription runs have no incremental API
// charge, and the rates below are intentionally approximate.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fmtTokens, fmtUSD, priceFor } from './pricing.mjs';

const claudePrice = priceFor('claude-opus-4-8');

export const RATES = Object.freeze({
  codex: Object.freeze({ input: 1.25, cachedInput: 0.125, output: 10 }),
  kimi: Object.freeze({ input: 0.60, cacheRead: 0.15, output: 2.50 }),
  claude: Object.freeze({
    input: claudePrice.in,
    cacheWrite: claudePrice.in * 1.25,
    cacheRead: claudePrice.in * 0.1,
    output: claudePrice.out,
  }),
});

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const recentCutoff = (sinceMin) => Date.now() - number(sinceMin) * 60e3;

function entries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function stat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function newest(files) {
  return files
    .map((file) => ({ file, stat: stat(file) }))
    .filter((item) => item.stat?.isFile())
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || b.file.localeCompare(a.file))[0] ?? null;
}

function eventAt(event, fallbackMs) {
  const value = event?.timestamp ?? event?.at;
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : new Date(fallbackMs).toISOString();
}

/** Read the newest Codex rollout's final cumulative token-usage event. */
export function latestCodexRun({ sessionsDir = path.join(os.homedir(), '.codex', 'sessions'), sinceMin = 60 } = {}) {
  const files = [];
  for (const year of entries(sessionsDir).filter((e) => e.isDirectory() && /^\d{4}$/.test(e.name))) {
    const yearDir = path.join(sessionsDir, year.name);
    for (const month of entries(yearDir).filter((e) => e.isDirectory() && /^\d{2}$/.test(e.name))) {
      const monthDir = path.join(yearDir, month.name);
      for (const day of entries(monthDir).filter((e) => e.isDirectory() && /^\d{2}$/.test(e.name))) {
        const dayDir = path.join(monthDir, day.name);
        for (const file of entries(dayDir)) {
          if (file.isFile() && file.name.startsWith('rollout-') && file.name.endsWith('.jsonl')) {
            files.push(path.join(dayDir, file.name));
          }
        }
      }
    }
  }

  const hit = newest(files);
  if (!hit || hit.stat.mtimeMs < recentCutoff(sinceMin)) return null;

  let lines;
  try {
    lines = fs.readFileSync(hit.file, 'utf8').split('\n');
  } catch {
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('total_token_usage')) continue;
    try {
      const event = JSON.parse(lines[i]);
      const usage = event.payload?.info?.total_token_usage;
      if (!usage || typeof usage !== 'object') continue;
      const input = number(usage.input_tokens);
      const cached = number(usage.cached_input_tokens);
      const output = number(usage.output_tokens);
      return {
        input,
        cached,
        output,
        total: number(usage.total_tokens) || input + output,
        at: eventAt(event, hit.stat.mtimeMs),
      };
    } catch {
      /* malformed streaming line */
    }
  }
  return null;
}

function walkJsonl(dir, parts = [], out = []) {
  for (const entry of entries(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(full, [...parts, entry.name], out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl') && parts.includes('agents')) out.push(full);
  }
  return out;
}

function kimiUsage(event) {
  return event?.usage ?? event?.payload?.usage ?? event?.message?.usage ?? null;
}

/** Sum unique Kimi usage frames across recent agent wire logs. */
export function latestKimiRun({ sessionsDir = path.join(os.homedir(), '.kimi-code', 'sessions'), sinceMin = 60 } = {}) {
  const cutoff = recentCutoff(sinceMin);
  const files = walkJsonl(sessionsDir)
    .map((file) => ({ file, stat: stat(file) }))
    .filter((item) => item.stat?.isFile() && item.stat.mtimeMs >= cutoff);
  if (!files.length) return null;

  const seen = new Set();
  let input = 0;
  let cacheRead = 0;
  let output = 0;
  let total = 0;
  let frames = 0;
  let latestEventMs = null;

  for (const item of files) {
    let lines;
    try {
      lines = fs.readFileSync(item.file, 'utf8').split('\n');
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.includes('usage')) continue;
      try {
        const event = JSON.parse(line);
        const usage = kimiUsage(event);
        if (!usage || typeof usage !== 'object') continue;
        const other = number(usage.inputOther);
        const read = number(usage.inputCacheRead);
        const creation = number(usage.inputCacheCreation);
        const out = number(usage.output);
        const key = `${other}:${out}:${read}`;
        if (seen.has(key)) continue;
        seen.add(key);
        input += other + creation;
        cacheRead += read;
        output += out;
        total += other + creation + read + out;
        frames++;
        const eventMs = Date.parse(event.timestamp ?? event.at);
        if (Number.isFinite(eventMs)) latestEventMs = Math.max(latestEventMs ?? eventMs, eventMs);
      } catch {
        /* malformed streaming line */
      }
    }
  }
  const fallbackAt = Math.max(...files.map((item) => item.stat.mtimeMs));
  return frames ? { input, cacheRead, output, total, at: new Date(latestEventMs ?? fallbackAt).toISOString() } : null;
}

function walkAllJsonl(dir, out = []) {
  for (const entry of entries(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkAllJsonl(full, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

// Claude is supported by the CLI too. Its newest transcript is reduced with
// the same "last frame per message id" rule used by transcripts.mjs.
export function latestClaudeRun({ projectsDir = path.join(os.homedir(), '.claude', 'projects'), sinceMin = 60 } = {}) {
  const hit = newest(walkAllJsonl(projectsDir));
  if (!hit || hit.stat.mtimeMs < recentCutoff(sinceMin)) return null;
  let lines;
  try {
    lines = fs.readFileSync(hit.file, 'utf8').split('\n');
  } catch {
    return null;
  }
  const byId = new Map();
  let latestEventMs = null;
  for (const [index, line] of lines.entries()) {
    if (!line.includes('usage')) continue;
    try {
      const event = JSON.parse(line);
      const usage = event.message?.usage;
      if (!usage) continue;
      byId.set(event.message?.id ?? `line-${index}`, {
        input: number(usage.input_tokens),
        cacheWrite: number(usage.cache_creation_input_tokens),
        cacheRead: number(usage.cache_read_input_tokens),
        output: number(usage.output_tokens),
      });
      const eventMs = Date.parse(event.timestamp);
      if (Number.isFinite(eventMs)) latestEventMs = Math.max(latestEventMs ?? eventMs, eventMs);
    } catch {
      /* malformed transcript line */
    }
  }
  if (!byId.size) return null;
  const result = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0, at: new Date(latestEventMs ?? hit.stat.mtimeMs).toISOString() };
  for (const usage of byId.values()) {
    result.input += usage.input;
    result.cacheWrite += usage.cacheWrite;
    result.cacheRead += usage.cacheRead;
    result.output += usage.output;
  }
  result.total = result.input + result.cacheWrite + result.cacheRead + result.output;
  return result;
}

const cost = (tokens, rate) => (tokens / 1e6) * rate;

/** Price a normalized run at approximate per-million-token list rates. */
export function priceRun(provider, tokens = {}) {
  const id = String(provider).toLowerCase();
  if (!RATES[id]) throw new Error(`unsupported run-cost provider: ${provider}`);
  let breakdown;
  if (id === 'codex') {
    const input = number(tokens.input ?? tokens.in);
    const cached = Math.min(input, number(tokens.cached ?? tokens.cachedInput));
    breakdown = {
      input: cost(input - cached, RATES.codex.input),
      cachedInput: cost(cached, RATES.codex.cachedInput),
      output: cost(number(tokens.output ?? tokens.out), RATES.codex.output),
    };
  } else if (id === 'kimi') {
    breakdown = {
      input: cost(number(tokens.input ?? tokens.in), RATES.kimi.input),
      cacheRead: cost(number(tokens.cacheRead ?? tokens.cached), RATES.kimi.cacheRead),
      output: cost(number(tokens.output ?? tokens.out), RATES.kimi.output),
    };
  } else {
    breakdown = {
      input: cost(number(tokens.input ?? tokens.in), RATES.claude.input),
      cacheWrite: cost(number(tokens.cacheWrite ?? tokens.cw), RATES.claude.cacheWrite),
      cacheRead: cost(number(tokens.cacheRead ?? tokens.cr ?? tokens.cached), RATES.claude.cacheRead),
      output: cost(number(tokens.output ?? tokens.out), RATES.claude.output),
    };
  }
  return { usd: Object.values(breakdown).reduce((sum, value) => sum + value, 0), breakdown };
}

function cacheRatio(provider, tokens) {
  if (provider === 'codex') {
    const input = number(tokens.input ?? tokens.in);
    return input ? number(tokens.cached ?? tokens.cachedInput) / input : null;
  }
  if (provider === 'kimi') {
    const input = number(tokens.input ?? tokens.in);
    const cached = number(tokens.cacheRead ?? tokens.cached);
    return input + cached ? cached / (input + cached) : null;
  }
  const input = number(tokens.input ?? tokens.in);
  const cached = number(tokens.cacheRead ?? tokens.cr ?? tokens.cached) + number(tokens.cacheWrite ?? tokens.cw);
  return input + cached ? cached / (input + cached) : null;
}

/** Format one compact post-run cost line. */
export function fmtRun(provider, tokens = {}, usd = 0) {
  const id = String(provider).toLowerCase();
  const total = number(tokens.total) ||
    number(tokens.input ?? tokens.in) + number(tokens.output ?? tokens.out) +
    (id === 'codex' ? 0 : number(tokens.cacheRead ?? tokens.cr ?? tokens.cached) + number(tokens.cacheWrite ?? tokens.cw));
  const ratio = cacheRatio(id, tokens);
  const cached = ratio == null ? '' : ` (${Math.round(ratio * 100)}% cached)`;
  return `${id}: ${fmtTokens(total)} tokens${cached} · ~${fmtUSD(number(usd))} API-equiv`;
}

function snapshotRows(snapshot = {}) {
  if (Array.isArray(snapshot)) return snapshot;
  return Object.entries(snapshot).map(([provider, value]) => ({
    provider,
    ...(typeof value === 'number' ? { percent: value } : value),
  }));
}

function normalizeSnapshot(snapshot) {
  const out = new Map();
  for (const row of snapshotRows(snapshot)) {
    const provider = String(row.provider ?? row.id ?? '').toLowerCase();
    if (!provider) continue;
    const raw = row.percent ?? row.weekly?.percent;
    const percent = raw == null ? null : Number(raw);
    out.set(provider, {
      provider,
      label: row.label ?? (provider === 'claude' ? 'Claude' : provider[0].toUpperCase() + provider.slice(1)),
      percent: Number.isFinite(percent) ? percent : null,
    });
  }
  return out;
}

const compactNumber = (n) => Number(n.toFixed(2)).toString();
const percent = (n) => n == null ? '?' : `${compactNumber(n)}%`;

function elapsed(elapsedMs) {
  const ms = Math.max(0, number(elapsedMs));
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Assemble both the structured and human-readable measure report, without I/O. */
export function buildMeasureReport({ before = {}, after = {}, runs = {}, elapsedMs = 0 } = {}) {
  const first = normalizeSnapshot(before);
  const second = normalizeSnapshot(after);
  const order = ['claude', 'codex', 'kimi'];
  const providers = [...new Set([...first.keys(), ...second.keys()])]
    .sort((a, b) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)) || a.localeCompare(b));
  const pools = providers.map((provider) => {
    const a = first.get(provider);
    const b = second.get(provider);
    const beforePercent = a?.percent ?? null;
    const afterPercent = b?.percent ?? null;
    const deltaPercent = beforePercent == null || afterPercent == null ? null : afterPercent - beforePercent;
    const delta = deltaPercent == null ? '?' : Math.abs(deltaPercent) < 1
      ? '~0%'
      : `${deltaPercent > 0 ? '+' : ''}${compactNumber(deltaPercent)}%`;
    const label = b?.label ?? a?.label ?? provider;
    return {
      provider,
      label,
      beforePercent,
      afterPercent,
      deltaPercent,
      delta,
      line: `${label} weekly: ${percent(beforePercent)} → ${percent(afterPercent)} (Δ ${delta})`,
    };
  });

  const runReports = {};
  for (const [provider, run] of Object.entries(runs ?? {})) {
    if (!run) continue;
    const tokens = run.tokens ?? run;
    const priced = run.usd == null ? priceRun(provider, tokens) : { usd: run.usd, breakdown: run.breakdown };
    runReports[provider] = {
      tokens,
      usd: priced.usd,
      breakdown: priced.breakdown,
      at: run.at ?? tokens.at ?? null,
      line: fmtRun(provider, tokens, priced.usd),
    };
  }
  const elapsedText = elapsed(elapsedMs);
  const lines = [`elapsed: ${elapsedText}`, ...pools.map((pool) => pool.line), ...Object.values(runReports).map((run) => run.line)];
  return { elapsedMs: Math.max(0, number(elapsedMs)), elapsed: elapsedText, pools, runs: runReports, text: lines.join('\n') };
}

/** Split measure's own arguments from the command following the required `--`. */
export function splitMeasureArgs(argv = []) {
  const separator = argv.indexOf('--');
  return {
    options: separator < 0 ? [...argv] : argv.slice(0, separator),
    command: separator < 0 ? [] : argv.slice(separator + 1),
  };
}
