---
name: run-town
description: Run / launch / start / screenshot / drive Tillwick — a generative-agent pixel-art town (Phaser + LimeZu renderer) fused with an x402 testnet economy, served on http://localhost:4042. Use to boot the sim, spawn the bounded citizen fleet (GUI Start or the live-demo CLI), watch agents perceive/move/trade/converse, and drive the control plane via curl.
---

# run-town

Tillwick is a **generative-agent town** (Park et al. cognition) fused with an **x402 testnet economy**,
rendered in **Phaser + LimeZu** pixel art. One **sim server** (`npm run sim`, port **4042**) is the world
authority, the operator control plane, and the static host for the renderer; the **citizens are
*separate* Haiku processes** that poll the sim and act. The sim itself **never** calls an LLM.

**How you drive it:** boot the sim, then spawn the bounded citizen fleet **either** by clicking **Start**
in the in-browser ⚙ control panel **or** by running the `scripts/live-demo.ts` CLI driver. Observe at
`http://localhost:4042/?art=limezu`, via the per-citizen logs, and via the `curl` control-plane API.

> All commands run from the repo root. The drivers live in `scripts/`.

## Prerequisites
- Node 22 + npm. macOS or Linux.
- `npm install` once.
- `.env` holds testnet keys (gitignored, throwaway). The **funded citizen wallets** in
  `citizens.local.json` matter: see Gotchas.
- Auth: `ANTHROPIC_API_KEY` in `.env` (the default). Opt-in for personal local experiments only: a
  logged-in Claude subscription via `TILLWICK_USE_CLAUDE_LOGIN=1` or `CLAUDE_CODE_OAUTH_TOKEN`.
- Optional: `jq` (used below), `ffmpeg` (music-asset pipeline).

## Run — agent path (use this)

**1. Boot the sim** (world + control plane + renderer host):
```bash
npm run sim
# → prints the town URL (http://localhost:4042) and the citizen count
```

**2. Spawn the bounded fleet — pick ONE path (never both in one run):**

CLI driver (scriptable; this is the harness):
```bash
DEMO_AGENTS=baker,barista,grocer,courier,smith,student,musician,regular \
  DEMO_MIN=6 DEMO_MAX_TICKS=12 npx tsx scripts/live-demo.ts
# attaches a viewer, enables the agents, starts a bounded run, spawns the Haiku
# citizens, tees each to sim/data/agents/<id>.log, streams fleet usage, then cleans
# up the citizens at the duration cap (leaving the sim up). $5 fleet ceiling.
```

GUI (the operator path): open `http://localhost:4042/?art=limezu` → ⚙ **CTRL** panel → pick a
**duration** → **Start**. The sim's `/control start` hook fires `scripts/spawn-fleet.ts`, which spawns
the same bounded fleet (reads the enabled roster + duration, tees logs, self-cleans on **Stop**).

**3. Watch + drive (control-plane API):**
```bash
curl -s localhost:4042/meta      | jq '{agents, buildings}'
curl -s localhost:4042/run-state | jq '{status, remainingMs, enabled:[.roster[]|select(.enabled).id]}'
curl -s localhost:4042/usage     | jq '.fleet'                    # ticks + notional $ + tokens
curl -s localhost:4042/events    | jq '.events[-5:]'             # recent say/move/trade/produce
curl -s 'localhost:4042/perceive?agent=barista' | jq '{here, adjacentTo, heardRecently}'
pgrep -f citizens/citizen.ts | wc -l                             # citizens alive (~3 procs/agent)
```

**4. Stop / clean up:**
```bash
# GUI: click Stop (spawn-fleet tears the fleet down within ~3s). Or from the shell:
pkill -f citizens/citizen.ts    # live-demo + spawn-fleet also auto-clean when run-state goes stopped
```

## Run — human path
`npm run sim`, open `http://localhost:4042/?art=limezu` in a real browser, drive the ⚙ panel
(duration → Start → watch → Stop). Two-finger swipe pans, the +/− buttons zoom, click a citizen to
inspect, the 🎵 button cycles chiptune tracks.

## Watch a recorded run (no LLM)
`npm run replay-server` plays the bundled run (`samples/run-2026-07-18/`) in the real renderer with zero
model calls and no citizens spawned; `npm run replay-server -- --tape sim/data/runs/<runId>` plays any run
the live sim recorded. Flags: `--speed 8`, `--from HH:MM`, `--loop`, `--port 4042`.

## Gotchas (all hit in real sessions)
- **`tsx` does NOT hot-reload.** After editing any `sim/*` file, the running sim serves STALE code until
  you restart it (`npm run sim`). Restart and `curl` the new field to confirm it's live BEFORE trusting a
  run: a stale sim once looked exactly like "the fix failed" (the process predated the edit by 36 min).
- **cwd matters.** Run scripts from the repo root (`npx tsx scripts/live-demo.ts`); from anywhere else
  you get `ERR_MODULE_NOT_FOUND`.
- **Cold start is slow.** Each citizen's FIRST tick is 24–93 s (summary + plan + retrieval before it
  acts). A 3-min run does ~3 ticks fleet-wide; give it 1–2 min before judging "nothing's happening".
- **Agents often "produce in place"** (bake/brew/restock): the map looks still while they work. Watch
  the activity feed / `/events`, not just the map.
- **ONE `:4042` slot: serialize runs.** Don't run `live-demo.ts` AND click GUI Start in the same window;
  both spawn a fleet. `spawn-fleet.ts` has a `pgrep` double-spawn guard, but concurrent control (two
  agents or people both POSTing `/control`) resets the run, toggles agents, and *looks* broken.
- **NEVER `npm run gen-citizens` / `gen-wallets` on a funded town.** They regenerate the funded citizen
  wallets, which is irreversible (the old wallets' USDC is stranded). A plain sim restart is safe (it
  reloads data and never regenerates wallets).
- **Bounded only.** Always a duration cap + the $5 fleet ceiling + the pause-on-no-viewer governor (these
  closed the [token-drain incident](../../../docs/design/incident-2026-06-18-token-drain.md)). Never an
  unbounded fleet.
- **Automation/headless Chrome can't decode `<audio>`** (readyState stalls): verify the 🎵 music in a
  real browser, not automation.

## Troubleshooting
- **"Set duration + Start does nothing."** GUI Start spawns the fleet via `scripts/spawn-fleet.ts`. If
  it recurs, confirm the `execFile(... "scripts/spawn-fleet.ts" ...)` block is in `sim/sim-server.ts`'s
  `/control` "start" case **and** the sim was restarted since the last edit (hot-reload gotcha above).
- **Citizens exit instantly, 0 ticks.** The run-state went `stopped` under them (a concurrent
  `/control stop`, or the duration already elapsed). Take exclusive control of the slot, then re-Start.
- **Empty / `$0` token meter for ~1 min.** Normal: the meter clears on each `/control start` (fresh
  per-run budget) and cold start hasn't ticked yet.
- **A background wrapper reports "failed exit 1" but `curl /meta` works** → the wrapper exited; the sim
  is still serving. Check `pgrep -f sim-server`.

## The drivers
`scripts/live-demo.ts` (bounded CLI launcher) + `scripts/spawn-fleet.ts` (the supervisor the GUI Start
fires). The sim's `/control start` handler (`sim/sim-server.ts`) spawns `spawn-fleet.ts` detached and
fire-and-forget (like `POST /observe`); a failed spawn never crashes the sim.

Verified in a real session: booted via `npm run sim`; spawned the fleet both via `scripts/live-demo.ts`
and via a real GUI **Start** click; watched 12 ticks / $1.35 notional with agents moving, producing and
conversing (`student → barista: "could you extend credit…"`); all `curl` commands above ran green
against the live :4042.

## See also
- [observe-citizens](../observe-citizens/SKILL.md): inspect minds, trace decisions, open per-citizen windows.
- [docs/design/architecture.md](../../../docs/design/architecture.md) ·
  [economy.md](../../../docs/design/economy.md) ·
  [observability.md](../../../docs/design/observability.md)
