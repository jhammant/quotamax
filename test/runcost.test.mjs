import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  RATES, buildMeasureReport, fmtRun, latestCodexRun, latestKimiRun,
  priceRun, splitMeasureArgs,
} from '../src/runcost.mjs';

const codexFixtures = fileURLToPath(new URL('./fixtures/codex', import.meta.url));
const kimiFixtures = fileURLToPath(new URL('./fixtures/kimi', import.meta.url));
const anyAge = 1e9;

describe('latestCodexRun', () => {
  test('reads the last cumulative usage event and skips malformed lines', () => {
    assert.deepEqual(latestCodexRun({ sessionsDir: codexFixtures, sinceMin: anyAge }), {
      input: 500_000,
      cached: 450_000,
      output: 6_000,
      total: 506_000,
      at: '2026-07-20T10:03:00.000Z',
    });
  });

  test('missing session directory is a clean null', () => {
    assert.equal(latestCodexRun({ sessionsDir: new URL('./fixtures/missing', import.meta.url).pathname, sinceMin: anyAge }), null);
  });
});

describe('latestKimiRun', () => {
  test('sums usage frames, including cache creation, and de-duplicates repeats', () => {
    assert.deepEqual(latestKimiRun({ sessionsDir: kimiFixtures, sinceMin: anyAge }), {
      input: 575,
      cacheRead: 700,
      output: 150,
      total: 1_425,
      at: '2026-07-20T11:00:04.000Z',
    });
  });

  test('missing session directory is a clean null', () => {
    assert.equal(latestKimiRun({ sessionsDir: new URL('./fixtures/missing', import.meta.url).pathname, sinceMin: anyAge }), null);
  });
});

describe('priceRun', () => {
  test('Codex charges cached input at its lower rate without double-counting it', () => {
    const priced = priceRun('codex', { input: 500_000, cached: 450_000, output: 6_000 });
    assert.deepEqual(priced.breakdown, { input: 0.0625, cachedInput: 0.05625, output: 0.06 });
    assert.ok(Math.abs(priced.usd - 0.17875) < 1e-12);
  });

  test('Kimi applies separate regular-input, cache-read, and output rates', () => {
    assert.equal(priceRun('kimi', { input: 1e6, cacheRead: 1e6, output: 1e6 }).usd, 3.25);
  });

  test('Claude reuses claude-opus-4-8 pricing and cache multipliers', () => {
    assert.equal(RATES.claude.input, 5);
    assert.equal(priceRun('claude', { input: 1e6, cacheWrite: 1e6, cacheRead: 1e6, output: 1e6 }).usd, 36.75);
  });
});

describe('fmtRun', () => {
  test('renders a compact token, cache, and API-equivalent cost line', () => {
    assert.equal(
      fmtRun('codex', { input: 500_000, cached: 450_000, output: 6_000, total: 506_000 }, 0.17875),
      'codex: 506k tokens (90% cached) · ~$0.18 API-equiv',
    );
  });
});

describe('measure report', () => {
  test('renders weekly deltas, sub-resolution movement, elapsed time, and run costs', () => {
    const report = buildMeasureReport({
      before: {
        claude: { label: 'Claude', percent: 41 },
        codex: { label: 'Codex', percent: 10 },
        kimi: { label: 'Kimi Code', percent: 20 },
      },
      after: {
        claude: { label: 'Claude', percent: 42 },
        codex: { label: 'Codex', percent: 10 },
        kimi: { label: 'Kimi Code', percent: 21.25 },
      },
      runs: {
        codex: { input: 500_000, cached: 450_000, output: 6_000, total: 506_000 },
      },
      elapsedMs: 1_250,
    });

    assert.equal(report.elapsed, '1.3s');
    assert.equal(report.pools.find((pool) => pool.provider === 'claude').delta, '+1%');
    assert.equal(report.pools.find((pool) => pool.provider === 'codex').delta, '~0%');
    assert.equal(report.pools.find((pool) => pool.provider === 'kimi').delta, '+1.25%');
    assert.match(report.text, /Codex weekly: 10% → 10% \(Δ ~0%\)/);
    assert.match(report.text, /codex: 506k tokens \(90% cached\) · ~\$0\.18 API-equiv/);
  });

  test('splits only at the required command separator', () => {
    assert.deepEqual(splitMeasureArgs(['measure', '--json', '--', 'node', 'script.mjs', '--json']), {
      options: ['measure', '--json'],
      command: ['node', 'script.mjs', '--json'],
    });
    assert.deepEqual(splitMeasureArgs(['measure']), { options: ['measure'], command: [] });
  });
});
