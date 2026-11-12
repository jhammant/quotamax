// DeepSeek credit provider: balance reads, low-credit threshold, key
// resolution order, key redaction and the agent backstop shape. fetch and
// child_process are injected — no real network, no real keychain, and the only
// key in play is the fake `sk-test-not-a-real-key`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  deepseekProvider,
  fromBalance,
  backstopEntry,
  redactKey,
  resolveApiKey,
  lowThreshold,
} from '../src/providers/deepseek.mjs';

const KEY = 'sk-test-not-a-real-key';

// Deps with every external surface stubbed "absent": no keychain entry, no
// env file. fetchImpl must be supplied per test.
const stubDeps = (over = {}) => ({
  env: {},
  platform: 'linux', // skips the macOS keychain branch entirely
  execFile: () => {
    throw new Error('no keychain entry');
  },
  readFile: () => {
    throw new Error('no env file');
  },
  fetchImpl: () => {
    throw new Error('fetchImpl not stubbed');
  },
  ...over,
});

const balanceBody = (total, { available = true, currency = 'USD' } = {}) => ({
  is_available: available,
  balance_infos: [
    { currency, total_balance: total, granted_balance: '0.00', topped_up_balance: total },
  ],
});

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

describe('resolveApiKey — lookup order', () => {
  test('env DEEPSEEK_API_KEY wins', () => {
    assert.equal(resolveApiKey(stubDeps({ env: { DEEPSEEK_API_KEY: KEY } })), KEY);
  });

  test('macOS keychain is consulted when env is empty', () => {
    const key = resolveApiKey(
      stubDeps({
        platform: 'darwin',
        execFile: (cmd, args) => {
          assert.equal(cmd, 'security');
          assert.deepEqual(args.slice(0, 2), ['find-generic-password', '-a']);
          assert.ok(args.includes('-s') && args.includes('deepseek-api-key'));
          return KEY + '\n';
        },
      }),
    );
    assert.equal(key, KEY);
  });

  test('falls back to ~/.config/deepseek/env', () => {
    const key = resolveApiKey(stubDeps({ readFile: () => 'export DEEPSEEK_API_KEY="' + KEY + '"\n' }));
    assert.equal(key, KEY);
  });

  test('no key anywhere → null', () => {
    assert.equal(resolveApiKey(stubDeps()), null);
  });
});

describe('deepseekProvider', () => {
  test('normal balance: ok, available, not low', async () => {
    let seenAuth = null;
    const p = await deepseekProvider(
      stubDeps({
        env: { DEEPSEEK_API_KEY: KEY },
        fetchImpl: async (url, opts) => {
          assert.equal(url, 'https://api.deepseek.com/user/balance');
          seenAuth = opts.headers.Authorization;
          return jsonResponse(balanceBody('50.00'));
        },
      }),
    );
    assert.equal(seenAuth, 'Bearer ' + KEY);
    assert.equal(p.id, 'deepseek');
    assert.equal(p.kind, 'credit');
    assert.equal(p.ok, true);
    assert.equal(p.available, true);
    assert.equal(p.balanceUsd, 50);
    assert.equal(p.currency, 'USD');
    assert.equal(p.low, false);
    assert.deepEqual(p.limits, []);
  });

  test('balance under the default $5 threshold is flagged low', async () => {
    const p = await deepseekProvider(
      stubDeps({ env: { DEEPSEEK_API_KEY: KEY }, fetchImpl: async () => jsonResponse(balanceBody('3.25')) }),
    );
    assert.equal(p.ok, true);
    assert.equal(p.balanceUsd, 3.25);
    assert.equal(p.low, true);
  });

  test('DEEPSEEK_LOW_BALANCE_USD overrides the threshold', async () => {
    const p = await deepseekProvider(
      stubDeps({
        env: { DEEPSEEK_API_KEY: KEY, DEEPSEEK_LOW_BALANCE_USD: '60' },
        fetchImpl: async () => jsonResponse(balanceBody('50.00')),
      }),
    );
    assert.equal(p.thresholdUsd, 60);
    assert.equal(p.low, true);
  });

  test('is_available false: reading ok but pool marked unavailable', async () => {
    const p = await deepseekProvider(
      stubDeps({ env: { DEEPSEEK_API_KEY: KEY }, fetchImpl: async () => jsonResponse(balanceBody('50.00', { available: false })) }),
    );
    assert.equal(p.ok, true);
    assert.equal(p.available, false);
    assert.match(p.note, /unavailable/);
  });

  test('no key: not configured, and fetch is never attempted', async () => {
    let fetched = false;
    const p = await deepseekProvider(
      stubDeps({
        fetchImpl: async () => {
          fetched = true;
          return jsonResponse(balanceBody('50.00'));
        },
      }),
    );
    assert.equal(fetched, false);
    assert.equal(p.configured, false);
    assert.equal(p.ok, false);
    assert.match(p.note, /no API key/);
  });

  test('HTTP error: note reports the status and redacts any key in the body', async () => {
    const p = await deepseekProvider(
      stubDeps({
        env: { DEEPSEEK_API_KEY: KEY },
        fetchImpl: async () => ({
          ok: false,
          status: 401,
          text: async () => '{"error":{"message":"invalid api key sk-abcdef1234567890 provided"}}',
        }),
      }),
    );
    assert.equal(p.ok, false);
    assert.match(p.note, /HTTP 401/);
    assert.ok(!p.note.includes('sk-abcdef1234567890'), 'key must not leak into the note');
    assert.ok(p.note.includes('sk-***'));
  });

  test('network failure: note is redacted and never throws', async () => {
    const p = await deepseekProvider(
      stubDeps({
        env: { DEEPSEEK_API_KEY: KEY },
        fetchImpl: async () => {
          throw new Error('request to https://api.deepseek.com failed, reason: bad key sk-abcdef1234567890');
        },
      }),
    );
    assert.equal(p.ok, false);
    assert.ok(!p.note.includes('sk-abcdef1234567890'));
    assert.match(p.note, /balance read failed/);
  });
});

describe('fromBalance / redactKey / lowThreshold units', () => {
  test('unreadable payload → ok:false rather than a throw', () => {
    const p = fromBalance({ is_available: true, balance_infos: [] });
    assert.equal(p.ok, false);
    assert.equal(fromBalance(null).ok, false);
  });

  test('redactKey strips sk- tokens of 8+ chars only', () => {
    assert.equal(redactKey('oops sk-abcdef1234567890 tail'), 'oops sk-*** tail');
    assert.equal(redactKey('short sk-abc kept'), 'short sk-abc kept');
  });

  test('lowThreshold defaults to 5 and ignores junk', () => {
    assert.equal(lowThreshold({}), 5);
    assert.equal(lowThreshold({ DEEPSEEK_LOW_BALANCE_USD: 'nope' }), 5);
    assert.equal(lowThreshold({ DEEPSEEK_LOW_BALANCE_USD: '12.5' }), 12.5);
  });
});

describe('backstopEntry — the agent JSON shape', () => {
  test('usable pool → available with balance and low flag', () => {
    assert.deepEqual(backstopEntry(fromBalance(balanceBody('50.00'), 5)), {
      provider: 'deepseek',
      available: true,
      balanceUsd: 50,
      low: false,
    });
  });

  test('low but positive balance is still available', () => {
    const b = backstopEntry(fromBalance(balanceBody('1.00'), 5));
    assert.equal(b.available, true);
    assert.equal(b.low, true);
  });

  test('is_available false or zero balance → not available', () => {
    assert.equal(backstopEntry(fromBalance(balanceBody('50.00', { available: false }), 5)).available, false);
    assert.equal(backstopEntry(fromBalance(balanceBody('0.00'), 5)).available, false);
  });

  test('unconfigured / failed read → not available, null balance', () => {
    assert.deepEqual(backstopEntry({ configured: false, ok: false }), {
      provider: 'deepseek',
      available: false,
      balanceUsd: null,
      low: null,
    });
  });
});
