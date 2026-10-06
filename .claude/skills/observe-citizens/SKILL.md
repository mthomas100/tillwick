---
name: observe-citizens
description: >
  Use when watching, inspecting, explaining, or debugging Tillwick's generative-agent citizens
  (baker/barista/grocer/courier/smith and the rest of the roster). Triggers: "watch the citizens / open each
  agent in its own iTerm window", "show me a citizen's memory / relationships / quirks / inner life", "why did
  <agent> do X", "trace one decision", "are they thinking", "explain the run", "what are the citizens doing".
  Covers: the live-window tool, the inner-life inspector, the decision tracer, every data source and how to
  read it, the config/quirk map, per-tick traces, and the Park et al. (UIST '23) methods, all under the
  bounded-run safety discipline.
user-invocable: true
allowed-tools: Read, Grep, Bash
---

# Observe the citizens

Make Tillwick's citizens' **inner lives and live behaviour** observable and explicable. The citizens are
generative agents (Park et al., UIST '23): each is a headless process that perceives → remembers/retrieves
→ reasons (Claude Agent SDK / Haiku) → acts → writes memory back. They have persistent minds, a social
graph, wallets and quirks.

Run from the repo root. Full reference:
[docs/design/observability.md](../../../docs/design/observability.md).

## The tools (start here)

```bash
npm run inspect                      # one screen: EVERY citizen's mind (obs/refl/plans) + social ties + economy
npm run inspect -- grocer            # deep dive on ONE: persona/config, reflections+citations, plan, relationships, sessions
npm run inspect -- grocer --full     # + every observation, full text
npm run trace   -- baker 4           # ONE decision end to end: perception → memory → reasoning → 🔧 actions → memory-write
npm run grade   -- --run latest      # scorecard for the newest recorded run (flight tape)
npm run replay  -- --run latest      # terminal replay: timelines, ASCII map frames, anomaly flags
npm run observe -- tail              # open EACH citizen's live stream in its OWN iTerm window (watch a running fleet)
npm run observe -- tail --only=grocer,courier   # subset · --term for Terminal.app
MAX_TICKS=2 npm run observe -- spawn # run each citizen LIVE in its own window, bounded (Ctrl-C a window to jump in)
```

Everything except `observe -- spawn` is **read-only and spends zero tokens**; prefer those. Only
`observe -- spawn` runs the model (gated; see Gotchas).

## When to use

- "Open the agents each in their own iTerm window" / "let me watch them tick" → `npm run observe`.
- "Show me their memory / relationships / quirks / who they are" → `npm run inspect`.
- "Why did the courier keep moving?" / "explain this decision" → `npm run trace -- <id> <tick>`.
- "What happened in the run / what are their quirks" → `npm run grade` + `npm run replay`, and
  observability.md §5 (a worked behaviour analysis).
- "What does a per-tick trace contain?" → observability.md §7 (`sim/data/traces/<id>.jsonl`).

## How to trace ONE decision by hand (when the tool isn't enough)

The chain is **perception → retrieved memory → reasoning → action → memory-write**. Stitch it from:
1. `sim/data/traces/<id>.jsonl`: the retrieved working set with recency/importance/relevance subscores,
   the actions, and the health line for that tick.
2. `sim/data/memory/<id>.jsonl`: what it observed/believed/planned (the context going in).
3. `sim/data/agents/<id>.jsonl`: the reasoning (`🗣`/`💭`), `🔧 tool_use` calls, tool results and `✓`
   cost for that tick: `grep '"tick":N,' sim/data/agents/<id>.jsonl | jq -c '{type,ts}'`
4. `sim/data/memory/<id>.jsonl` again: the `"I decided: …"` observation written back after the ACT turn.

The friendliest single-tick view is the pretty log: `grep '\[<id> tN\]' sim/data/agents/<id>.log`.

## The data sources (one line each)

| Source | Path | Is |
|---|---|---|
| Pretty stream | `sim/data/agents/<id>.log` | the human story (`🗣`/`🔧`/`✓` per tick); `tail -f` it |
| Raw transcript | `sim/data/agents/<id>.jsonl` | every SDK message (incl. `thinking`) + tool results + cost (~19 MB; jq/grep, don't cat) |
| Per-tick trace | `sim/data/traces/<id>.jsonl` | one line per tick: retrieved memories + why, actions, health |
| Flight tape | `sim/data/runs/<runId>/` | one recorded run (`tape.jsonl` + `manifest.json`); read by `grade` / `replay` |
| Memory stream | `sim/data/memory/<id>.jsonl` | the mind: `observation\|reflection\|plan` {text, createdAt(game-min), importance 1–10, citations?} |
| Relationships | `sim/data/relationships/<id>.jsonl` | the social graph: familiarity, dialogues, co-presence, trade volume, topics |
| Event ledger | `sim/data/events.jsonl` | single-writer economy tape: decision/move/consume/purchase/say/… |
| SDK session files | Claude Code's per-project session store (`~/.claude/projects/<project-slug>/`) | **one file per TICK** (ephemeral; not a resumable conversation) |
| Governor / roster | `GET /run-state` · `sim/data/roster-state.json` | run status, gameMinutes, fleetUsd · per-agent enabled + model |

## The config/quirk map — what makes each citizen who they are

- `citizens/personas.ts`: **the character** (system prompt + temperament + economic `buys`/`shopId`).
  The biggest behaviour driver.
- `citizens.local.json`: identity {id, address, **privateKey**}. **NEVER log or print the key**
  (`inspect` shows the address only).
- `citizens/citizen.ts`: mind wiring + tunables (TICK_MS 8 s, maxTurns 8, maxBudgetUsd 2.0, the buy
  guard, social knobs).
- `cognition/mind.ts` / `retrieval.ts`: cognition knobs: retrieveK 12, reflectThreshold 150,
  retrieval = recency + importance + relevance.
- `sim/world.json`: world ground truth (buildings/goods/prices). Agents sometimes **invent** places that
  are not in here (a real quirk).

## Gotchas

- **Token-drain hazard.** An unbounded loop of citizens once drained the subscription's rate-limit
  budget, and closing the browser did NOT stop them (they are headless processes); see
  [the post-mortem](../../../docs/design/incident-2026-06-18-token-drain.md). The incident is resolved,
  but the discipline stays: **default to the read-only tools**, and **never** run `npm run citizens`
  unbounded. `observe -- spawn` is **gated**: it refuses unless `MAX_TICKS` is set OR
  `OBSERVE_SPAWN_OK=1`. After ANY spawn run, verify cleanup: `pgrep -fl 'citizens/citizen.ts'` (expect
  0). Re-kill: `pkill -9 -f 'citizens/citizen.ts'`.
- **The sim must be RUNNING for spawn ticks to fire.** Citizens obey the governor: paused/stopped ⇒ they
  idle-poll at **0 tokens** (correct, but the windows look idle). Start a run from the GUI control, or
  `curl -s -XPOST localhost:4042/control -d '{"action":"start","duration":{"kind":"minutes","value":2}}' -H content-type:application/json`.
  Run `npm run sim` first (LLM-free, safe).
- **No persistent citizen Claude session exists**: each tick is a fresh ~8 s SDK session.
  `claude --resume <id>` would open a DEAD single-tick session as a NEW instance. The live conversation IS
  the process stream (the `.log`). That's why `observe` tails the stream or spawns the process, and never
  resumes.
- **`timeout` is NOT installed on stock macOS**: don't use it as a spawn backstop (it exits 127 and the
  citizen never launches). Use `MAX_TICKS` + the governor as the bound.
- **`tick` in `<id>.jsonl` recurs across game-days**: it's a per-process counter, not globally unique.
  `trace` keeps only the first contiguous block; don't aggregate timing by raw tick number across a long
  run.
- **`<id>.log` is appended across runs**: old lines look current. Note `wc -l` before a fresh run to
  tell new from old.
- **iTerm automation may be denied**: the first `observe` run may need System Settings → Privacy &
  Security → Automation → allow control of iTerm. Or use `--term` for Terminal.app.
- **`permission_denials: []` and `is_error: true` in the raw transcript are mostly artifacts** (the field
  is present in every envelope; `is_error: true` is the normal one-action `stop_sequence` termination).
  Real errors are `error_max_turns`.

## References

- [docs/design/observability.md](../../../docs/design/observability.md): the full map (every source, the
  config/quirk map, a behaviour analysis of an early run, per-tick traces, the paper's methods).
- [docs/design/architecture.md](../../../docs/design/architecture.md): paper → modules.
- Tools: `scripts/{observe-windows,inspect-citizen,trace-decision,grade-run,replay-run}.ts`.
- Running the town: the [run-town](../run-town/SKILL.md) skill.
