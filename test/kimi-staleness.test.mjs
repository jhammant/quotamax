// Regression: a cached Kimi reading must never be drawn as a live bar once its
// windows have rolled over. Observed 2026-07-25 — a reading from 19 July was
// rendered as "5h window 31%, resets 19/07 (-143.6h)", i.e. a confident bar
// built from a window that had reset six days earlier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLimits, limitsFromUsages } from '../src/providers/kimi.mjs';

const NOW = Date.parse('2026-07-25T23:00:00Z');
const past = new Date(NOW - 6 * 24 * 3600e3).toISOString();
const future = new Date(NOW + 3 * 3600e3).toISOString();

test('openLimits drops windows whose reset has already passed', () => {
  const limits = [
    { label: '5h window', percent: 31, resetsAt: past },
    { label: 'weekly', percent: 17, resetsAt: future },
  ];
  const open = openLimits(limits, NOW);
  assert.equal(open.length, 1);
  assert.equal(open[0].label, 'weekly');
});

test('openLimits keeps limits with no reset time (cannot prove staleness)', () => {
  const open = openLimits([{ label: 'weekly', percent: 5, resetsAt: null }], NOW);
  assert.equal(open.length, 1);
});

test('openLimits returns empty when every window has expired', () => {
  const limits = [
    { label: '5h window', percent: 31, resetsAt: past },
    { label: 'weekly', percent: 17, resetsAt: past },
  ];
  assert.deepEqual(openLimits(limits, NOW), []);
});

test('a fully-expired cached payload yields no renderable limits', () => {
  // shape as returned by GET /coding/v1/usages
  const data = {
    user: { membership: { level: 'LEVEL_ADVANCED' } },
    usage: { limit: '100', used: '17', resetTime: past },
    limits: [
      {
        window: { timeUnit: 'TIME_UNIT_MINUTE', duration: 300 },
        detail: { limit: '100', used: '31', resetTime: past },
      },
    ],
  };
  assert.equal(limitsFromUsages(data).length, 2, 'both windows parse');
  assert.deepEqual(openLimits(limitsFromUsages(data), NOW), [], 'but none are still open');
});
