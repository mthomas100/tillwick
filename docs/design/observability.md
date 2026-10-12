# Observability — seeing the citizens think

> How to **watch**, **inspect** and **explain** Tillwick's generative-agent citizens.
> Companion skill: [`observe-citizens`](../../.claude/skills/observe-citizens/SKILL.md). Tools:
> `npm run observe | inspect | trace`. Paper map: [architecture.md](architecture.md). This doc is the
> **map of every observability surface**.

The citizens are generative agents (Park et al., UIST '23): each is a headless process that
**perceives** (the sim's `GET /perceive`) → **remembers + retrieves** (the cognitive core, `cognition/`)
→ **reasons** (a Claude Agent SDK `query()` on Haiku) → **acts** (the in-process `world` MCP tools) →
**writes memory back**. They have persistent minds (memory streams, reflections, plans), a social graph,
wallets and quirks. This document says where each of those lives and how to read it.

---

## 0. TL;DR — the commands

```bash
npm run inspect                      # one screen: every citizen's mind + social ties + economy
npm run inspect -- grocer            # deep dive on ONE citizen: persona, reflections, plan, relationships, sessions
npm run trace -- baker 4             # ONE decision, end to end: perception → memory → reasoning → actions → memory-write
npm run observe -- tail              # open EACH citizen's live stream in its OWN iTerm window (watch a running fleet)
MAX_TICKS=2 npm run observe -- spawn # run each citizen live in its own window, bounded
```

`inspect`, `trace` and `observe -- tail` are **read-only and spend zero tokens**: they read the existing
`sim/data`. Only `observe -- spawn` runs the model, and it is **gated** (see §6).

---

## 1. The observability surface — every data source

| Surface | Path | What it is | How to read it |
|---|---|---|---|
| **Pretty stream** | `sim/data/agents/<id>.log` | The human story: per-tick `🗣 reasoning`, `🔧 tool(args)`, `✓ result`. Appended across runs. | `tail -f`, or `npm run observe -- tail` (one window each). The friendliest surface. |
| **Raw transcript** | `sim/data/agents/<id>.jsonl` | The FULL SDK message stream: every `assistant`/`user`/`result` record incl. `thinking` blocks, tool results and cost. ~19 MB/agent. | `npm run trace`; or `grep '"tick":N,' <id>.jsonl \| jq`. Don't `cat` it whole. |
| **Per-tick trace** | `sim/data/traces/<id>.jsonl` | One structured line per tick: what was retrieved and why, actions, health (see §7). | `jq`; `npm run trace`. |
| **Flight tape** | `sim/data/runs/<runId>/{tape.jsonl,manifest.json}` | One recorded run: positions per step, interior coordinates, who heard each line, and the buy chain (`buy-attempt → buy-402 → buy-settled \| buy-failed`). Written by `sim/flight-tape.ts`. | `npm run grade -- --run latest` (scorecard); `npm run replay -- --run latest` (terminal timelines, ASCII map frames, anomaly flags). |
| **Memory stream** | `sim/data/memory/<id>.jsonl` | The MIND: `observation \| reflection \| plan` objects `{id,kind,text,createdAt(game-min),lastAccess,importance(1-10),citations?}`. Append-only; resumable. | `npm run inspect -- <id>`; or `jq 'select(.kind=="reflection")'`. |
| **Relationships** | `sim/data/relationships/<id>.jsonl` | The SOCIAL graph: edges `{other,familiarity,dialogues,coPresences,tradesAsBuyer/Seller,usdcBought/Sold,topics}`. | `npm run inspect`; or `jq .` |
| **Event ledger** | `sim/data/events.jsonl` | The single-writer ECONOMY tape: `{ts,actor,kind,payload,related_id}`. Kinds include `decision, move, consume, purchase, say`. The replay tape. | `jq -r .kind \| sort \| uniq -c`; the GUI activity feed. |
| **SDK session files** | Claude Code's per-project session store (`~/.claude/projects/<project-slug>/<uuid>.jsonl`) | The underlying Agent SDK `query()` transcripts. **One file per TICK** (ephemeral, see §3). | Identified by persona text; `npm run inspect` reports the count and the newest. |
| **Run governor** | `sim/data/run-state.json` + `GET /run-state` | Status (`running/paused/stopped`), reason, `gameMinutes`, `fleetUsd`, budget ceiling. | `curl localhost:4042/run-state \| jq` |
| **Roster** | `sim/data/roster-state.json` | Per-agent `{enabled, model}` (hot-swappable). | `npm run inspect` (shows model + enabled) |
| **Token meter** | `GET /usage` | Per-agent + fleet API-equivalent burn, tick counts. | `curl localhost:4042/usage \| jq` |

### The config/quirk map — the files that make each citizen who they are

| File | Defines |
|---|---|
| `citizens/personas.ts` | **The character.** Each citizen's system prompt (role + temperament: "Frugal and proud of your bread"), its `shopId`, and `buys` (the complementary needs that make money circulate). The single biggest determinant of behaviour. |
| `citizens.local.json` | Identity: `{id, address, privateKey}`. **Never logged or committed**; `inspect` shows the address, never the key. |
| `citizens/citizen.ts` | The mind wiring + tunables: `TICK_MS` (8 s pacing), `maxTurns: 8`, `maxBudgetUsd: 2.0` (per-tick runaway guard), the allowed world tools, the `canUseTool` buy guard, and the social knobs (new-adjacency-only dialogue). |
| `cognition/mind.ts` | Cognitive cadence: `retrieveK: 12` (working-set size), `reflectThreshold: 150` (summed-importance reflection trigger, the paper's value), summary refresh cadence. |
| `cognition/retrieval.ts` | Retrieval = `recency + importance + relevance` weighted sum (paper §4.1). |
| `sim/world.json` | World ground truth: buildings, goods, prices. (Agents sometimes invent places that are NOT in here; see §5.) |

> **Park et al. parallel:** in the reference implementation, each agent's identity, working state and
> the retrieval/reflection hyperparameters live in one inspectable `scratch.json` (`recency_w:1,
> relevance_w:1, importance_w:1, recency_decay:0.995, importance_trigger_max:150`). Tillwick splits these
> across `personas.ts` (identity) and `mind.ts`/`retrieval.ts` (the knobs). A `scratch`-style per-citizen
> state file would consolidate them.

---

## 2. Watching them live — `npm run observe`

Opens **one iTerm window per citizen**, each showing that agent's live tick stream: its `🗣` reasoning
and `🔧` tool calls as they happen. Uses an AppleScript window opener; falls back to Terminal.app
(`--term`) if iTerm automation is denied.

```bash
npm run observe                                 # tail mode: each window tails sim/data/agents/<id>.log
npm run observe -- tail --only=grocer,courier   # just these two
npm run observe -- tail --term                  # Terminal.app instead of iTerm
MAX_TICKS=2 npm run observe -- spawn            # spawn mode: each window RUNS the live citizen process
```

**Two modes, by design:**

- **`tail`** (default, safe): `tail -f`s each `<id>.log`. Pure observer; **spawns nothing**. Use it to
  watch a fleet started elsewhere (the GUI control plane, or `npm run citizens`). Zero token risk;
  respects the single-writer lock.
- **`spawn`**: each window runs `tsx citizens/citizen.ts <id>` directly, the **literal live process**.
  You own that terminal, so you can **Ctrl-C to jump in**. The sim governor still gates token spend
  (citizens idle-poll at 0 tokens until the control plane says "running"). **Gated**, see §6.

> **Why not `claude --resume`?** See §3: there is no single long-lived citizen conversation to resume;
> the live conversation IS the process stream. `--resume` would reopen a dead single-tick session as a
> *new* instance.

---

## 3. The session architecture — why "live viewing" means the process stream

**Verified empirically.** Each citizen's loop in `citizen.ts` spawns a **brand-new SDK session per
tick**: the newest session file is a single citizen's single tick (e.g. one file = "TICK 4" only, 51
lines, one `sessionId`). Over a run a citizen produces thousands of these ephemeral session files.

Consequences for "watch the live session / jump in":

1. **There is no persistent `grocer` Claude session** to attach to: there is a fresh ~8-second session
   every tick.
2. `claude --resume <id>` would resume a **dead** single-tick session as a **new** instance.
3. The continuous "live conversation" of a citizen is its **process stdout** (`<id>.log`) and its
   **per-tick raw transcript** (`<id>.jsonl`), both of which span *all* ticks. So:
   - To **watch** → tail the process stream (`observe -- tail`).
   - To **jump in** → own the process (`observe -- spawn`, then Ctrl-C the window).
   - To **replay/explain** a past decision → `trace` the `<id>.jsonl` (§4).

---

## 4. Explaining a decision — `npm run trace`

`npm run trace -- <id> <tick>` reconstructs ONE decision end to end from the audit files:

```
① PERCEPTION & MEMORY CONTEXT   most-recent perception banked · plan in play · belief (reflection) in play
② REASONING → ACTIONS           🗣 reasoning  ·  💭 thinking  ·  🔧 tool(args) ↳ result  ·  ✓ cost/turns/vetoes
③ MEMORY WRITTEN BACK           the "I decided:" observation this tick produced
```

This is the chain the paper cares about: **observation → retrieved memory → reasoning → action →
memory-write**. Example (`npm run trace -- baker 4`): the baker, inside the cafe, deliberates in a
`💭 thinking` block ("Coffee costs $0.02… I need to keep a small reserve"), calls
`evaluate_purchase → buy`, hits a **402** payment failure, reacts to it in real time, then `consume`s
coffee it already owns. Every tool result (including the 402) is inline.

**Limitation (closed by §7):** before per-tick traces existed, the *exact rendered prompt* (the
perception text + retrieved working set) was not persisted, so `trace` reconstructed context from the
memory stream: faithful but approximate.

---

## 5. What to look for in a run

Patterns worth checking every time, with the data source that shows each one:

1. **Silent no-op ticks.** A tick that fails on an auth or quota error can still end with an SDK
   `result` of `success` and `cost_usd: 0`. Count them from the health line
   (`jq 'select(.result.cost_usd==0)' sim/data/traces/*.jsonl | wc -l`). The runner's circuit breaker
   halts a citizen after N consecutive failures, so a long run of these means the breaker is not seeing
   the error.
2. **Move-spam.** An agent that cannot satisfy its goal (for example, the reserve floor blocks its buy)
   tends to spend its `maxTurns` on `move()` calls, sometimes repeating the same target twice in one
   tick. Compare `move` events with `purchase` and `consume` events per agent in `events.jsonl`, and look
   for `error_max_turns` in the raw transcript.
3. **Slow ticks.** Measure tick latency from `ts` deltas. The first tick pays for the summary and the
   daily plan; most later slow ticks are move-spam ticks, not slow cognition.
4. **Which talk path fired.** Addressed `say`/`talk()` messages from the ACT turn are not the same thing
   as walk-up-and-talk dialogues. Only closed dialogues (`dialogue.jsonl`) and trades reach the
   relationship graph, so an empty `sim/data/relationships/` after a run means the dialogue path never
   completed.
5. **Invented places.** Agents sometimes name places that are not in `sim/world.json` (a "Main Street",
   a market stand) or relabel a real building. The world tools reject unknown targets; the rejection is
   on the tape.
6. **Reflection quality.** Reflections should populate the structured `citations` field, not only cite
   inline ("because of 13,14"), and importance should vary rather than sit at one pinned value. Agents
   that join late may never bank enough salient observations to cross the 150 threshold.
7. **Gate-limited vs. desire-limited spending.** Compare `worth=true` purchase decisions with guard
   vetoes. If most vetoes come from the reserve floor, spending is gate-limited.

> **Caveat for any "agent X did N things" claim:** `tick` in the JSONL is a per-process counter that
> **recurs across game-days**, so don't aggregate by raw tick number across a long run.

---

## 6. Safety discipline

The citizens are headless backend processes: closing the browser does NOT stop them on its own (the
sim's pause-on-no-viewer does). An unbounded loop of them spends model calls around the clock, so
observability work must never start one.

- **Default to read-only.** `inspect`, `trace` and `observe -- tail` spawn nothing and spend zero tokens.
- **`observe -- spawn` is gated.** It refuses to launch unless `MAX_TICKS` is set (a hard stop) **or**
  `OBSERVE_SPAWN_OK=1` is exported (you accept the governor is the only bound). The sim governor still
  applies. Always verify cleanup:
  ```bash
  pgrep -fl 'citizens/citizen.ts'    # expect 0 after a bounded run
  ```
- **Re-kill if anything lingers:** `pkill -9 -f 'citizens/citizen.ts'; pkill -9 -f 'citizens/run-all.ts'`.
- **The sim alone is safe** (`npm run sim` is LLM-free). **Never** run `npm run citizens` unbounded.
- `timeout` is **not** installed on stock macOS; don't rely on it as a backstop. Use `MAX_TICKS` + the
  governor.

---

## 7. Structured per-tick traces — `cognition/trace.ts`

**Status: built.** The citizen loop appends one line per tick to `sim/data/traces/<id>.jsonl` right
after reporting usage. It adds two things that reconstructing from the memory stream could not give:

1. **The decision context that went IN**: the retrieved working set plus per-memory subscores
   (recency / importance / relevance) computed by `retrieval.ts`. Without it, `trace` has to
   *reconstruct* the input from the memory stream. Park et al. make this first-class (you can see exactly
   which memories surfaced for a decision).
2. **A per-tick health line**: `{result, cost, num_turns, tools_used, error?}` in one greppable line,
   so a run of silent no-op ticks (§5) is one `jq` away.

```jsonc
{
  "ts": "2026-06-19T23:37:08Z", "id": "grocer", "tick": 3, "gameMin": 2571,
  "perceived": { "at": {"x":12,"y":4}, "shop": "bakery", "adjacentTo": ["baker"] },
  "retrieved": [                              // the working set + WHY each memory surfaced
    { "id": "grocer:m15", "score": 0.81, "recency": 0.99, "importance": 0.5, "relevance": 0.74,
      "text": "good inventory but no customers — time to move out" }
  ],
  "plan": "scout The Rose & Crown next",
  "reasoning": "I'm in the Bakery with the baker right next to me…",
  "actions": [ {"tool":"talk","input":{"toId":"baker"}}, {"tool":"move","input":{"to":"the_rose_and_crown"}} ],
  "wrote": { "observations": 1, "reflections": 0 },
  "result": { "subtype": "success", "cost_usd": 0.0319, "num_turns": 4, "error": null },  // the health line
  "social": { "newAdjacency": [], "dialoguesFired": 0 }
}
```

**Why this shape:** it is the §4 chain made durable and greppable; `retrieved[].{recency,importance,
relevance}` exposes the retrieval math (paper §4.1); `result` makes silent failure a one-line query:
`jq 'select(.result.cost_usd==0)' sim/data/traces/*.jsonl | wc -l`.

**Cost:** zero tokens. Every field is already computed in the tick; `trace.ts` only serializes it, and a
trace-write failure never breaks a tick (degrade, don't die). No tracing SDK (OpenTelemetry etc.): it
would be overkill for a single-box sim and fight the plain-JSONL, greppable, forkable grain of the rest
of the system.

**Next (cheap, high-value):** an `/interview <citizen> [--at-tick N]` affordance, the paper's primary
believability probe (§8): load a citizen's state and ask the five question categories (self-knowledge /
memory / plans / reactions / reflections) through the real retrieve → prompt path.

---

## 8. The paper's methods (Park et al., UIST '23) — what Tillwick adopts

| Park et al. technique | What it was | Tillwick's analogue |
|---|---|---|
| **The sandbox (the Phaser town)** | A Phaser 2D map; click an agent, read its state; watch sprites move and converse live. | The GUI renderer (`renderer/`) + the activity feed; `observe` windows for the inner stream. |
| **Replay** | Pure read-back of serialized per-step state, zero LLM calls: a deterministic re-watch. | The **event ledger + per-tick transcripts and traces are the replay tape**: replaying folds the append-only ledger forward with no model calls. |
| **Full agent-state inspection** | `scratch.json` (identity + current action + hyperparameters) + associative memory + spatial memory, all plain JSON. | `npm run inspect`; the memory stream is their `nodes.json`. (A consolidated `scratch`-style state file is the missing piece, §1.) |
| **Memory record format** | NL description + creation ts + last-access ts + **poignancy 1–10**; retrieval = **α·recency + α·importance + α·relevance** (all α = 1). | `memory-stream.ts` uses this shape; `retrieval.ts` is this sum. |
| **Reflection trees** | When summed importance crosses **150**, query the 100 most recent records, ask for 3 salient questions, synthesize thoughts that **cite their evidence**. | `reflection.ts` (threshold 150). Check that reflections fill the structured `citations` field, not only inline text (§5). |
| **The interview** | Probe believability by **asking the agent** questions in 5 categories, answered through its own memory at a given time. | The §7 next step; the highest-value technique not yet ported. |
| **"Caused-by" explicability** | Trace an emergent behaviour (the Valentine's party) back through observation → reflection → plan → action; verify diffusion quantitatively (party knowledge 1 → 13 of 25 agents; network density 0.167 → 0.74). | `npm run trace` (one decision); a **diffusion query** over the ledger ("who holds memory M at tick N, before/after a seeded fact") is the natural next analysis tool. |
| **Load + fork** | A run is a fork of a named prior state; "fork at step N" = copy meta + state. | The append-only ledger and streams make **"fork at tick N" = copy + truncate to N**: cheap branchable experiments. |

**Sources:** Park et al., *Generative Agents: Interactive Simulacra of Human Behavior*, arXiv:2304.03442
(https://arxiv.org/abs/2304.03442); full text on ar5iv
(https://ar5iv.labs.arxiv.org/html/2304.03442); reference implementation
(https://github.com/joonspk-research/generative_agents).

---

## 9. Quick recipes

```bash
# Who reflected, and what do they believe?
for a in baker barista courier grocer smith; do echo "== $a =="; jq -r 'select(.kind=="reflection")|.text' sim/data/memory/$a.jsonl; done

# Economy at a glance
jq -r .kind sim/data/events.jsonl | sort | uniq -c

# Who traded with whom (buyer → seller)
jq -r 'select(.kind=="purchase")|"\(.actor) → \(.payload.counterparty) [\(.payload.item)]"' sim/data/events.jsonl | sort | uniq -c | sort -rn

# Find silent no-op ticks in any run
jq 'select(.result.cost_usd==0)' sim/data/traces/*.jsonl | wc -l

# One agent's whole tick N, raw
grep '"tick":4,' sim/data/agents/baker.jsonl | jq -c '{type, t:.ts}'

# Score the newest recorded run, then replay it in the terminal (zero tokens)
npm run grade -- --run latest
npm run replay -- --run latest

# Is anything running right now?
pgrep -fl 'citizens/citizen.ts'; curl -s localhost:4042/run-state | jq '{status,fleetUsd}'
```
