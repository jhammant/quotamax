# quotamax 0.4.0 implementation summary

Implemented the `SPEC-measure.md` per-run cost and quota-measurement release.

## Added

- `src/runcost.mjs` with fixture-testable Codex, Kimi Code, and Claude run-log
  readers; approximate API list-price rates; cache-aware pricing; compact run
  formatting; pure measure report assembly; and pure `--` argument splitting.
- `quotamax runcost <codex|kimi|claude> [--since <min>] [--json]`.
- `quotamax measure [--json] -- <cmd...>`, using inherited stdio, before/after
  weekly-meter snapshots, elapsed timing, run-cost lines, structured JSON, and
  the wrapped command's exit status.
- Synthetic Codex and Kimi JSONL fixtures plus `test/runcost.test.mjs` coverage
  for parsing, malformed lines, Kimi frame de-duplication, pricing, formatting,
  report deltas, sub-1% meter resolution, and command splitting.

## Changed

- Added an explicit force-refresh option to `getQuota` so a post-command
  measurement does not reuse the pre-command in-process or disk TTL result.
- Documented both commands, local-log sources, list-price-equivalent semantics,
  JSON usage, and 1%-resolution behavior in `README.md`.
- Bumped the package version from `0.3.0` to `0.4.0` with no new dependencies.

## Verification

- `node --test test/runcost.test.mjs`
- `npm test` — 75 tests passed, 0 failed.
