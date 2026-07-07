// API list prices per million tokens (USD), for computing what your
// subscription usage would have cost as pay-as-you-go API traffic.
// Cache multipliers per Anthropic docs: writes 1.25x input (5-min TTL),
// reads 0.1x input.
//
// Snapshot of published pricing as of 2026-06; update PRICES when Anthropic
// changes list prices (https://platform.claude.com/docs/en/pricing).
const PRICES = [
  // [model-id prefix, input $/MTok, output $/MTok]
  ['claude-fable-5', 10, 50],
  ['claude-mythos-5', 10, 50],
  ['claude-opus-4-8', 5, 25],
  ['claude-opus-4-7', 5, 25],
  ['claude-opus-4-6', 5, 25],
  ['claude-opus-4-5', 5, 25],
  ['claude-opus-4-1', 15, 75],
  ['claude-opus-4', 15, 75],
  ['claude-sonnet-5', 3, 15],
  ['claude-sonnet-4', 3, 15],
  ['claude-sonnet-3', 3, 15],
  ['claude-haiku-4-5', 1, 5],
  ['claude-haiku', 1, 5],
  ['<synthetic>', 0, 0], // local placeholder rows in transcripts
];
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;

export function priceFor(modelId) {
  const id = String(modelId ?? '').replace(/\[.*\]$/, ''); // strip variants like [1m]
  const row = PRICES.find(([prefix]) => id.startsWith(prefix));
  if (row) return { in: row[1], out: row[2], matched: row[0] };
  // Unknown model: assume Opus-tier so estimates err on the visible side.
  return { in: 5, out: 25, matched: null };
}

/** tokens: {in, out, cw, cr} → USD */
export function costUSD(modelId, t) {
  const p = priceFor(modelId);
  return (
    (t.in / 1e6) * p.in +
    (t.out / 1e6) * p.out +
    (t.cw / 1e6) * p.in * CACHE_WRITE_MULT +
    (t.cr / 1e6) * p.in * CACHE_READ_MULT
  );
}

export function fmtUSD(n) {
  return `$${n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2)}`;
}

export function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(Math.round(n));
}
