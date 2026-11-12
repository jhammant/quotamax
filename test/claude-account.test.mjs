import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  limitsFromRateLimitInfo, rateLimitInfoFrom, claudeWorkProvider, recordReading, runProbe, PROBE_TTL_MS,
} from '../src/providers/claude-account.mjs';

const tmpCache = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qm-cw-')), 'reading.json');
const inHours = (h) => Math.floor(Date.now() / 1000) + h * 3600;

describe('limitsFromRateLimitInfo', () => {
  test('maps account-wide windows to 5h and weekly percentages', () => {
    const limits = limitsFromRateLimitInfo({
      status: 'allowed',
      unifiedWindows: {
        five_hour: { utilization: 0.42, resetsAt: inHours(2) },
        seven_day: { utilization: 0.27, resetsAt: inHours(100) },
      },
    });
    assert.deepEqual(limits.map((l) => [l.label, l.percent, l.scope]), [
      ['5h window', 42, undefined],
      ['weekly', 27, undefined],
    ]);
  });

  test('keeps a per-model window apart, with its model as scope', () => {
    const [fable] = limitsFromRateLimitInfo({ unifiedWindows: { seven_day_fable: { utilization: 0.9, resetsAt: inHours(50) } } });
    assert.equal(fable.scope, 'Fable');
    assert.equal(fable.label, 'Fable weekly');
    assert.equal(fable.percent, 90);
  });

  test('a rejected account reads as 100% even when windows look low', () => {
    const limits = limitsFromRateLimitInfo({ status: 'rejected', unifiedWindows: { seven_day: { utilization: 0.5 } } });
    assert.ok(limits.some((l) => !l.scope && l.percent === 100));
  });
});

describe('rateLimitInfoFrom', () => {
  test('finds the last rate_limit_event in a stream-json transcript', () => {
    const stream = [
      '{"type":"system","subtype":"init"}',
      '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"seven_day":{"utilization":0.1}}}}',
      'not json rate_limit_event',
      '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","unifiedWindows":{"seven_day":{"utilization":0.8}}}}',
      '{"type":"result","subtype":"success"}',
    ].join('\n');
    assert.equal(rateLimitInfoFrom(stream).status, 'allowed_warning');
  });

  test('null when the run reported nothing', () => {
    assert.equal(rateLimitInfoFrom('{"type":"result"}'), null);
  });
});

describe('claudeWorkProvider', () => {
  test('no token: reported as not set up, and no probe launched', async () => {
    let launched = false;
    const p = await claudeWorkProvider({ token: null, cache: tmpCache(), refresh: () => { launched = true; } });
    assert.equal(p.configured, false);
    assert.match(p.note, /claude-work login/);
    assert.equal(launched, false);
  });

  test('fresh reading: served as-is, no probe launched', async () => {
    const cache = tmpCache();
    recordReading({ unifiedWindows: { seven_day: { utilization: 0.3, resetsAt: inHours(24) } } }, 'probe', { cache });
    let launched = false;
    const p = await claudeWorkProvider({ token: 't', cache, refresh: () => { launched = true; } });
    assert.equal(p.ok, true);
    assert.equal(p.limits[0].percent, 30);
    assert.equal(launched, false);
  });

  test('reading older than the TTL: still served, and a background probe starts', async () => {
    const cache = tmpCache();
    const now = Date.now();
    recordReading({ unifiedWindows: { seven_day: { utilization: 0.3, resetsAt: inHours(24) } } }, 'probe', { cache, now: now - PROBE_TTL_MS - 1 });
    let launched = false;
    const p = await claudeWorkProvider({ token: 't', cache, now, refresh: () => { launched = true; } });
    assert.equal(p.ok, true);
    assert.equal(launched, true);
  });

  test('no reading yet: not ok, says a probe is running', async () => {
    let launched = false;
    const p = await claudeWorkProvider({ token: 't', cache: tmpCache(), refresh: () => { launched = true; } });
    assert.equal(p.ok, false);
    assert.equal(launched, true);
    assert.match(p.note, /first reading/);
  });

  test('a window whose reset has passed is dropped, never drawn', async () => {
    const cache = tmpCache();
    recordReading({ unifiedWindows: { seven_day: { utilization: 0.9, resetsAt: inHours(-1) } } }, 'probe', { cache });
    const p = await claudeWorkProvider({ token: 't', cache, refresh: () => {} });
    assert.equal(p.ok, false);
    assert.deepEqual(p.limits, []);
  });
});

describe('runProbe', () => {
  test('passes the token by env only, strips competing credentials, records the reading', () => {
    const cache = tmpCache();
    let seen;
    const run = (cmd, argv, opts) => {
      seen = { cmd, argv, env: opts.env };
      return { stdout: '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"seven_day":{"utilization":0.2}}}}\n' };
    };
    process.env.ANTHROPIC_API_KEY = 'should-not-leak';
    try {
      runProbe({ token: 'work-token', run, cache });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
    assert.equal(seen.cmd, 'claude');
    assert.equal(seen.env.CLAUDE_CODE_OAUTH_TOKEN, 'work-token');
    assert.equal(seen.env.ANTHROPIC_API_KEY, undefined);
    assert.ok(!seen.argv.includes('work-token'), 'token must never be on argv');
    assert.ok(seen.argv.includes('--no-session-persistence'));
    assert.equal(JSON.parse(fs.readFileSync(cache, 'utf8')).info.status, 'allowed');
  });

  test('no token: a plain error naming the fix', () => {
    assert.throws(() => runProbe({ token: null, run: () => ({}) }), /claude-work login/);
  });
});
