// Scripted random-walk driver (NO LLM) — posts random goTo's so the town visibly comes alive.
// Phase 3 replaces this with real Claude citizens deciding where to go. Run alongside `npm run sim`.
const SIM = process.env.SIM_URL ?? "http://localhost:4042";
const INTERVAL = Number(process.env.DRIVE_MS ?? 1200);

function rnd<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const meta = (await (await fetch(`${SIM}/meta`)).json()) as { agents: string[]; buildings: string[] };
console.log(`driver: ${meta.agents.length} agents, ${meta.buildings.length} buildings — random-walking every ${INTERVAL}ms`);

setInterval(async () => {
  const agent = rnd(meta.agents);
  const to = rnd(meta.buildings);
  try {
    const res = await fetch(`${SIM}/act`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent, action: "goTo", to }),
    });
    const j = (await res.json()) as { steps?: number };
    if (j.steps) console.log(`  ${agent} -> ${to} (${j.steps} steps)`);
  } catch {
    /* sim not up yet */
  }
}, INTERVAL);
