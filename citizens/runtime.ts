// Citizen-side runtime safety — the fleet OBEYS the sim's run-state governor (the other half of the
// INC-2026-06-18 fix). The sim can pause / stop / budget-cap the world; here each citizen actually checks
// BEFORE it spends a single token, reports its usage to the meter + ceiling, and backs off on errors so a
// rate-limit can never become the 8s-retry storm that pinned the account in the incident.

const SIM = process.env.SIM_URL ?? "http://localhost:4042";

export type CitizenDirective = {
  runnable: boolean; // status === "running" AND this citizen is enabled
  status: string;
  reason: string | null;
  model: string; // the model this citizen should use this tick (per-agent, hot-swappable from the roster)
  remainingMs: number | null;
  gameMinutes: number; // the sim game clock — feeds Mind.nowGameMin() so memories are stamped in game-time
  enabledIds: string[]; // A3: ids of all ENABLED citizens — so the dialogue driver only initiates vs a live partner (D17)
};

// Read the governor. FAIL SAFE: if the sim is unreachable we return non-runnable — no governor means no
// spend (the opposite of the incident, where the loop ran regardless).
export async function fetchDirective(id: string, fallbackModel: string): Promise<CitizenDirective> {
  try {
    const res = await fetch(`${SIM}/run-state`);
    const s = (await res.json()) as {
      status?: string;
      reason?: string | null;
      remainingMs?: number | null;
      gameMinutes?: number;
      roster?: Array<{ id: string; enabled?: boolean; model?: string }>;
    };
    const me = Array.isArray(s.roster) ? s.roster.find((e) => e.id === id) : undefined;
    const enabled = me ? me.enabled !== false : true;
    const enabledIds = Array.isArray(s.roster) ? s.roster.filter((e) => e.enabled !== false).map((e) => e.id) : [];
    return {
      runnable: s.status === "running" && enabled,
      status: s.status ?? "unknown",
      reason: s.reason ?? null,
      model: (me && me.model) || fallbackModel,
      remainingMs: s.remainingMs ?? null,
      gameMinutes: Number(s.gameMinutes ?? 0) || 0,
      enabledIds,
    };
  } catch {
    return { runnable: false, status: "sim-unreachable", reason: null, model: fallbackModel, remainingMs: null, gameMinutes: 0, enabledIds: [] };
  }
}

export type UsageSample = { apiEquivUsd: number; tokensIn: number; tokensOut: number; cacheWrite: number; cacheRead: number };

// Pull the API-equiv cost + token usage out of the SDK's final `result` message. On a subscription the cost is
// NOTIONAL (api-equivalent), with an API key it is the real spend. Either way it is what the burn meter tracks.
export function extractUsage(msg: unknown): UsageSample | null {
  const m = msg as { type?: string; total_cost_usd?: number; usage?: Record<string, number> } | null;
  if (!m || m.type !== "result") return null;
  const u = m.usage ?? {};
  return {
    apiEquivUsd: Number(m.total_cost_usd ?? 0) || 0,
    tokensIn: Number(u.input_tokens ?? 0) || 0,
    tokensOut: Number(u.output_tokens ?? 0) || 0,
    cacheWrite: Number(u.cache_creation_input_tokens ?? 0) || 0,
    cacheRead: Number(u.cache_read_input_tokens ?? 0) || 0,
  };
}

// Report a tick's usage to the sim (feeds the GUI token meter + the fleet budget ceiling). Best-effort.
// D32/H15: optional per-tick latency brackets ride along ({sdk: ACT-turn ms, sim: renderTick ms, total:
// whole-tick ms}) so per-tick latency lands on the flight tape; the sim ignores unknown fields today.
export type LatencySample = { sdk: number; sim: number; total: number };
export async function reportUsage(id: string, tick: number, usage: UsageSample, latencyMs?: LatencySample): Promise<void> {
  try {
    await fetch(`${SIM}/usage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, tick, ...usage, ...(latencyMs ? { latencyMs } : {}) }),
    });
  } catch {
    /* meter is best-effort; never let it break a tick */
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
