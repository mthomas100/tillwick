import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { type Complete } from "./llm.js";

// THE RELATIONSHIP GRAPH (Park et al., Generative Agents, UIST '23, §4 social — "agents form opinions of
// and relationships with one another"). A per-agent, ego-centric KNOWS-EACH-OTHER graph: who this agent has
// met, how familiar they've become, and the economic texture of the tie (who they buy from / sell to). It
// turns raw interaction signals — DIALOGUE (from cognition/dialogue.ts), CO-PRESENCE, and TRADES (from the
// economy ledger: a `purchase` event's actor↔counterparty) — into durable social structure that:
//   • conditions prompts/dialogue   ("what is my relationship with X?" → describeRelationship)
//   • becomes salient memory         (reflectionDigest → fed into cognition/reflection.ts)
//   • informs economic/social choice (topRelations → "who would I buy from / spend time with")
//
// DELIBERATELY DUMB BY DESIGN (mirrors memory-stream.ts):
//   • Familiarity, counts, recency are pure arithmetic — NO model call on the hot path → zero token spend.
//   • The ONE place LLM judgement helps (turning a relationship's history into a directed sentiment/trust
//     read) goes through the INJECTED `Complete` seam (llm.ts), is OPTIONAL, and DEGRADES to neutral if the
//     model is unavailable. The graph is fully functional with the model switched off (the build/test path).
//   • Time is GAME-minutes from the sim clock (run-state.ts `gameMinutes`), INJECTED so this stays a pure
//     data structure; a pure instance defaults to 0.
//
// DURABLE + RESUMABLE (the program's durability rule, copied from memory-stream.ts): each agent's graph is
// one JSONL file under sim/data/relationships/<agentId>.jsonl — every edge is one line; an update REWRITES
// the file (the edge set is small, ~25 peers, so a compacting rewrite is cheap and keeps the file canonical).
// Construction LOADS the existing file, so a sim restart resumes the agent's relationships intact. Writes are
// BEST-EFFORT (a disk error is swallowed, never propagated — persistence must not crash a tick).
//
// EGO-CENTRIC: each agent owns its OWN file and its OWN view of the world. The graph is a per-agent object,
// not a global one — exactly like the memory stream. Familiarity ends up ~symmetric in practice (both
// parties see the same interactions) but is stored independently, and directed sentiment/trust is genuinely
// one-sided (A may trust B more than B trusts A).

// ---- the interaction signal (agreed with `conversationalist`; trade is from the ledger) ----------------

// A dialogue happened between two agents. Emitted ONCE per conversation (not per line) at conversation close.
// This is the NORMALIZED signal the graph updates from; the citizen loop typically gets it by feeding
// cognition/dialogue.ts's `DialogueSummary` record through `ingestDialogueSummary()` (below), which maps its
// fields onto this shape. `topics`/`summary` are optional (free signal when present — they enrich the
// reflection digest — but familiarity grows from participants + turns alone if absent).
export type DialogueSignal = {
  kind: "dialogue";
  participants: [string, string]; // the two agentIds (order-insensitive)
  turns?: number; // utterances exchanged (a long talk counts more than a quick hello); default 1
  topics?: string[]; // optional salient topics/beliefs discussed
  summary?: string; // optional one-line NL summary of the conversation
  atGameMin: number; // sim clock at conversation close
};

// The structural shape of cognition/dialogue.ts's `DialogueSummary` (the record it emits ONCE at conversation
// close, "agreed with sociologist — the relationship graph ingests this verbatim"). Declared STRUCTURALLY
// here — NOT imported — so relationships.ts stays decoupled (compiles standalone, no cross-module import; a
// real DialogueSummary satisfies this by duck-typing). `ingestDialogueSummary()` maps it onto our signals,
// reconciling the field-name differences (endedAtGameMin→atGameMin, single topic→topics[], per-POV
// summaryFor→this ego's line) and HONORING `outcome`: a "walk_by" is a co-presence (they saw each other but
// didn't talk), only "conversed" bumps dialogue familiarity.
export type DialogueSummaryLike = {
  participants: [string, string];
  turns: number;
  endedAtGameMin: number;
  outcome: "conversed" | "walk_by";
  topic?: string;
  summaryFor?: Record<string, string>;
};

// Two agents were co-located (the architecture chose walk-by, or just shared a space). A weak familiarity
// signal — you get to know the faces you keep seeing around.
export type CoPresenceSignal = {
  kind: "copresence";
  participants: [string, string];
  atGameMin: number;
};

// An economic interaction: `actor` BOUGHT `item` from `counterparty` for `priceUsdc` (one `purchase` event
// in the ledger — sales are the mirror of a purchase). This is the strongest familiarity signal AND the only
// one that carries an economic direction (buyer→seller), which feeds "who would I buy from".
export type TradeSignal = {
  kind: "trade";
  buyer: string;
  seller: string;
  item?: string;
  priceUsdc?: number;
  atGameMin: number;
};

export type InteractionSignal = DialogueSignal | CoPresenceSignal | TradeSignal;

// How much each signal adds to familiarity. A trade is the strongest tie (you transacted real value); a full
// conversation is next (scaled by depth); a co-presence is a faint "I keep seeing them around" nudge. These
// are deliberately small so familiarity is a slow accumulator (repeated contact, not one big event).
export const FAMILIARITY_GAIN = {
  dialogueBase: 1.0, // per conversation, before the turns multiplier
  dialoguePerTurn: 0.15, // each additional utterance deepens it a little
  dialogueMax: 3.0, // cap a single conversation's contribution (a marathon chat isn't unbounded)
  copresence: 0.25, // faint — familiar faces
  trade: 2.0, // strongest — you exchanged value
} as const;

// ---- the stored edge ------------------------------------------------------------------------------------

// One ego→other relationship. All counts/recency are pure data; sentiment/trust are the OPTIONAL directed
// read (LLM or neutral default). `topics` is a small recency-bounded bag of what the pair has talked
// about/traded, so the reflection digest and describeRelationship read concretely ("you usually buy bread
// from baker; last talked about the festival").
export type Relation = {
  other: string;
  familiarity: number; // monotonic accumulator (see FAMILIARITY_GAIN); higher = better known
  dialogues: number; // # conversations
  coPresences: number; // # co-presence ticks
  tradesAsBuyer: number; // times EGO bought from `other`
  tradesAsSeller: number; // times EGO sold to `other`
  usdcBought: number; // total USDC ego spent with `other` (ego as buyer)
  usdcSold: number; // total USDC ego earned from `other` (ego as seller)
  firstSeenGameMin: number;
  lastInteractionGameMin: number;
  topics: string[]; // recency-bounded salient topics/items (most-recent last)
  sentiment?: number; // OPTIONAL directed feeling, -1..1 (negative=wary, positive=warm); LLM-scored
  trust?: number; // OPTIONAL directed reliance, 0..1; LLM-scored. Undefined = "not yet assessed".
  // OPINION NOTE (town-alive B2): the ego's current stated stance on `other` WITH its reason — updated after
  // conversations (opinion DRIFT is the point: a bad exchange can flip like→dislike). Distinct from the
  // numeric sentiment: this is the quotable "I like her — she always asks about my music" that conditions
  // dialogue and shows in describeRelationship. Set via noteOpinion() (pure) or assessOpinion() (LLM seam).
  opinion?: { stance: "like" | "dislike" | "neutral"; why: string; atGameMin: number };
};

// On-disk record === the public Relation (no extra internal fields needed — the edge IS the record).
type StoredRelation = Relation;

const HERE = dirname(fileURLToPath(import.meta.url)); // cognition/
const ROOT = dirname(HERE); // repo root
// sim/data/ is already gitignored, so per-agent relationship graphs ride along untracked (matches memory).
const DEFAULT_DIR = join(ROOT, "sim", "data", "relationships");

const MAX_TOPICS = 8; // recency-bounded topic bag per relationship (keeps the digest/describe concise)

export type RelationshipGraphOpts = {
  dir?: string; // override the store directory (tests, harness); defaults to sim/data/relationships
  nowGameMin?: () => number; // injected sim clock (game-minutes); defaults to () => 0 for a pure instance
};

export class RelationshipGraph {
  readonly agentId: string;
  private readonly file: string;
  private readonly nowGameMin: () => number;
  private readonly edges = new Map<string, StoredRelation>(); // otherId -> relation

  constructor(agentId: string, opts: RelationshipGraphOpts = {}) {
    this.agentId = agentId;
    this.nowGameMin = opts.nowGameMin ?? (() => 0);
    const safe = agentId.replace(/[^A-Za-z0-9._-]/g, "_") || "agent"; // can't escape the dir (like memory-stream)
    this.file = join(opts.dir ?? DEFAULT_DIR, `${safe}.jsonl`);
    this.load();
  }

  // ---- ingestion ----------------------------------------------------------------------------------------

  /**
   * Fold one interaction signal into the graph. The single entry point the sim/citizen loop calls after a
   * dialogue, a co-presence, or a trade. Resolves which peer(s) this agent relates to (ignoring itself),
   * strengthens familiarity, bumps the relevant counters, records recency + topics, and persists. A signal
   * that doesn't involve this agent is a no-op (the loop may broadcast a trade to both parties' graphs).
   * Pure arithmetic — NO model call, never throws (persistence is best-effort).
   */
  updateFromInteraction(sig: InteractionSignal): void {
    let changed = false;
    if (sig.kind === "dialogue") {
      const other = this.otherOf(sig.participants);
      if (!other) return;
      const turns = Math.max(1, sig.turns ?? 1);
      const gain = Math.min(
        FAMILIARITY_GAIN.dialogueMax,
        FAMILIARITY_GAIN.dialogueBase + (turns - 1) * FAMILIARITY_GAIN.dialoguePerTurn,
      );
      const r = this.edge(other, sig.atGameMin);
      r.familiarity += gain;
      r.dialogues += 1;
      r.lastInteractionGameMin = Math.max(r.lastInteractionGameMin, sig.atGameMin);
      if (sig.topics?.length) this.addTopics(r, sig.topics);
      if (sig.summary?.trim()) this.addTopics(r, [sig.summary.trim()]);
      changed = true;
    } else if (sig.kind === "copresence") {
      const other = this.otherOf(sig.participants);
      if (!other) return;
      const r = this.edge(other, sig.atGameMin);
      r.familiarity += FAMILIARITY_GAIN.copresence;
      r.coPresences += 1;
      r.lastInteractionGameMin = Math.max(r.lastInteractionGameMin, sig.atGameMin);
      changed = true;
    } else if (sig.kind === "trade") {
      // A trade touches BOTH directions on THIS ego's books only if ego is a party. Determine ego's role.
      if (sig.buyer === this.agentId && sig.seller !== this.agentId) {
        const r = this.edge(sig.seller, sig.atGameMin);
        r.familiarity += FAMILIARITY_GAIN.trade;
        r.tradesAsBuyer += 1;
        r.usdcBought += num(sig.priceUsdc);
        r.lastInteractionGameMin = Math.max(r.lastInteractionGameMin, sig.atGameMin);
        if (sig.item) this.addTopics(r, [`bought ${sig.item}`]);
        changed = true;
      } else if (sig.seller === this.agentId && sig.buyer !== this.agentId) {
        const r = this.edge(sig.buyer, sig.atGameMin);
        r.familiarity += FAMILIARITY_GAIN.trade;
        r.tradesAsSeller += 1;
        r.usdcSold += num(sig.priceUsdc);
        r.lastInteractionGameMin = Math.max(r.lastInteractionGameMin, sig.atGameMin);
        if (sig.item) this.addTopics(r, [`sold ${sig.item}`]);
        changed = true;
      }
      // ego not a party (or self-trade like the courier buying its own delivery) → no-op.
    }
    if (changed) this.persist();
  }

  /**
   * Adapter: fold cognition/dialogue.ts's `DialogueSummary` (its verbatim end-of-conversation record) into
   * THIS ego's graph. The citizen-loop hook calls this once per participant after a conversation closes, so
   * the lead's wiring is a one-liner and `relationships.ts` consumes `conversationalist`'s record directly
   * (no translation in the hook). Reconciles the field names and HONORS `outcome`:
   *   • "conversed" → a dialogue signal (familiarity scaled by `turns`; `topic` + this ego's `summaryFor`
   *     line enrich the digest).
   *   • "walk_by"   → a co-presence signal (they co-located but didn't engage — a faint "familiar face").
   * A summary that doesn't involve this ego is a no-op. Never throws (delegates to updateFromInteraction).
   */
  ingestDialogueSummary(s: DialogueSummaryLike, forAgent: string = this.agentId): void {
    if (forAgent !== this.agentId) return; // this record isn't for my graph
    if (s.outcome === "walk_by") {
      this.updateFromInteraction({ kind: "copresence", participants: s.participants, atGameMin: s.endedAtGameMin });
      return;
    }
    // Only the distilled `topic` PHRASE belongs in the recency-bounded topic bag ("the harvest festival") —
    // it's what the tie is "about" and reads cleanly in describeRelationship. The per-POV `summaryFor` line
    // is a full first-person SENTENCE ("I talked with barista about … barista said: …"): that's memory-stream
    // material (the citizen loop already folds it in via mind.observe at citizen.ts:174), NOT a topic tag.
    // Stuffing that sentence into the topic bag was the 0-edges-era truncation bug — addTopics' 80-char clamp
    // severed it mid-word, persisting "…barista said" with nothing after. Keep topics = topic phrases only.
    const topics: string[] = [];
    if (s.topic?.trim()) topics.push(s.topic.trim());
    this.updateFromInteraction({
      kind: "dialogue",
      participants: s.participants,
      turns: s.turns,
      atGameMin: s.endedAtGameMin,
      ...(topics.length ? { topics } : {}),
    });
  }

  // ---- queries ------------------------------------------------------------------------------------------

  /** The raw relation with `other`, or undefined if they've never interacted. */
  relationWith(other: string): Relation | undefined {
    const r = this.edges.get(other);
    return r ? clone(r) : undefined;
  }

  /** Every relation, strongest (most familiar) first — the ego's whole social world. */
  all(): Relation[] {
    return [...this.edges.values()].sort((a, b) => b.familiarity - a.familiarity).map(clone);
  }

  /** How many people this agent knows. */
  size(): number {
    return this.edges.size;
  }

  /**
   * The `n` strongest relations — "who would I spend time with / buy from?". `kind` biases the ranking:
   *   • "familiar" (default) — pure familiarity (social: who I'd seek out).
   *   • "supplier"           — who I've bought from most (economic: a known seller I'd return to).
   *   • "customer"           — who I've sold to most (a repeat buyer).
   * Always falls back to familiarity as the tie-break so a sensible order emerges even with sparse economics.
   */
  topRelations(n: number, kind: "familiar" | "supplier" | "customer" = "familiar"): Relation[] {
    const key = (r: Relation): number =>
      kind === "supplier" ? r.tradesAsBuyer : kind === "customer" ? r.tradesAsSeller : r.familiarity;
    return [...this.edges.values()]
      .filter((r) => (kind === "supplier" ? r.tradesAsBuyer > 0 : kind === "customer" ? r.tradesAsSeller > 0 : true))
      .sort((a, b) => key(b) - key(a) || b.familiarity - a.familiarity)
      .slice(0, Math.max(0, n))
      .map(clone);
  }

  /**
   * Natural-language answer to "what is my relationship with X?" — for prompt / dialogue conditioning. A
   * single concrete sentence grounded in the actual history (familiarity tier + the economic texture + the
   * last topic + sentiment/trust if assessed). Returns a "don't know them" line for a stranger. Pure
   * string-building — no model call.
   */
  describeRelationship(other: string): string {
    const r = this.edges.get(other);
    if (!r) return `You don't know ${other} yet.`;
    const parts: string[] = [`You know ${other} ${tier(r.familiarity)}`];

    const econ: string[] = [];
    if (r.tradesAsBuyer > 0) econ.push(`you've bought from them ${r.tradesAsBuyer}× (${usd(r.usdcBought)})`);
    if (r.tradesAsSeller > 0) econ.push(`you've sold to them ${r.tradesAsSeller}× (${usd(r.usdcSold)})`);
    if (econ.length) parts.push(econ.join(" and "));
    else if (r.dialogues > 0) parts.push(`you've talked ${r.dialogues}×`);

    if (typeof r.sentiment === "number") parts.push(`you feel ${sentimentWord(r.sentiment)} toward them`);
    if (typeof r.trust === "number") parts.push(`you ${trustWord(r.trust)} them`);
    if (r.opinion && r.opinion.stance !== "neutral") parts.push(`you ${r.opinion.stance} them — ${r.opinion.why}`);

    const lastTopic = r.topics[r.topics.length - 1];
    if (lastTopic) parts.push(`recently: ${lastTopic}`);

    return parts.join("; ") + ".";
  }

  /**
   * A REFLECTION DIGEST: the agent's most salient relationships rendered as short NL lines, so relationships
   * become memories the reflection pass can synthesize over (the design's "feeds reflection: who would I
   * spend time with / buy from?"). Returns the top-`max` relations by familiarity as one line each. The
   * citizen loop folds these into the memory stream as observations (HOOKS SPEC below), where reflection
   * surfaces and cites them. Pure string-building — no model call.
   */
  reflectionDigest(max = 5): string[] {
    return this.topRelations(max, "familiar").map((r) => this.describeRelationship(r.other));
  }

  // ---- opinion note (town-alive B2: opinions as first-class, with drift) --------------------------------

  /**
   * Set the ego's stated opinion of `other` directly (pure — no model call). The caller supplies the stance
   * + a short why; stamps the current game-minute. No-op for an unknown peer with no prior interaction —
   * an opinion needs at least an edge to hang on (creates the edge if the pair HAS interacted elsewhere in
   * the same tick; callers should ingest the interaction first).
   */
  noteOpinion(other: string, stance: "like" | "dislike" | "neutral", why: string): Relation | undefined {
    const r = this.edges.get(other);
    if (!r) return undefined;
    r.opinion = { stance, why: clipWords((why || "").trim(), 120), atGameMin: this.nowGameMin() };
    this.persist();
    return clone(r);
  }

  /**
   * OPINION DRIFT via the injected LLM seam: after a conversation, re-read the ego's stance on `other` from
   * the fresh history (topics now include the new conversation). One tiny call; best-effort — a hiccup or
   * unparseable reply leaves the prior opinion untouched. `context` (optional) is the just-closed
   * conversation's one-line summary so the model reacts to what ACTUALLY happened, not only the totals.
   */
  async assessOpinion(other: string, complete: Complete, context?: string): Promise<Relation | undefined> {
    const r = this.edges.get(other);
    if (!r) return undefined;
    try {
      const out = await complete(opinionPrompt(this.agentId, other, r, context), {
        system:
          "You judge one simulated person's current opinion of another from their history. " +
          "Reply with exactly one line: LIKE, DISLIKE, or NEUTRAL, then a colon, then a short reason " +
          "(under 15 words). Example: LIKE: she always sets aside the good apples for me.",
        maxTokens: 40,
      });
      const parsed = parseOpinion(out);
      if (parsed) {
        r.opinion = { stance: parsed.stance, why: parsed.why, atGameMin: this.nowGameMin() };
        this.persist();
      }
    } catch {
      /* model unavailable → keep the prior opinion (degrade, don't die) */
    }
    return clone(r);
  }

  // ---- optional LLM-scored directed read (sentiment / trust) --------------------------------------------

  /**
   * Use the injected `Complete` seam to turn a relationship's accumulated history into a directed
   * sentiment (-1..1) and trust (0..1) read, stored back on the edge. OPTIONAL and best-effort: a thrown or
   * unparseable completion leaves the prior values untouched (the graph stays fully usable with the model
   * off — this is the only token-spending method and it's never on the hot path). Returns the updated
   * relation, or undefined if `other` is unknown.
   */
  async assessSentiment(other: string, complete: Complete): Promise<Relation | undefined> {
    const r = this.edges.get(other);
    if (!r) return undefined;
    try {
      const out = await complete(sentimentPrompt(this.agentId, other, r), {
        system:
          "You read one simulated person's feelings about another from their shared history. " +
          "Reply with exactly two numbers on one line: sentiment trust — sentiment in [-1,1] " +
          "(negative=wary/dislike, positive=warm/like), trust in [0,1]. Nothing else.",
        maxTokens: 16,
      });
      const parsed = parseSentiment(out);
      if (parsed) {
        r.sentiment = parsed.sentiment;
        r.trust = parsed.trust;
        this.persist();
        return clone(r);
      }
    } catch {
      /* model unavailable / garbled → keep prior sentiment/trust (degrade, don't die) */
    }
    return clone(r);
  }

  // ---- internals ----------------------------------------------------------------------------------------

  // Resolve "the other party" in a 2-participant signal relative to this ego. Returns undefined if ego isn't
  // a participant, or if the pair is degenerate (self↔self) — both are no-ops.
  private otherOf(participants: [string, string]): string | undefined {
    const [a, b] = participants;
    if (a === this.agentId && b !== this.agentId) return b;
    if (b === this.agentId && a !== this.agentId) return a;
    return undefined;
  }

  // Get-or-create the edge to `other`, stamping firstSeen/lastInteraction on creation.
  private edge(other: string, atGameMin: number): StoredRelation {
    let r = this.edges.get(other);
    if (!r) {
      r = {
        other,
        familiarity: 0,
        dialogues: 0,
        coPresences: 0,
        tradesAsBuyer: 0,
        tradesAsSeller: 0,
        usdcBought: 0,
        usdcSold: 0,
        firstSeenGameMin: atGameMin,
        lastInteractionGameMin: atGameMin,
        topics: [],
      };
      this.edges.set(other, r);
    }
    return r;
  }

  // Append topics to the recency-bounded bag, de-duplicating against what's already there (so "bought bread"
  // 10× doesn't fill the bag) and trimming to the most-recent MAX_TOPICS. Over-long entries are clamped
  // CLEANLY (clipWords: word-boundary + "…"), never severed mid-word — so a topic always reads as a complete
  // fragment even if a caller hands in something long (defense-in-depth against the old truncation bug).
  private addTopics(r: StoredRelation, topics: string[]): void {
    for (const t of topics) {
      const topic = clipWords((t || "").trim(), 80);
      if (!topic) continue;
      const i = r.topics.indexOf(topic);
      if (i >= 0) r.topics.splice(i, 1); // move an existing topic to most-recent
      r.topics.push(topic);
    }
    if (r.topics.length > MAX_TOPICS) r.topics = r.topics.slice(r.topics.length - MAX_TOPICS);
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const raw = readFileSync(this.file, "utf8");
      if (!raw.trim()) return;
      for (const line of raw.split("\n")) {
        if (!line) continue;
        try {
          const o = JSON.parse(line) as Partial<StoredRelation>;
          if (!o.other) continue; // skip a malformed/partial line
          this.edges.set(o.other, {
            other: o.other,
            familiarity: num(o.familiarity),
            dialogues: num(o.dialogues),
            coPresences: num(o.coPresences),
            tradesAsBuyer: num(o.tradesAsBuyer),
            tradesAsSeller: num(o.tradesAsSeller),
            usdcBought: num(o.usdcBought),
            usdcSold: num(o.usdcSold),
            firstSeenGameMin: num(o.firstSeenGameMin),
            lastInteractionGameMin: num(o.lastInteractionGameMin),
            topics: Array.isArray(o.topics) ? o.topics.filter((t) => typeof t === "string").slice(-MAX_TOPICS) : [],
            ...(typeof o.sentiment === "number" ? { sentiment: o.sentiment } : {}),
            ...(typeof o.trust === "number" ? { trust: o.trust } : {}),
            ...(isOpinion(o.opinion) ? { opinion: { stance: o.opinion.stance, why: o.opinion.why, atGameMin: num(o.opinion.atGameMin) } } : {}),
          });
        } catch {
          /* skip a malformed/partial line */
        }
      }
    } catch {
      /* corrupt/missing file → start empty (best-effort, never crash the caller) */
    }
  }

  // The edge set is small (~peers), so we keep the file CANONICAL with a compacting rewrite on each update —
  // simpler than append + dedup-on-load, and one line per current edge. Called synchronously on EVERY changed
  // ingest (flush-on-update), so a single tick after a trade/dialogue reliably lands the edge (the bounded-run
  // concern). Write is ATOMIC (write a temp sibling, then rename over the target — rename is atomic on the same
  // filesystem) so a crash/kill mid-write can never truncate an agent's whole social graph; the worst case is
  // the prior good file survives. Best-effort throughout: a disk error is swallowed (persistence must never
  // crash a tick) — the in-memory graph is still correct for this process and the next update re-flushes.
  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const body = [...this.edges.values()].map((r) => JSON.stringify(r)).join("\n");
      const tmp = `${this.file}.tmp-${process.pid}`;
      writeFileSync(tmp, body ? body + "\n" : "", "utf8");
      renameSync(tmp, this.file); // atomic replace — readers never see a half-written file
    } catch {
      /* ignore disk errors — the in-memory graph is still correct for this process; next update re-flushes */
    }
  }
}

// ---- pure helpers (familiarity tiers, formatting, sentiment parsing) -------------------------------------

// Familiarity → an NL tier for describeRelationship. Thresholds are gentle: a single hello ≈ "a little",
// a few interactions ≈ "fairly well", many ≈ "very well".
export function tier(familiarity: number): string {
  if (familiarity >= 12) return "very well";
  if (familiarity >= 5) return "fairly well";
  if (familiarity >= 2) return "a little";
  return "barely";
}

function sentimentWord(s: number): string {
  if (s >= 0.5) return "warmly";
  if (s >= 0.15) return "positively";
  if (s <= -0.5) return "coldly";
  if (s <= -0.15) return "warily";
  return "neutrally";
}

function trustWord(t: number): string {
  if (t >= 0.66) return "trust";
  if (t >= 0.33) return "somewhat trust";
  return "distrust";
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function num(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

// Clamp a string to <= max chars WITHOUT severing a word: if it fits, return as-is; otherwise cut at the last
// word boundary before the limit (falling back to a hard cut if there's no space) and append "…". Keeps a
// stored topic readable as a complete fragment — the fix for the "…barista said" mid-word truncation.
export function clipWords(s: string, max: number): string {
  if (s.length <= max) return s;
  const slice = s.slice(0, max - 1); // leave room for the ellipsis
  const lastSpace = slice.lastIndexOf(" ");
  const head = lastSpace > Math.floor(max / 2) ? slice.slice(0, lastSpace) : slice; // don't cut to almost nothing
  return head.replace(/[\s.,;:!?-]+$/, "") + "…";
}

function clone(r: StoredRelation): Relation {
  return { ...r, topics: [...r.topics], ...(r.opinion ? { opinion: { ...r.opinion } } : {}) };
}

// Structural check for a persisted opinion note (tolerant load — a hand-edited/legacy line can't crash it).
function isOpinion(o: unknown): o is { stance: "like" | "dislike" | "neutral"; why: string; atGameMin?: number } {
  if (!o || typeof o !== "object") return false;
  const s = (o as { stance?: unknown }).stance;
  return (s === "like" || s === "dislike" || s === "neutral") && typeof (o as { why?: unknown }).why === "string";
}

function opinionPrompt(ego: string, other: string, r: Relation, context?: string): string {
  const facts: string[] = [
    `Conversations: ${r.dialogues}; co-presences: ${r.coPresences}`,
    `${ego} bought from ${other} ${r.tradesAsBuyer}×; sold to them ${r.tradesAsSeller}×`,
  ];
  if (r.topics.length) facts.push(`Recent topics: ${r.topics.slice(-4).join("; ")}`);
  if (r.opinion) facts.push(`Prior opinion: ${r.opinion.stance.toUpperCase()}: ${r.opinion.why}`);
  if (context?.trim()) facts.push(`Just now: ${context.trim()}`);
  return [
    `${ego}'s history with ${other}:`,
    facts.map((f) => `- ${f}`).join("\n"),
    ``,
    `What is ${ego}'s current opinion of ${other}? One line: LIKE|DISLIKE|NEUTRAL: <short reason>.`,
  ].join("\n");
}

/** Parse "LIKE: she saves me the good apples" → {stance, why}. Tolerant of case/leading noise; null when no
 *  stance word is found (caller keeps the prior opinion). Exported for the driver test. */
export function parseOpinion(text: string): { stance: "like" | "dislike" | "neutral"; why: string } | null {
  const m = (text || "").match(/\b(like|dislike|neutral)\b\s*[:\-—]?\s*(.*)/i);
  if (!m) return null;
  const stance = m[1].toLowerCase() as "like" | "dislike" | "neutral";
  const why = clipWords((m[2] || "").trim().replace(/[\s.]+$/, ""), 120) || "no particular reason";
  return { stance, why };
}

function sentimentPrompt(ego: string, other: string, r: Relation): string {
  const facts: string[] = [
    `Conversations: ${r.dialogues}`,
    `Times ${ego} bought from ${other}: ${r.tradesAsBuyer} (${usd(r.usdcBought)})`,
    `Times ${ego} sold to ${other}: ${r.tradesAsSeller} (${usd(r.usdcSold)})`,
    `Co-presence: ${r.coPresences}`,
  ];
  if (r.topics.length) facts.push(`Recent topics/exchanges: ${r.topics.join("; ")}`);
  return [
    `${ego}'s shared history with ${other}:`,
    facts.map((f) => `- ${f}`).join("\n"),
    ``,
    `How does ${ego} feel about ${other}? Reply: sentiment trust`,
  ].join("\n");
}

// Parse "0.6 0.8" (sentiment trust) from a model line; clamps to range. Returns null if it can't find two
// numbers (caller keeps the prior values).
export function parseSentiment(text: string): { sentiment: number; trust: number } | null {
  if (!text) return null;
  const nums = (text.match(/-?\d+(\.\d+)?/g) ?? []).map(Number).filter((n) => Number.isFinite(n));
  if (nums.length < 2) return null;
  const sentiment = Math.max(-1, Math.min(1, nums[0]));
  const trust = Math.max(0, Math.min(1, nums[1]));
  return { sentiment, trust };
}
