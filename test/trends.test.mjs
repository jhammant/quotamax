import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  burnStats, metricsFor, renderChart, usageComparison, sparkline, weekdayProfile, shapedProjection, shapedWalk, weekForecast,
} from '../src/trends.mjs';

const HOUR = 3.6e6;
const DAY = 24 * HOUR;
const RESET = Date.parse('2026-07-14T08:00:00Z');
const WEEK_START = RESET - 168 * HOUR;

function climb(perDay, days, stepH = 6) {
  const pts = [];
  for (let h = 0; h <= days * 24; h += stepH) {
    pts.push({ t: WEEK_START + h * HOUR, v: (h / 24) * perDay });
  }
  return pts;
}

describe('metricsFor', () => {
  test('mid-week linear expectations', () => {
    const m = metricsFor(
      { weekly: { percent: 30, resetsAt: new Date(WEEK_START + 168 * HOUR).toISOString() } },
      WEEK_START + 3.5 * DAY,
    );
    assert.equal(Math.round(m.expectedPercent), 50);
    assert.equal(Math.round(m.paceDelta), -20);
  });

  test('null resetsAt reads as a full week ahead, never NaN', () => {
    const m = metricsFor({ weekly: { percent: 0, resetsAt: null } }, WEEK_START);
    assert.equal(m.hoursToReset, 168);
    assert.ok(Number.isFinite(m.paceDelta));
  });
});

describe('burnStats', () => {
  test('steady 10 pts/day: projection and expiry are consistent', () => {
    const s = burnStats(climb(10, 2), RESET, WEEK_START + 2 * DAY);
    assert.equal(Math.round(s.ratePerDay), 10);
    assert.equal(Math.round(s.projectedEnd), 70);
    assert.equal(Math.round(s.wouldExpire), 30);
    assert.equal(Math.round(s.neededPerDay), 16);
  });

  test('rate uses the last-24h window, not the whole week', () => {
    const pts = [
      { t: WEEK_START, v: 0 },
      { t: WEEK_START + 2 * DAY, v: 0 },
      { t: WEEK_START + 3 * DAY, v: 12 },
    ];
    assert.equal(Math.round(burnStats(pts, RESET, WEEK_START + 3 * DAY).ratePerDay), 12);
  });

  test('over-pace burn predicts early exhaustion', () => {
    const s = burnStats(climb(25, 2), RESET, WEEK_START + 2 * DAY); // 50% at day 2
    assert.ok(s.exhaustsInH != null);
    assert.ok(Math.abs(s.exhaustsInH - 48) < 1, `got ${s.exhaustsInH}`); // 50 left / 25 per day
  });

  test('no points: zero rate, everything expires', () => {
    const s = burnStats([], RESET, WEEK_START + 3 * DAY);
    assert.equal(s.ratePerDay, 0);
    assert.equal(Math.round(s.wouldExpire), 100);
    assert.equal(s.exhaustsInH, null);
  });

  test('projection clamps at 100', () => {
    const s = burnStats(climb(40, 1), RESET, WEEK_START + 1 * DAY);
    assert.equal(s.projectedEnd, 100);
    assert.equal(s.wouldExpire, 0);
  });
});

describe('usageComparison', () => {
  test('week-to-date vs prior-21-day average', () => {
    const daily = {};
    const day = (t) => new Date(t).toISOString().slice(0, 10);
    for (let i = 1; i <= 21; i++) daily[day(WEEK_START - i * DAY)] = 900_000;
    daily[day(WEEK_START)] = 300_000;
    daily[day(WEEK_START + DAY)] = 300_000;
    const c = usageComparison(daily, RESET, WEEK_START + 2 * DAY);
    assert.equal(Math.round(c.priorAvg), 900_000);
    assert.equal(Math.round(c.thisAvg), 300_000);
    assert.ok(c.pctDiff < -60 && c.pctDiff > -70);
  });

  test('no history → pctDiff null, not NaN', () => {
    assert.equal(usageComparison({}, RESET, WEEK_START + DAY).pctDiff, null);
  });
});

describe('renderChart', () => {
  test('renders grid, day labels starting after reset day, legend', () => {
    const out = renderChart(climb(10, 2), RESET, WEEK_START + 2 * DAY, 10);
    const lines = out.split('\n');
    assert.equal(lines.length, 13);
    assert.ok(out.includes('█ actual'));
    assert.ok(out.includes('░'));
    // RESET is a Tuesday → first day label is Tue
    assert.ok(lines[11].trim().startsWith('Tue'));
  });
});

describe('weekdayProfile', () => {
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const NOW = Date.parse('2026-07-08T12:00:00Z'); // a Wednesday

  test('uniform history → flat profile of 1s', () => {
    const daily = {};
    for (let i = 1; i <= 28; i++) daily[day(NOW - i * DAY)] = 100;
    const p = weekdayProfile(daily, NOW);
    for (const v of p) assert.ok(Math.abs(v - 1) < 1e-9);
  });

  test('weekend-free history → weekend intensity near zero, weekdays above 1', () => {
    const daily = {};
    for (let i = 1; i <= 28; i++) {
      const t = NOW - i * DAY;
      const dow = new Date(t).getUTCDay();
      daily[day(t)] = dow === 0 || dow === 6 ? 0 : 700;
    }
    const p = weekdayProfile(daily, NOW);
    assert.ok(p[0] < 0.01 && p[6] < 0.01, `weekend got ${p[0]}, ${p[6]}`);
    assert.ok(p[1] > 1.2, `Monday got ${p[1]}`);
  });

  test('insufficient history → flat (no evidence, no distortion)', () => {
    const p = weekdayProfile({ '2026-07-06': 100 }, NOW);
    for (const v of p) assert.equal(v, 1);
  });
});

describe('shapedProjection', () => {
  test('flat profile equals the linear projection', () => {
    const now = WEEK_START + 2 * DAY;
    const flat = Array(7).fill(1);
    const shaped = shapedProjection(20, 10, flat, now, RESET);
    assert.ok(Math.abs(shaped - 70) < 0.5, `got ${shaped}`); // 20 + 10*5
  });

  test('zero-intensity remaining days add nothing', () => {
    const now = WEEK_START + 2 * DAY;
    const dead = Array(7).fill(0);
    dead[new Date(now).getDay()] = 1; // only today burns
    const shaped = shapedProjection(20, 10, dead, now, RESET);
    assert.ok(shaped < 30, `got ${shaped}`); // only the rest of today accrues
  });

  test('clamps at 100', () => {
    const shaped = shapedProjection(90, 50, Array(7).fill(1), WEEK_START + DAY, RESET);
    assert.equal(shaped, 100);
  });
});

describe('shapedWalk', () => {
  test('flat profile: reaches 100% when the linear burn would', () => {
    const now = WEEK_START + 2 * DAY;
    const w = shapedWalk(50, 25, Array(7).fill(1), now, RESET); // 50 left at 25/day
    assert.equal(w.endPercent, 100);
    assert.ok(Math.abs(w.exhaustsAtMs - (now + 48 * HOUR)) < 1000, `got ${(w.exhaustsAtMs - now) / HOUR}h`);
  });

  test('does not reach 100% before the reset → exhaustsAtMs null', () => {
    const w = shapedWalk(20, 10, Array(7).fill(1), WEEK_START + 2 * DAY, RESET);
    assert.ok(Math.abs(w.endPercent - 70) < 0.5);
    assert.equal(w.exhaustsAtMs, null);
  });

  test('quiet days ahead: a burn that would run out linearly stays under 100%', () => {
    const now = new Date(2026, 6, 8, 12).getTime(); // local noon
    const intensity = Array(7).fill(0.2);
    intensity[new Date(now).getDay()] = 1;
    // linear: 60 + 20/day × 3 days = 120 → out. Shaped: +10 rest of today, +10 over 2.5 quiet days.
    const w = shapedWalk(60, 20, intensity, now, now + 3 * DAY);
    assert.ok(Math.abs(w.endPercent - 80) < 0.5, `got ${w.endPercent}`);
    assert.equal(w.exhaustsAtMs, null);
  });

  test('already at 100% → exhausted now', () => {
    const now = WEEK_START + 2 * DAY;
    assert.equal(shapedWalk(100, 5, Array(7).fill(1), now, RESET).exhaustsAtMs, now);
  });
});

describe('weekForecast', () => {
  const day = (t) => new Date(t).toISOString().slice(0, 10);

  test('is the trend maths: burnStats + weekdayProfile + shapedProjection', () => {
    const now = WEEK_START + 2 * DAY;
    const daily = {};
    for (let i = 1; i <= 28; i++) {
      const dow = new Date(now - i * DAY).getUTCDay();
      daily[day(now - i * DAY)] = dow === 0 || dow === 6 ? 0 : 700;
    }
    const points = climb(12, 2);
    const f = weekForecast(points, RESET, daily, now);
    const stats = burnStats(points, RESET, now);
    const intensity = weekdayProfile(daily, now);
    assert.deepEqual(f.stats, stats);
    assert.deepEqual(f.intensity, intensity);
    assert.equal(f.shapedEnd, shapedProjection(stats.current, stats.ratePerDay, intensity, now, RESET));
    assert.equal(f.forecast.shapedEndPercent, Number(f.shapedEnd.toFixed(1)));
  });

  test('over pace: runsOut, with hours until the quota is gone', () => {
    const f = weekForecast(climb(25, 2), RESET, {}, WEEK_START + 2 * DAY); // 50% at day 2
    assert.deepEqual(f.forecast, { runsOut: true, shapedEndPercent: 100, exhaustsInHours: 48 });
  });

  test('under pace: does not run out, exhaustsInHours null', () => {
    const f = weekForecast(climb(10, 2), RESET, {}, WEEK_START + 2 * DAY);
    assert.equal(f.forecast.runsOut, false);
    assert.equal(f.forecast.exhaustsInHours, null);
    assert.ok(Math.abs(f.forecast.shapedEndPercent - 70) < 0.5);
  });

  test('runsOut follows the weekday-shaped projection, not the linear one', () => {
    // History burns only on Wednesdays; it is Wednesday noon with 3 days to the reset.
    const now = Date.parse('2026-07-08T12:00:00Z');
    const daily = {};
    for (let i = 1; i <= 28; i++) daily[day(now - i * DAY)] = new Date(now - i * DAY).getUTCDay() === 3 ? 1000 : 0;
    const points = [{ t: now - 20 * HOUR, v: 25 }, { t: now, v: 50 }]; // 30 pts/day
    const f = weekForecast(points, now + 3 * DAY, daily, now);
    assert.ok(f.stats.exhaustsInH < f.stats.remainH, 'the linear burn would run out');
    assert.equal(f.forecast.runsOut, false);
    assert.equal(f.forecast.exhaustsInHours, null);
    // At most the rest of today burns (a full local day at UTC-12): 50 + 30.
    assert.ok(f.forecast.shapedEndPercent <= 80, `got ${f.forecast.shapedEndPercent}`);
  });
});

describe('sparkline', () => {
  test('scales to max and returns one char per value', () => {
    const s = sparkline([0, 5, 10]);
    assert.equal(s.length, 3);
    assert.equal(s[2], '█');
    assert.equal(s[0], '▁');
  });
});
