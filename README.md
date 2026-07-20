# quotamax

Quota intelligence for Claude Code subscriptions: live limits, burn-rate
forecasts, usage history, **API-cost equivalence**, and machine-readable
capacity advice **for agents** — plus at-a-glance headroom for the other
coding-agent pools you run alongside it (**Codex** and **Kimi Code**).

Your Max/Pro plan's weekly quota is use-it-or-lose-it. quotamax tells you where
you stand, where the week is heading, what your usage would have cost as
pay-as-you-go API traffic — and lets your agents ask "can I fan out 8 subagents
right now, or should I throttle?"

```text
$ quotamax trend

day 1.6 of 7 · resets 14/07/2026, 08:59:59

  100 ┤                                                     ···
   80 ┤                                          ······
   60 ┤                               ·····
   40 ┤                    ·····                         ░░░░░░
   20 ┤        ······       ░░░░░░░░░░░░░░░
    0 ┼█████░░                                
      Tue     Wed     Thu     Fri     Sat     Sun     Mon
      █ actual   ░ projected   · linear pace   (week runs reset→reset)

  now:        9% of the weekly quota used · a typical week is at 9% by this point
  today:      866k output tokens so far — 0.9× your typical Tuesday (990k)
  forecast:   ~71% used by the reset IF the rest of the week follows your
              usual rhythm → ~29% likely expires unused
              (if today's pace continued nonstop: 100%)
  rhythm:     Sun 0.6× Mon 1.4× Tue 1.5× Wed 1.3× Thu 0.9× Fri 1.1× Sat 0.1×
  to use all: a steady 14.2 pts/day, every day incl. weekends (recent: 15.9)
```

The forecast is **weekday-aware**: it learns each weekday's share of your usage
from months of history, so a heavy Tuesday doesn't fool it into predicting
you'll burn through the weekend.

```text
$ quotamax costs

  last 30 days, by model:
  model                          output      input     cache-w    cache-r        cost
  claude-opus-4-8                 21.9M       1.8M      132.1M       5.9B      $4,313
  claude-fable-5                   1.8M       369k       14.0M     450.0M        $719
  total                                                                        $5,058

  7 days: $2,017   30 days: $5,058   90 days: $6,699
```

## Install

```bash
npm install -g quotamax   # or: npx quotamax
```

Requires Node ≥ 18 and a signed-in Claude Code installation (the OAuth token is
read from the macOS Keychain or `~/.claude/.credentials.json`; override with
`CLAUDE_CODE_OAUTH_TOKEN`). The token is used read-only against Anthropic's
usage endpoint and is never logged or stored.

## Commands

| Command | What it shows |
|---|---|
| `quotamax` / `quotamax status` | Live 5-hour session + weekly limit bars, reset times, pace vs linear (+ other pools if present) |
| `quotamax providers` | Just the non-Claude pools: Codex (ChatGPT) + Kimi Code, same bar view |
| `quotamax trend` | ASCII burn-up chart, burn rate, week-end projection (expiry or early exhaustion), usage vs your 3-week baseline |
| `quotamax history` | Daily sparkline + weekly table of tokens and API-cost equivalents |
| `quotamax costs` | Per-model API list-price equivalence over 7/30/90 days, with cache-token pricing |
| `quotamax runcost <codex\|kimi\|claude>` | Most recent run's tokens and API list-price equivalent (`--since <minutes>` controls recency) |
| `quotamax measure -- <cmd...>` | Run a command, then show elapsed time, weekly quota movement, and Codex/Kimi run cost |
| `quotamax agent` | JSON capacity advice for orchestrators (below) |
| `quotamax reserve 20 my-project` | Hold back 20% of the weekly quota for a project (until the reset) |
| `quotamax prioritize my-project` | Mark a project important — exported for burners/miners to favor |
| `quotamax priorities` | Show active reservations and priority projects |
| `quotamax --version` | Print the installed quotamax version |

Every command accepts `--json` for machine output. For `measure`, put quotamax's
options before the separator: `quotamax measure --json -- <cmd...>`.

## Per-run cost and quota movement

`runcost` reads the newest local agent log and prints its token usage and API
list-price equivalent. The estimate is a comparison value: runs covered by a
Codex, Kimi Code, or Claude subscription have **$0 incremental API cost**.

```text
$ quotamax runcost codex --since 30
codex: 556k tokens (90% cached) · ~$0.37 API-equiv
```

`measure` wraps a command with inherited terminal input/output, snapshots every
available weekly meter before and after it, and reports the change alongside
any recent Codex/Kimi run logs:

```text
$ quotamax measure -- codex exec "review this repository"
elapsed: 18.4s
Claude weekly: 41% → 41% (Δ ~0%)
Codex (ChatGPT pro) weekly: 20% → 21% (Δ +1%)
Kimi Code weekly: 17% → 17% (Δ ~0%)
codex: 556k tokens (90% cached) · ~$0.37 API-equiv
```

Weekly meters have 1% resolution, so unchanged readings are shown as `~0%`:
the run may have consumed less than one visible percentage point. Use
`quotamax measure --json -- <cmd...>` for a structured report. The wrapped
command's exit status is preserved.

## Other provider pools

If you also run **Codex** (ChatGPT) or **Kimi Code** (Moonshot) alongside Claude,
`quotamax status` appends their headroom, and `quotamax providers` shows just them:

```text
$ quotamax providers

  ● Codex (ChatGPT pro) weekly: [████░░░░░░░░░░░░░░░░] 21%  resets 25/07, 04:27 (5.2d)
  ● Kimi Code (ADVANCED) 5h window: [██████░░░░░░░░░░░░░░] 31%  resets 19/07, 23:44 (1.0h)
  ● Kimi Code (ADVANCED) weekly:    [███░░░░░░░░░░░░░░░░░] 17%  resets 24/07, 11:44 (4.5d)
```

Both are read **live** from each tool's own usage endpoint and need no extra
config — a pool simply doesn't appear unless it's installed and signed in:

- **Codex** — read live from `GET https://chatgpt.com/backend-api/wham/usage`
  (the same endpoint the CLI itself polls), using the OAuth token + account id in
  `~/.codex/auth.json`. Its weekly cap is `rate_limit.primary_window`; each window
  is labeled by its own length, not by slot, so the weekly cap always shows as
  `weekly`. If the token has expired (run any `codex` command to refresh), quotamax
  falls back to the local `~/.codex/sessions` rollout logs, flagging a reset-passed
  reading `(stale)` rather than showing a fake `0%`.
- **Kimi Code** — read live from `GET https://api.kimi.com/coding/v1/usages`
  using the OAuth token in `~/.kimi-code/credentials`; the 5h + weekly windows
  are server-authoritative. The token is short-lived and refreshed by the kimi
  CLI, so quotamax caches the last good reading and falls back to it (with an
  age note) if the token has gone stale.

Claude remains the pool that drives `trend`, `costs`, `agent`, and the pacing math;
the others are surfaced for at-a-glance headroom.

## For agents

`quotamax agent` answers the question orchestrators actually have: *how hard
can I push right now?*

```json
{
  "ok": true,
  "session": { "percentUsed": 39, "resetsInMinutes": 143 },
  "weekly": { "percentUsed": 58, "resetsInMinutes": 8210, "paceDelta": -12.3 },
  "headroom": "comfortable",
  "advice": {
    "parallelism": 4,
    "modelTier": "top",
    "thinkingEffort": "high",
    "rationale": "session window 39% used (resets in 143m); weekly 58% used, 12 pts behind linear pace with 5.7d to reset"
  }
}
```

- **headroom**: `abundant` → burn freely (behind pace, cool session window);
  `comfortable` → normal operation; `constrained` → economize (hot session
  window, or ahead of weekly pace); `critical` → minimum footprint.
- **Exit codes** for shell gating: `0` abundant/comfortable, `3` constrained,
  `4` critical, `5` quota unreadable. `--quiet` prints just the headroom word.
- **Reservations count as spent**: `quotamax reserve 20 launch-prep` shrinks
  the headroom every agent sees, so autonomous work can't eat quota you're
  saving. External burners can read `~/.config/quotamax/priorities.json`.
- Reads are cached in memory *and* on disk (shared across processes), with a
  persisted cooldown after any 429 — safe to call at agent-loop frequency.
- `--line` prints a single context line (or nothing on failure, exit 0) —
  built for Claude Code SessionStart hooks, so every session starts knowing
  its capacity:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{
      "type": "command",
      "command": "quotamax agent --line 2>/dev/null || true",
      "timeout": 10
    }]}]
  }
}
```

Drop this in your `CLAUDE.md` / agent system prompt:

```markdown
Before fanning out parallel subagents or choosing model/thinking settings for
expensive work, run `quotamax agent` and respect its advice: cap concurrent
subagents at `advice.parallelism`, prefer smaller models when `modelTier` is
not "top", and reduce thinking effort to `advice.thinkingEffort`. If `headroom`
is "critical", do the minimum and tell the user quota is nearly exhausted.
```

Or gate a burst in shell:

```bash
if quotamax agent --quiet | grep -qE 'abundant|comfortable'; then
  spawn_the_fleet
fi
```

## How it works

- **Live quota** comes from the same internal endpoint Claude Code's `/usage`
  command uses. It is **undocumented** and may change or break — quotamax
  treats it gently (shared 120s cache, snapshot fallback) because it
  rate-limits aggressively when polled. Every successful read is snapshotted
  locally, which is how the trend history accumulates with no daemon.
- **History and costs** come from your local session transcripts
  (`~/.claude/projects/**/*.jsonl`), which record per-message token usage and
  model. Parsing is incremental (per-file mtime cache) — the first run scans
  everything, later runs take milliseconds.
- **Per-run costs** read the newest Codex rollout under `~/.codex/sessions`,
  Kimi agent wire logs under `~/.kimi-code/sessions`, or the newest Claude
  transcript. Repeated Kimi streaming frames are de-duplicated before pricing.
- **API-cost equivalence** prices each message at Anthropic's published API
  list prices, including cache writes at 1.25× and cache reads at 0.1× of the
  input price. It's an estimate: list prices only, no batch/intro discounts.
  Set `{"planMonthlyCost": 100, "currency": "GBP"}` in
  `~/.config/quotamax/config.json` to see your plan-value multiple.

## Privacy & security

Everything runs locally. quotamax only makes authenticated, read-only quota
requests to the providers described above; run-cost parsing itself never sends
local log data anywhere. Caches under
`~/.cache/quotamax` and `~/.local/state/quotamax` contain token *counts* only —
never message content, never credentials.

## Related tools

[`ccusage`](https://www.npmjs.com/package/ccusage) and
[`ccburn`](https://www.npmjs.com/package/ccburn) visualize Claude Code usage —
they're great at what they do. quotamax's focus is different: forecasting
(will my quota expire or run out early?), API-cost equivalence, and the
agent-facing advice surface.

## License

MIT © Jonathan Hammant
