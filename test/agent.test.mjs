import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { advise, exitCodeFor } from '../src/agent.mjs';

const HOUR = 3.6e6;
const NOW = Date.parse('2026-07-10T12:00:00Z');

function quota({ session = 10, weekly = 20, hoursToReset = 84, sessionResetH = 3 } = {}) {
  return {
    session: { percent: session, resetsAt: new Date(NOW + sessionResetH * HOUR).toISOString() },
    weekly: { percent: weekly, resetsAt: new Date(NOW + hoursToReset * HOUR).toISOString() },
    scoped: [],
  };
}

describe('advise', () => {
  test('cool session + well behind pace → abundant, wide parallelism', () => {
    // mid-week (84h to reset → expected 50%), only 20% used → 30 pts behind
    const a = advise(quota({ session: 10, weekly: 20 }), NOW);
    assert.equal(a.headroom, 'abundant');
    assert.equal(a.advice.parallelism, 8);
    assert.equal(a.advice.modelTier, 'top');
  });

  test('on pace → comfortable', () => {
    const a = advise(quota({ session: 10, weekly: 50 }), NOW); // delta 0
    assert.equal(a.headroom, 'comfortable');
    assert.equal(a.advice.parallelism, 4);
  });

  test('hot session window → constrained even if weekly is fine', () => {
    const a = advise(quota({ session: 75, weekly: 20 }), NOW);
    assert.equal(a.headroom, 'constrained');
    assert.equal(a.advice.modelTier, 'mid');
  });

  test('ahead of weekly pace → constrained', () => {
    const a = advise(quota({ session: 10, weekly: 70 }), NOW); // 20 pts ahead
    assert.equal(a.headroom, 'constrained');
  });

  test('nearly exhausted session → critical, minimum footprint', () => {
    const a = advise(quota({ session: 95, weekly: 50 }), NOW);
    assert.equal(a.headroom, 'critical');
    assert.equal(a.advice.parallelism, 1);
    assert.equal(a.advice.thinkingEffort, 'low');
  });

  test('weekly at 98 → critical regardless of session', () => {
    assert.equal(advise(quota({ session: 5, weekly: 98 }), NOW).headroom, 'critical');
  });

  test('payload carries minutes-to-reset and rationale', () => {
    const a = advise(quota({ sessionResetH: 2 }), NOW);
    assert.equal(a.session.resetsInMinutes, 120);
    assert.ok(a.advice.rationale.includes('session window'));
    assert.equal(a.ok, true);
  });

  test('null weekly resetsAt does not produce NaN', () => {
    const q = quota();
    q.weekly.resetsAt = null;
    const a = advise(q, NOW);
    assert.ok(a.weekly.resetsInMinutes === null);
    assert.ok(Number.isFinite(a.weekly.paceDelta));
  });
});

describe('advise with reservations', () => {
  test('reserved percent shrinks headroom: behind-pace becomes constrained when mostly reserved', () => {
    // 20% used mid-week is "abundant" (30 pts behind); +55% reserved → effective 75%, 25 ahead → constrained
    const q = quota({ session: 10, weekly: 20 });
    assert.equal(advise(q, NOW, 0).headroom, 'abundant');
    assert.equal(advise(q, NOW, 55).headroom, 'constrained');
  });

  test('reservation pushing effective weekly to 97+ is critical', () => {
    assert.equal(advise(quota({ session: 5, weekly: 60 }), NOW, 40).headroom, 'critical');
  });

  test('payload separates real usage from reservation', () => {
    const a = advise(quota({ weekly: 20 }), NOW, 15);
    assert.equal(a.weekly.percentUsed, 20);
    assert.equal(a.weekly.reservedPercent, 15);
    assert.equal(a.weekly.effectivePercent, 35);
    assert.ok(a.advice.rationale.includes('+15% reserved'));
  });
});

describe('advise with manual override', () => {
  test('override pins the level and labels the rationale', () => {
    const a = advise(quota({ session: 10, weekly: 20 }), NOW, 0, { level: 'constrained' });
    assert.equal(a.headroom, 'constrained');
    assert.equal(a.advice.modelTier, 'mid');
    assert.ok(a.advice.rationale.startsWith('MANUAL OVERRIDE'));
    assert.equal(a.override.level, 'constrained');
  });

  test('unknown override level is ignored', () => {
    const a = advise(quota({ session: 10, weekly: 20 }), NOW, 0, { level: 'bogus' });
    assert.equal(a.headroom, 'abundant');
  });
});

describe('exitCodeFor', () => {
  test('maps levels to shell-friendly codes', () => {
    assert.equal(exitCodeFor('abundant'), 0);
    assert.equal(exitCodeFor('comfortable'), 0);
    assert.equal(exitCodeFor('constrained'), 3);
    assert.equal(exitCodeFor('critical'), 4);
  });
});
