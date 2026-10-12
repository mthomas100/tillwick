# Tillwick — architecture (generative agents + an on-chain economy, safe by construction)

Tillwick is a believable generative-agent town (after Park et al., *Generative Agents: Interactive
Simulacra of Human Behavior*, UIST '23) **fused with an x402 economy**: citizens pay each other's shops
in testnet USDC on Base Sepolia. The whole thing is built so that a runaway, unattended fleet of
citizens **cannot happen by construction** (see §1).

Companion docs: [economy.md](economy.md) (the x402 layer: wallets, shops, the buy primitive, custody,
funding) and [observability.md](observability.md) (how to watch and explain the citizens).

## North star
A town that **trades**: agents live believable lives (memory, reflection, planning), walk a
town modelled on the paper's Smallville, **see each other and stop to talk**, gossip, form relationships, visit homes, and
**need things, get them, and change hands of goods for real testnet USDC over x402.**

## Design decisions (fixed 2026-06-18)
| Axis | Decision |
|---|---|
| Win condition | Believable substrate + cute art + one emergent on-chain event; light eval |
| Scale | Target **25 agents** from a data-driven roster (the current roster runs 8); default model **Haiku** (`claude-haiku-4-5`) |
| Per-agent config | **enable/disable** + **model** per agent, as config; no hardcoded counts |
| Fleet auth | **`ANTHROPIC_API_KEY` by default**; a local Claude login only as an explicit opt-in (see [economy.md](economy.md) §9); per-agent models (Haiku default, promotable protagonists) |
| Safety | pause-on-no-viewer · resume-with-memory-intact · mandatory duration opt-in · backoff + circuit breaker · shared fleet budget ceiling · kill switch · **live token meter** · cache reuse |
| Renderer/art | **Phaser 3 + Tiled**, **LimeZu** tiles + characters (a small commercial pack, not redistributed), art swappable, DOM overlays on top |
| World/cast | Adapt the places of **the paper's Smallville** (Hobbs Cafe, Willows Market & Pharmacy, **Harvey Oak Supply Store** as the goods producer, Oak Hill College + dorm, Johnson Park, Rose & Crown, family houses), with economic roles for the cast |
| Embeddings | **Local on-box model** (zero token cost) for retrieval relevance |
| Time | **Compressed game clock** (~1 s real = 1 game-min, tunable; day/night), persisted |
| Persistence | Durable + resumable: memory streams, relationships, balances, positions, clock |
| ERC-8004 trust | **Deferred** (kept orthogonal) |

## System shape (what is load-bearing vs. added)
**Load-bearing (do not break):** the sim is the single world authority and **never calls an LLM**; the
sim is the **single writer** of `events.jsonl`; x402 **v2 pinned `@x402/*@2.15.0`**, CAIP-2
**`eip155:84532`**, keyless facilitator, gasless EIP-3009; `payTo` = the owning citizen (money
circulates); custody moves only on a real settlement txHash and rebuilds from `events.jsonl`; the
purchase **guard** (`canUseTool` veto + `evaluate_purchase`); the **reserve floor** (not a gross daily
cap); the single-instance supervisor lock. Details in [economy.md](economy.md).

**Added on top:** a safe agent runtime the cognition plugs into; the generative-agent cognitive core; a
richer world with perception, turn-taking dialogue and relationships; shop **stock** and a **producer**;
a Phaser/Tiled/LimeZu renderer; durable resumable state; a GUI control plane.

## 1. Safety and governance — the keystone
Nothing else runs until this exists. An early build ran its citizens in a `for(;;)` loop with no stop
condition and no backoff, and closing the browser did not stop them (they are headless processes, not
part of the page). The governor makes that **structurally impossible**:

- **Pause-on-no-viewer (hard).** The sim tracks connected GUI viewers (WebSocket). 0 viewers → it
  broadcasts `run-state: paused` → citizens **stop issuing LLM queries entirely** (zero burn). A viewer
  connects → resume. Closing the window genuinely stops the spend. This is the primary safety property.
- **Resume-with-memory-intact.** Pause is not death: all cognitive and economic state is durable, so
  reopening the GUI resumes the *same* town (memories, relationships, plans, balances, positions, clock).
- **Mandatory duration opt-in.** A run cannot start until the operator picks **"run for how long?"**
  (15m / 1h / 4h / until-game-day-N / **forever**, explicit and deliberate). Hard auto-stop at the
  chosen limit even while watched.
- **Bounds + backoff in the runner.** `MAX_TICKS`, `MAX_RUNTIME_MS`, **exponential backoff + circuit
  breaker** (halt after N consecutive rate-limit/auth failures, which kills the error storm), and **no
  blind 5 s respawn** of a deliberately stopped citizen.
- **Shared fleet budget ceiling.** One cross-fleet ceiling (beyond the per-tick `maxBudgetUsd` runaway
  guard): when the fleet's cumulative API-equivalent crosses it, the fleet halts.
- **Live token meter.** The GUI shows live **fleet tokens / API-equivalent $** (per tick and
  cumulative), computed at API list prices. It sits beside the kill switch.
- **Real kill switch** in the GUI, plus cache/session reuse so ticks stop re-paying cache creation
  every tick, which matters far more at 25 agents.

## 2. Cognitive core (the paper, mapped to modules under `cognition/`)
Replaces a stateless per-tick prompt with the full architecture, plugged into the safe runner.
Everything is natural language, persisted to the memory stream.
- **Memory stream**: per-agent list of memory objects (observation | reflection | plan), each with text,
  created-at (game time), last access, and an **importance** score (1–10, scored at creation).
- **Retrieval**: `score = recency + importance + relevance`; recency = exponential decay (0.995) over
  game-hours since last access; importance normalized; **relevance = cosine similarity of local
  embeddings** against the query; min-max normalize, top-k into the prompt (the paper's Fig. 6).
- **Reflection**: when summed importance of recent memories crosses a threshold (~150), ask for the
  salient high-level questions → retrieve per question → synthesize **insights with citations** → store
  as reflections (the paper's Fig. 7 reflection trees; reflections can cite reflections).
- **Planning**: top-down daily plan → recursively decomposed (hourly → 5–15 min); **react / re-plan**
  when an observation warrants it; plans live in the memory stream (the paper §4.3).
- **Agent-summary cache**: the cached summary description (identity + occupation + recent
  self-assessment), refreshed periodically; it doubles as the stable prompt prefix for cache reuse.
- **Economic cognition**: purchases, sales and needs are first-class high-importance observations;
  reflections form **economic self-notions** ("low on reserves → spend less / sell more"); plans are
  driven by needs + budget + the day's intent. This is what makes it a community **with an economy**.

## 3. World, perception, movement
- **Town as a tree**: `sim/world.json` is the area → object tree (the paper's Fig. 2): the town →
  buildings (homes, Hobbs Cafe, Willows Market & Pharmacy, Harvey Oak Supply Store, Oak Hill College +
  dorm, Johnson Park, Rose & Crown, co-living) → rooms → objects, rendered to natural language ("there is
  a stove in the kitchen"); each agent keeps a **subgraph** of what it has seen.
- **Perception**: agents within visual range receive observations into the memory stream.
- **Movement**: A* over the map and interiors; the renderer interpolates.
- **Object state**: actions mutate object state (stove → "burning", coffee machine → "brewing"),
  surfaced back into perception.

## 4. Social — talk, relationships, diffusion
- **Walk-up-and-talk**: when agents co-locate, the architecture decides walk-by vs. converse;
  conversations are **turn-taking two-party dialogue conditioned on both agents' memories** (the paper
  §4.3.2), held in a sim-owned conversation side table.
- **Relationships**: a knows-each-other graph formed and remembered from interactions; it feeds
  reflection ("who would I spend time with / buy from?").
- **Information diffusion**: beliefs (a sale, a party, a shortage) travel agent → agent through dialogue,
  carrying their provenance chain (`cognition/gossip.ts`), as in the paper's Fig. 9.

## 5. Economy extensions
- **Shop stock**: shops hold finite inventory; buys deplete it.
- **Harvey Oak producer**: a supply store that **creates goods over time**; stock is configurable up
  front **and** mutable on the fly (by the operator or, optionally, by agents). Underpins scarcity,
  procurement and price behaviour.
- The x402 buy → custody-on-txHash → consume → rebuy loop ([economy.md](economy.md)) is preserved and
  now driven by cognition.

## 6. Renderer (Phaser 3 + Tiled + LimeZu)
Phaser owns one `<canvas>`: a Tiled-authored town map (LimeZu Modern Interiors/Exteriors), LimeZu
walk-cycle character sprites, emoji action bubbles, camera, depth sort. The **activity feed, tx overlay,
inspector, and token meter / control plane** are absolutely positioned **DOM siblings on top**. LimeZu is
proprietary, so **the raw art is not in this repo**; art loads as a swappable asset set. The open
fallback that ships is the renderer's own generated placeholder art; a `ninja` pack slot exists for an
open tileset, but no such art is bundled.

## 7. Persistence
Durable, resumable state under `sim/data/` (gitignored): per-agent memory streams, the relationship
graph, plans, the agent-summary cache, positions, the game clock, and the economy via `events.jsonl`.
Pause/resume and cross-session resume both rely on it.

## Paper → module map
| Paper | Module |
|---|---|
| Memory stream (§4.1) | `cognition/memory-stream.ts` |
| Retrieval recency · importance · relevance (§4.1, Fig. 6) | `cognition/retrieval.ts` + `cognition/embeddings.ts` (local) |
| Reflection trees (§4.2, Fig. 7) | `cognition/reflection.ts` |
| Planning + react/re-plan (§4.3) | `cognition/planning.ts` |
| Agent summary cache (App. A) | `cognition/summary.ts` |
| Environment tree → NL (§5.1, Fig. 2) | `sim/world-tree.ts` + `sim/world.json` |
| Dialogue (§4.3.2) | `cognition/dialogue.ts` + sim side table |
| Sandbox (the Phaser town) | `renderer/` + Tiled map |
| Interview / diffusion / coordination eval (§6–7) | not built; `npm run grade` covers liveness metrics |
| Per-tick decision traces (ours) | `cognition/trace.ts` (see [observability.md](observability.md) §7) |

## Deferred / out of scope
ERC-8004 identity and trust/validation registries (kept orthogonal); peer-to-peer resale (`sellTo`);
dynamic price discovery; a scenario harness (seeded events plus diffusion and trade-graph probes); a
persistent goals layer on top of the daily plan. Unattended long headless runs are out of scope whatever
the auth: every run is short, bounded and watched, with pause-on-no-viewer as the safety default.

