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

## 5. Behaviour analysis — what an early long run revealed

A forensic read of one early run (`sim/data/agents/*`, `memory/*`, `events.jsonl`; ~6,937 events,
agents reached ticks ~1,400). The five most revealing findings:

1. **About half the run was a zombie loop: the 2026-06-18 incident's infinite loop, captured frame by
   frame.** Every citizen ran healthy until ~tick 700–745, then hit `You've hit your session limit ·
   resets 3pm` and logged **~630–650 consecutive no-op ticks** of `🗣 session limit / ✓ success
   (cost_usd=0)`, never recovering. All real `purchase` events stop on 2026-06-18T22; the tick streams
   run to 2026-06-19T23:37. **The harness happily logged `✓ success` for ~5,000 no-op ticks.** This is
   the strongest argument for structured traces (§7): the loop did **not** halt on auth/quota failure,
   and nothing flagged it. *(The safety governor and circuit breaker now bound this.)*

2. **Courier move-spam, quantified.** The courier fired up to **5 `move()` calls in a single tick**, and
   **765 moves vs. 25 buys / 37 consumes** across the run: a mover, not a trader. It loses track of its
   own location and inventory and oscillates Depot ↔ Bakery, even re-issuing byte-identical
   `move({"to":"depot"})` twice in one tick. It also tops the real-error count (`error_max_turns` ×7).
   This shows the **per-tick `maxTurns` budget interacts badly with an agent that can't satisfy its
   goal** (the courier was reserve-blocked from buying, so it just walked).

3. **First-tick latency hypothesis (~108 s): refuted.** Measured from `ts` deltas, tick 1 took
   **12–23 s** for every agent (among the *faster* ticks), not a cold spike. Tick-1 cost is mildly
   elevated (~$0.04–0.06 vs. a run mean of ~$0.025): a small summary + daily-plan warm-up. The genuinely
   slow ticks (smith t7 = 57 s, barista t9 = 43 s) are **move-spam ticks**, not cold cognition.

4. **Two talk systems; the feature under test barely fired.** 511 addressed `say`/`talk()` messages and
   ~184 reciprocal exchanges happened, but all through the **older ACT-loop `talk()` tool**. The
   dedicated walk-up-and-talk path fired exactly **3 times, all at shutdown**, completed **0**
   dialogues, and recorded **0 co-presences**. Only one relationship file existed (1 edge). **1 of ~511
   dialogues and 0 of 1,231 trades reached the graph.** The plumbing existed (`dialogue-driver.ts`,
   `relationships.ts`) but the run was too short and too stationary to convert co-presence into
   recorded dialogue.

5. **Real emergence and metacognition.**
   - **Hallucinated affordances/geography:** the grocer relabels the real `pub` as *"The Rose & Crown …
     a tavern likely to have patrons interested in fresh supplies"* and abandons its shop to sell door
     to door; the courier invents *"Main Street"* and *"the market stand on Main Street"*, places not in
     `world.json`. During a live test of the observe tool, the grocer tried
     `move({"to":"the_rose_and_crown"})`.
   - **Genuine loop detection:** *"I see the trap: I've been buying coffee repeatedly when I already own
     **209 cups**… I should consume what I have"* (baker); *"I'm stuck repeating the same decision…
     break this loop"* (courier). Agents catching their own degenerate loops.
   - **Reflections read as real synthesis** with inline provenance ("because of 13,14", tracing back to
     the trap observation). But **0/10 reflections populated the structured `citations` field**
     (provenance was inline text only) and **importance was rule-pinned at 6 for all reflections and
     plans**, not LLM-scored. Both are known cognition gaps.

Cognition counts (productive window): baker 28 observations / **5 reflections** / 37 plans; barista
30 / **5** / 33; courier 11 / **0** / 8; grocer 9 / **0** / 10; smith 9 / **0** / 9. **Only the baker and
the barista ever reflected**: the others joined late (game-min ~2,370 vs. the baker's ~481) and never
banked enough salient observations to cross the 150 threshold.

Economy (a **real circular flow**): 1,227 of 1,231 purchases were genuine inter-agent trades; the
own → consume → rebuy loop is tight (baker + coffee: 209 buys / 212 consumes, ~198 clean cycles).
Spending is **gate-limited, not desire-limited**: 2,200 `worth=true` decisions, ~811 of them blocked by
the reserve floor.

> **Caveat for any "agent X did N things" claim:** the back half of that run is zombie; scope counts to
> the productive first ~700 ticks. `tick` in the JSONL is a per-process counter that **recurs across
> game-days**, so don't aggregate by raw tick number across a long run.

---

## 6. Safety discipline

The citizens are the cause of the [2026-06-18 token-drain incident](incident-2026-06-18-token-drain.md)
(an unbounded loop drained the subscription's rate-limit budget; closing the browser did NOT stop them,
because they are headless backend processes). The incident is resolved, but observability work must
never re-trigger it.

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
after reporting usage. It adds the two things the behaviour analysis (§5) showed were missing:

1. **The decision context that went IN**: the retrieved working set plus per-memory subscores
   (recency / importance / relevance) computed by `retrieval.ts`. Without it, `trace` has to
   *reconstruct* the input from the memory stream. Park et al. make this first-class (you can see exactly
   which memories surfaced for a decision).
2. **A per-tick health line** that would have screamed during the zombie loop: `{result, cost,
   num_turns, tools_used, error?}` in one greppable line, so "5,000 no-op ticks" is one `jq` away.

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
| **Reflection trees** | When summed importance crosses **150**, query the 100 most recent records, ask for 3 salient questions, synthesize thoughts that **cite their evidence**. | `reflection.ts` (threshold 150). **Gap:** reflections cite inline ("because of 13,14") but leave the structured `citations` field empty (§5). |
| **The interview** | Probe believability by **asking the agent** questions in 5 categories, answered through its own memory at a given time. | The §7 next step; the highest-value technique not yet ported. |
| **"Caused-by" explicability** | Trace an emergent behaviour (the Valentine's party) back through observation → reflection → plan → action; verify diffusion quantitatively (party knowledge 1 → 13 of 25 agents; network density 0.167 → 0.74). | `npm run trace` (one decision); a **diffusion query** over the ledger ("who holds memory M at tick N, before/after a seeded fact") is the natural next analysis tool. |
| **Load + fork** | A run is a fork of a named prior state; "fork at step N" = copy meta + state. | The append-only ledger and streams make **"fork at tick N" = copy + truncate to N**: cheap branchable experiments (see [experiments.md](experiments.md)). |

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

# Find a zombie loop in any run (no-op ticks)
grep -c 'session limit' sim/data/agents/*.log
jq 'select(.result.cost_usd==0)' sim/data/traces/*.jsonl | wc -l

# One agent's whole tick N, raw
grep '"tick":4,' sim/data/agents/baker.jsonl | jq -c '{type, t:.ts}'

# Score the newest recorded run, then replay it in the terminal (zero tokens)
npm run grade -- --run latest
npm run replay -- --run latest

# Is anything running right now?
pgrep -fl 'citizens/citizen.ts'; curl -s localhost:4042/run-state | jq '{status,fleetUsd}'
```
