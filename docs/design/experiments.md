# Experiment backlog — Tillwick

The point of Tillwick is **not** to hard-code one demo. It is a believable generative-agent town (after
Park et al., *Generative Agents: Interactive Simulacra of Human Behavior*, UIST '23) **fused with an
on-chain x402 economy**, plus a **harness** that seeds and measures *any* of the experiments below **as
configuration / scenario scripts, not code rewrites.**

> Design rule: no experiment may require touching the cognitive core or the world authority. An
> experiment = (a **seed**: an intent injected into one agent, or a world/event/config change) + (a set
> of **measurement probes**). If running a new experiment needs a rewrite, the architecture is wrong.

## The substrate every experiment runs on

- **Generative-agent cognition**: memory stream, recency × importance × relevance retrieval, reflection,
  hierarchical planning, react/re-plan, dialogue (see [architecture.md](architecture.md)).
- **A walkable town modelled on the paper's Smallville**: homes, workplaces, social spaces (cafe, bar, park, a gathering
  hall), stores. Agents perceive, move, see each other, stop and talk, visit homes, and form
  relationships.
- **An economy with real changing of hands**: agents hold inventory (custody tied to an x402 txHash);
  **shops hold stock**; goods are produced and restocked; agents must **gather what they need** for what
  they want to do (consume to satisfy needs, procure inputs to host an event, etc.). See
  [economy.md](economy.md).

## Shared mechanics the harness provides

- **Shop stock and production.** Shops have finite inventory. A **supply store / producer** creates goods
  over time. Stock is configurable up front **and** mutable on the fly (by the operator or, optionally,
  by agents deciding to produce/restock). This underpins scarcity, procurement and price behaviour.
- **Seedable intents and events.** Inject a goal or belief into one agent ("you want to host a party
  Saturday"), or fire a world event ("the cafe announces a sale at 5 pm"). The cascade is emergent.
- **Gossip / information diffusion.** Beliefs travel agent → agent through natural-language conversation
  when agents meet: the mechanism behind every "word spreads" experiment.
- **Measurement probes** (the paper's methods, with economic analogues):
  - *Information diffusion*: % of agents who hold a seeded belief at the end (paper: who knew about the
    party / the candidacy).
  - *Relationship formation*: undirected knows-each-other graph density over time, plus a **trade
    graph** (who bought from whom).
  - *Coordination*: who actually showed up / acted (paper: who came to the party) → who showed up **and
    transacted on-chain**.
  - *On-chain footprint*: USDC volume and tx timing clustered around the seeded event.

---

## Experiments

### #2 — Festival with a supply chain (first to try)
- **Seed:** one agent gets the intent to host a gathering (e.g. a Valentine's-style party) at a social
  space at a set time.
- **Hypothesis:** to throw it, the host must **procure inputs** (ingredients, decorations) by buying from
  other shops → a visible chain of agent → agent on-chain purchases. Meanwhile the invite diffuses,
  others re-plan, and a crowd coordinates to show up.
- **Economic mechanic:** procurement (the host buys inputs) + shop stock depletion/restock + attendee
  spending at the venue.
- **Measures:** procurement tx chain (who bought what from whom, from `events.jsonl`), invite diffusion
  %, attendance, on-chain volume around the event time.
- **Why first:** it exercises *every* substrate capability at once (planning, gossip, relationships,
  movement, stock, real changing of hands), so getting it working validates the whole architecture.

> **Build path:** the *single-agent* core comes first: one agent with a goal buys balloons at shop A
> and cake at shop B, carries them to a home, and gives them away. The *multi-agent* festival then
> needs the goals layer, give/carry verbs, finite stock + the Harvey Oak producer, scenario seeding, and
> the probes (see the next-phase deltas in [architecture.md](architecture.md)). It runs only after a
> clean, bounded throughput test of the full roster on the subscription. The believability eval is the
> paper's interview probe ([observability.md](observability.md) §7–8).

### #1 — The sale that spreads
- **Seed:** one shopkeeper intends to hold a half-price sale at a set time.
- **Hypothesis:** word diffuses agent → agent like the party invite; agents re-plan their day to attend;
  a demand spike lands as real on-chain USDC purchases clustered at the sale time.
- **Economic mechanic:** a temporary price drop + finite sale stock.
- **Measures:** sale-news diffusion %, re-planning, the on-chain demand spike (tx count/volume vs. time).

### #3 — Supply shock / scarcity
- **Seed:** a key input runs out (e.g. the cafe's coffee stock hits zero), or production halts.
- **Hypothesis:** scarcity diffuses ("they're out"); agents adapt (substitute goods, seek
  alternatives, change routines); prices may adjust if price discovery is enabled.
- **Economic mechanic:** stock depletion without restock; optional dynamic pricing.
- **Measures:** scarcity-belief diffusion, substitution behaviour, (optional) price movement, the dip and
  redistribution of on-chain spend.

### #4 — Emergent wealth / status
- **Seed:** none (or asymmetric starting stipends). Run long.
- **Hypothesis:** transaction history + reflection produce a "thriving vs. struggling" divergence; agents
  form **economic self-notions** ("I'm low on reserves — spend less / sell more" vs. "business is good")
  that feed back into behaviour.
- **Economic mechanic:** the existing circulating economy over a long horizon.
- **Measures:** balance dispersion over time, the content of economic reflections, behaviour change
  correlated with reserves.

---

## Status
All four are backlog. The substrate they need is described in [architecture.md](architecture.md);
scenario seeding and the probes are the harness work still to do. First scenario to drive end to end:
**#2 Festival with a supply chain.**
