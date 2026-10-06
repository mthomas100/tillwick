# INC-2026-06-18 · Claude Max token-budget drain (Tillwick citizens)

**Severity:** HIGH · **Status:** RESOLVED (remediated and proven live) · **Opened:** 2026-06-18 · **Resolved:** 2026-06-19

> **Cost figures below are API-list-price EQUIVALENTS, not literal charges.** The Max 20x plan is a flat
> monthly fee with *rate limits*, not per-token billing. The "$" numbers measure how hard the limits were
> hammered (and what the same usage would cost on the metered API); that is why interactive work kept
> hitting "you've run out, resets at N pm". They are the right way to *size* the leak, not a bill.

## TL;DR
The **citizen simulation ran unattended, around the clock, in an infinite loop** on the Max subscription.
**5 citizens** (baker, courier, barista, grocer, smith) executed **7,633 full Claude conversations
("ticks") in 18.5 hours** (Jun 17 21:16 → Jun 18 15:46 PDT) before it was killed: ≈**$195
API-equivalent**, ~$169 of it on Jun 18 alone. **Closing the browser did NOT stop it**: the citizens are
headless backend processes with no link to the GUI. Stacked on top of other interactive work, this drain is what exhausted the rate-limit budget
mid-morning on Jun 18.

## What was NOT the problem
- **Not a fork bomb.** Exactly 5 citizens, one supervisor. The single-instance lock
  (`citizens/run-all.ts`) held. The roster was fixed at 5 (`citizens.local.json`).
- The "huge number" feeling came from **ticks, not agents**: the same 5 agents looped ~7,600 times.

## Evidence (from the local Claude Code session logs, `~/.claude/projects/**/*.jsonl`, deduped by message id)
```
citizen run — 7,633 ticks, 21,385 turns, Sonnet 4.6
FIRST tick 2026-06-17 21:16 PDT   LAST tick 2026-06-18 15:46 PDT   (18.5h continuous)
  2026-06-17    561 ticks   ≈ $26
  2026-06-18  7,068 ticks   ≈ $169      (~$0.024–0.046 / tick)
ticks/min on Jun 18: ~5/min normal, SPIKING to 20–26/min at 12:00–14:00 (rate-limit error storm)
```

## Root cause (code level)
1. **No stop condition.** The citizen loop in `citizens/citizen.ts` was `for (;;)`: no max ticks, no
   max runtime, no daily budget. It ran until the OS process was killed. `maxBudgetUsd: 2.0` is a
   *per-tick* runaway guard, explicitly **not** a spend cap.
2. **GUI ≠ kill switch.** Citizens are `tsx citizens/run-all.ts` → 5× `citizens/citizen.ts` (headless
   Node). The browser only renders `sim/sim-server.ts`. Closing the tab left all 5 looping.
3. **No error backoff.** The per-tick `catch` logged and immediately continued. Once rate-limited
   (~11 am Jun 18), every tick failed fast and retried every 8 s: an **error storm** (20–26 ticks/min)
   that kept the run at the plan's usage limit.
4. **Auto-restart amplified it.** `run-all.ts` restarted any exited citizen after 5 s: good for crash
   resilience, but it meant nothing self-terminated.
5. **Unattended workload on an *interactive* subscription.** At the time, `citizen.ts` forced
   subscription auth. An always-on automated loop on a plan sized for a human will always saturate it.
   (Public builds now default to an API key; see [economy.md](economy.md) §9.)

## Immediate actions taken (2026-06-18 ~15:46–15:51 PDT)
Killed the supervisor first (so it could not respawn), then the citizens, then in-flight SDK calls:
```bash
pkill -9 -f 'citizens/run-all.ts'
pkill -9 -f 'citizens/citizen.ts'
pkill -9 -f 'node_modules/@anthropic-ai/claude-agent-sdk'
# verify none remain:
ps -Ao pid,command | grep -E 'citizens/(run-all|citizen)\.ts|claude-agent-sdk' | grep -v grep
```
Left running (these do **not** call Claude, so they are safe): `sim/sim-server.ts`, `shops/run-shops.ts`.
Note: `kill -9` may leave a stale `sim/data/run-all.lock`. That is protective (it blocks an accidental
restart); clear it only when intentionally restarting.

## Open questions at the time
- Were there **earlier citizen runs** before Jun 17 21:16 whose logs rotated away? (Would change the
  total.)
- Did the **error storm** at 12:00–14:00 cost ~nothing (rate-limited rejections) or real spend?
- Was the per-tick context **re-paying cache creation** every tick (no session reuse)? 15.6M cache-write
  tokens on Jun 18 suggested yes: a major efficiency leak even when "working as intended".

## Remediation (as proposed, before running citizens again)
- **Hard stop conditions** in `citizen.ts`: `MAX_TICKS`, `MAX_RUNTIME_MS`, and a **shared daily budget
  ceiling** across all citizens (not just per tick).
- **Exponential backoff + circuit breaker** in the `catch`: on rate-limit/auth errors, back off
  (1 → 2 → 4 → … → cap) and **halt** after N consecutive failures instead of spinning every 8 s.
- **Run in bursts, not around the clock.** A duration flag or a wall-clock auto-shutdown for demos.
- **Unattended agents vs. the interactive subscription:** either a dedicated API key with a hard
  monthly cap, or stay on the subscription but only ever run short, hand-started demos. (At the time the second
  was chosen; public builds now default to an API key, see [economy.md](economy.md) §9.)
- **Visible kill switch / liveness** in the GUI so "closing the window" matches intuition, or a
  heartbeat that auto-stops citizens when no viewer is connected.

## Resolution — RESOLVED 2026-06-19
**Remediated and proven live.** The first build wave of the Tillwick program, the safety governor,
landed every remediation item above and was verified at runtime:
- **Stop conditions + backoff:** `MAX_TICKS` / `MAX_RUNTIME_MS`, a shared **fleet budget ceiling**
  (`FLEET_CEILING_USD`, beyond the per-tick guard), and **exponential backoff + circuit breaker** (halt
  after N consecutive failures, which kills the 8 s error storm). No blind respawn of a deliberately
  stopped citizen.
- **GUI = real kill switch + pause-on-no-viewer:** the sim tracks WebSocket viewers; 0 viewers → the
  fleet pauses (zero burn). Closing the window now genuinely stops the spend, and resuming keeps memory
  intact.
- **Mandatory duration opt-in** (15m / 1h / 4h / game-days / forever) and a **live token meter**
  (API-equivalent) in the GUI.
- **Run policy:** citizens run only in **bounded bursts the operator starts deliberately**, never
  around the clock. Building the program spends interactive tokens (paced); running the fleet is
  separately gated on an explicit OK and a healthy budget.
- **Proven live (gated run):** 1 citizen, `MAX_TICKS=3`, viewer attached: demonstrated
  pause-on-no-viewer, the budget ceiling, clean teardown, and **0 lingering processes** ($0.039
  API-equivalent for 2 ticks).

The operator marked the incident resolved on 2026-06-19, and the incident banner was removed from the
project's agent instructions. This file is kept as the permanent post-mortem; the **Immediate actions
taken** section keeps the re-kill commands in case anything like it recurs. A forensic read of a
run's zombie-loop tail (the same failure, captured tick by tick) is in [observability.md](observability.md) §5.
