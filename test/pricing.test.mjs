import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { priceFor, costUSD, fmtUSD, fmtTokens } from '../src/pricing.mjs';

describe('priceFor', () => {
  test('exact and dated model ids match by prefix', () => {
    assert.equal(priceFor('claude-opus-4-8').in, 5);
    assert.equal(priceFor('claude-haiku-4-5-20251001').out, 5);
    assert.equal(priceFor('claude-fable-5').out, 50);
  });

  test('variant suffixes like [1m] are stripped', () => {
    assert.equal(priceFor('claude-fable-5[1m]').matched, 'claude-fable-5');
  });

  test('longer prefixes win over shorter ones', () => {
    // claude-opus-4-1 ($15/$75) must not be swallowed by a claude-opus-4 rule
    assert.equal(priceFor('claude-opus-4-1-20250805').in, 15);
    assert.equal(priceFor('claude-opus-4-8').in, 5);
  });

  test('unknown models fall back to opus-tier pricing, flagged unmatched', () => {
    const p = priceFor('someone-elses-model');
    assert.equal(p.matched, null);
    assert.equal(p.in, 5);
  });

  test('synthetic placeholder rows cost nothing', () => {
    assert.equal(priceFor('<synthetic>').in, 0);
  });
});

describe('costUSD', () => {
  test('applies cache multipliers: writes 1.25x input, reads 0.1x input', () => {
    // 1M of each token class on a $5/$25 model:
    // in $5 + out $25 + cw $6.25 + cr $0.50 = $36.75
    const cost = costUSD('claude-opus-4-8', { in: 1e6, out: 1e6, cw: 1e6, cr: 1e6 });
    assert.ok(Math.abs(cost - 36.75) < 1e-9, `got ${cost}`);
  });

  test('zero usage costs zero', () => {
    assert.equal(costUSD('claude-opus-4-8', { in: 0, out: 0, cw: 0, cr: 0 }), 0);
  });
});

describe('formatting', () => {
  test('fmtUSD', () => {
    assert.equal(fmtUSD(3.14159), '$3.14');
    assert.equal(fmtUSD(4313.2), '$4,313');
  });
  test('fmtTokens', () => {
    assert.equal(fmtTokens(5_900_000_000), '5.9B');
    assert.equal(fmtTokens(21_900_000), '21.9M');
    assert.equal(fmtTokens(450), '450');
  });
});
