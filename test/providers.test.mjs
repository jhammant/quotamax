import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { paceSurplus, getOtherProviders } from '../src/providers/index.mjs';
import { limitsFromUsages } from '../src/providers/kimi.mjs';
import { windowMeta, windowLimit } from '../src/providers/codex.mjs';

const HOUR_S = 3600; // codex resets_at is unix seconds
const nowS = () => Math.floor(Date.now() / 1000);

const HOUR = 3.6e6;
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();

describe('paceSurplus', () => {
  test('null percent or missing reset → no surplus', () => {
    assert.equal(paceSurplus(null, iso(24 * HOUR), 7), false);
    assert.equal(paceSurplus(10, null, 7), false);
  });

  test('usage trailing the linear pace by 15+ points → surplus', () => {
    // 7-day cycle, ~1 day left → expected ≈ 85.7%; used 10% → far behind pace.
    assert.equal(paceSurplus(10, iso(24 * HOUR), 7), true);
  });

  test('usage keeping pace → no surplus', () => {
    // 7-day cycle, ~1 day left → expected ≈ 85.7%; used 80% → within 15 pts.
    assert.equal(paceSurplus(80, iso(24 * HOUR), 7), false);
  });
});

// The GET /coding/v1/usages payload → windowed limit bars. The 5h window is the
// entry in `limits[]` whose window resolves to ≤6h; the weekly window is `usage`.
const usages = ({ weekly, five } = {}) => ({
  user: { membership: { level: 'LEVEL_ADVANCED' } },
  usage: weekly ?? { limit: '100', used: '17', remaining: '83', resetTime: '2026-07-24T10:44:51Z' },
  limits: five === null ? [] : [{
    window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
    detail: five ?? { limit: '100', used: '30', remaining: '70', resetTime: '2026-07-19T22:44:51Z' },
  }],
});

describe('limitsFromUsages', () => {
  test('maps the 5h window then the weekly window with percents + resets', () => {
    assert.deepEqual(limitsFromUsages(usages()), [
      { label: '5h window', percent: 30, unit: '%', resetsAt: '2026-07-19T22:44:51Z' },
      { label: 'weekly', percent: 17, unit: '%', resetsAt: '2026-07-24T10:44:51Z' },
    ]);
  });

  test('computes percent from used/limit when limit is not 100', () => {
    const out = limitsFromUsages(usages({ five: { limit: '200', used: '50', resetTime: 'x' } }));
    assert.equal(out.find((l) => l.label === '5h window').percent, 25); // 50/200
  });

  test('recognises an hour-unit 5h window (duration 5, TIME_UNIT_HOUR)', () => {
    const data = usages();
    data.limits[0].window = { duration: 5, timeUnit: 'TIME_UNIT_HOUR' };
    assert.equal(limitsFromUsages(data)[0].label, '5h window');
  });

  test('missing 5h window → weekly only', () => {
    assert.deepEqual(limitsFromUsages(usages({ five: null })).map((l) => l.label), ['weekly']);
  });

  test('drops windows with an unparseable / zero limit', () => {
    assert.deepEqual(limitsFromUsages(usages({ weekly: { limit: '0', used: '0' }, five: { limit: 'x', used: '1' } })), []);
  });

  test('empty / missing payload → [] (never throws)', () => {
    assert.deepEqual(limitsFromUsages({}), []);
    assert.deepEqual(limitsFromUsages(null), []);
  });
});

describe('codex windowMeta — label by window length, not slot', () => {
  test('300 min → 5h window', () => assert.equal(windowMeta(300).label, '5h window'));
  test('10080 min (7d) → weekly', () => assert.equal(windowMeta(10080).label, 'weekly'));
  test('null → generic window', () => assert.equal(windowMeta(null).label, 'window'));
  test('1440 min (24h) → 24h window', () => assert.equal(windowMeta(1440).label, '24h window'));
  test('4320 min (72h) → 3d window', () => assert.equal(windowMeta(4320).label, '3d window'));
});

describe('codex windowLimit', () => {
  test("the weekly cap in the `primary` slot is labeled 'weekly' (the bug we fixed)", () => {
    const l = windowLimit({ used_percent: 19, window_minutes: 10080, resets_at: nowS() + 48 * HOUR_S });
    assert.equal(l.label, 'weekly');
    assert.equal(l.percent, 19);
    assert.equal(l.stale, false);
  });

  test('a window whose resets_at has passed is flagged stale, keeps its last %', () => {
    const l = windowLimit({ used_percent: 19, window_minutes: 10080, resets_at: nowS() - 3 * HOUR_S });
    assert.match(l.label, /weekly \(stale/);
    assert.equal(l.stale, true);
    assert.equal(l.percent, 19); // last real reading, not a fabricated 0
    assert.equal(l.surplus, false); // never claim surplus on stale data
  });

  test('null window or missing used_percent → null (dropped)', () => {
    assert.equal(windowLimit(null), null);
    assert.equal(windowLimit({ window_minutes: 300 }), null);
  });
});

describe('getOtherProviders', () => {
  test('always resolves to an array of provider shapes, never throws', async () => {
    const all = await getOtherProviders();
    assert.ok(Array.isArray(all));
    for (const p of all) {
      assert.equal(typeof p.id, 'string');
      assert.equal(typeof p.label, 'string');
      assert.equal(typeof p.configured, 'boolean');
      assert.equal(typeof p.ok, 'boolean');
      assert.ok(Array.isArray(p.limits));
    }
  });
});
