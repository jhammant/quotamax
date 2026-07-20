# Build spec: `quotamax measure` + `quotamax runcost`

Add per-run cost visibility to quotamax: after a delegated agent run (Codex/Kimi/Claude),
show **how many tokens it used, the API-$ equivalent, and how much of the weekly quota it
moved.** Two commands + one reusable module. Node ≥18, ESM, ZERO new deps, `node --test`.

Integrates with the existing code — reuse `src/pricing.mjs` for Claude pricing and
`src/providers/index.mjs` (`getOtherProviders`) + `src/quota.mjs` (`getQuota`) for weekly %.

## `src/runcost.mjs` (new)

Parse the most-recent run's token usage per provider from its local logs, and price it.

- `RATES` — approx per-1M API rates for the $-equivalent (document they're list-price
  estimates; real subscription cost is $0):
  - `codex` (gpt-5.6-sol, GPT-5-class): input 1.25, cachedInput 0.125, output 10
  - `kimi` (k3, Moonshot approx): input 0.60, cacheRead 0.15, output 2.50
  - `claude`: reuse `src/pricing.mjs` rates for `claude-opus-4-8`.
- `latestCodexRun({sessionsDir, sinceMin=60})` → `{input, cached, output, total, at}` |
  null. Walk `<sessionsDir>` (default `~/.codex/sessions`, but ALWAYS accept an override
  for tests) `YYYY/MM/DD/rollout-*.jsonl`, take the newest file, read the **last** event
  whose `payload` carries `info.total_token_usage` (fields: `input_tokens`,
  `cached_input_tokens`, `output_tokens`, `total_tokens`). Defensive: skip malformed lines.
- `latestKimiRun({sessionsDir, sinceMin=60})` → `{input, cacheRead, output, total, at}` |
  null. Walk `<sessionsDir>` (default `~/.kimi-code/sessions`) for `**/agents/**/*.jsonl`
  modified within `sinceMin`; sum `usage` frames (`inputOther`, `output`, `inputCacheRead`,
  `inputCacheCreation`), **de-duplicating repeated identical frames** (streaming emits the
  same cumulative frame repeatedly — key on input+output+cacheRead).
- `priceRun(provider, tokens)` → `{usd, breakdown}` using RATES. Pure, unit-testable.
- `fmtRun(provider, tokens, usd)` → a one-line string like
  `codex: 556k tokens (90% cached) · ~$0.37 API-equiv`.

## `quotamax runcost <codex|kimi|claude> [--since <min>] [--json]`
Print the most-recent run's tokens + $ for that provider (the one-liner from `fmtRun`),
or a clear "no run found in the last <N>m" message. This is what the `/codex` and `/kimi`
skills call to emit a cost line after a delegated run.

## `quotamax measure [--json] -- <cmd...>`
Wrap a command and report what it cost:
1. Snapshot weekly-% for Claude (`getQuota().weekly.percent`) and each other pool
   (`getOtherProviders()` → the limit whose label matches `/weekly/i`) **before**.
2. Spawn `<cmd>` with inherited stdio (`child_process.spawn`, `stdio: 'inherit'`), time it.
3. Snapshot weekly-% **after**.
4. Print: elapsed; per-pool `Δweekly%` (before → after; note when it's below the meter's
   1% resolution → "~0%"); and for codex/kimi the latest-run tokens+$ via `runcost`.
   `--json` emits the structured object.
Everything (the `--` arg split, the report assembly) should be a **pure function**
`buildMeasureReport({before, after, runs, elapsedMs})` so it's testable without spawning.

## CLI wiring (`src/cli.mjs`)
Add `case 'measure'` and `case 'runcost'`. `measure` must split argv at `--` (everything
after is the wrapped command). Update the header comment + the unknown-command usage line +
the README commands table.

## Tests (`test/runcost.test.mjs`, `node --test`, fixtures only)
Create synthetic fixtures under `test/fixtures/codex/...` (a rollout jsonl with a
`total_token_usage` event) and `test/fixtures/kimi/.../agents/main/wire.jsonl` (usage
frames incl. a duplicated frame). Assert: `latestCodexRun`/`latestKimiRun` sum + dedupe
correctly, `priceRun` math, `fmtRun` formatting, and `buildMeasureReport` renders Δ and the
"~0%" sub-resolution case. No network, no real `~/.codex`/`~/.kimi-code` reads in tests.

## Deliverables
`src/runcost.mjs`, CLI cases, tests+fixtures, README update, and a SUMMARY.md. Bump
`package.json` version to `0.4.0`. `npm test` fully green. Do NOT push, do NOT publish.
Work only inside this directory. (Note: you can't read the real ~/.codex/~/.kimi-code from
the sandbox — that's fine; test against fixtures, the maintainer verifies the live read.)
