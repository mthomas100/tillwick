import "dotenv/config";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { payForItemEnv } from "./buy.js";
import { checkAuth } from "./citizens/auth.js";

// ===== Phase 0 KEYSTONE: a headless agent autonomously settles an x402 buy. =====

// ---- Seam A: auth (ANTHROPIC_API_KEY by default; see citizens/auth.ts) ----
checkAuth("citizen0");

const GOOD = process.env.GOOD ?? "bread";
const PRICE = process.env.PRICE ?? "$0.01";
const TICKS = Number(process.env.TICKS ?? 3);

// ---- The ONE tool the citizen can call: buy via x402 (via buy.ts) ----
let purchases = 0;
const buy = tool(
  "buy",
  "Pay for an item via x402 using testnet USDC. Call this when you decide the item is worth buying.",
  { item: z.string().describe(`the item id to buy, e.g. "${GOOD}"`) },
  async ({ item }) => {
    const r = await payForItemEnv(item);
    purchases++;
    console.log(`  💸 buy(${item}) -> HTTP ${r.status}${r.txHash ? ` tx ${r.txHash}` : ""}`);
    return {
      content: [
        { type: "text", text: `Paid for ${item}. HTTP ${r.status}. tx=${r.txHash || "(in PAYMENT-RESPONSE)"}` },
      ],
    };
  },
);

const world = createSdkMcpServer({ name: "shop", version: "1.0.0", tools: [buy] });

async function runTick(n: number) {
  console.log(`\n=== TICK ${n}/${TICKS} ===`);
  const prompt =
    `You are a hungry courier in a tiny testnet town, standing inside the bakery. ` +
    `The shelf has "${GOOD}" for ${PRICE} (testnet USDC) and you have a small budget. ` +
    `If it's worth it, buy it by calling the buy tool with item "${GOOD}". Then say in one sentence what you decided.`;

  // Cast the message stream to any: this is a measurement harness, not typed business logic.
  for await (const msg of query({
    prompt,
    options: {
      mcpServers: { shop: world },
      allowedTools: ["mcp__shop__buy"],
      disallowedTools: ["Bash", "Edit", "Write", "Read", "WebSearch", "WebFetch"],
      systemPrompt: "You are a frugal but hungry courier. Be decisive. Keep talk to one short sentence.",
      model: "claude-sonnet-4-6",
      maxTurns: 4,
    },
  }) as AsyncIterable<any>) {
    if (msg?.type === "assistant") {
      for (const b of msg.message?.content ?? []) {
        if (b?.type === "text" && b.text?.trim()) console.log(`  🗣  ${b.text.trim()}`);
      }
    } else if (msg?.type === "result") {
      const cost = msg.total_cost_usd;
      console.log(
        `  ✓ tick ${n}: ${msg.subtype}` +
          (cost != null ? `  (cost_usd=${cost})` : ""),
      );
    }
  }
}

for (let n = 1; n <= TICKS; n++) {
  await runTick(n);
  if (n < TICKS) await new Promise((r) => setTimeout(r, 4000)); // ~4s pacing floor
}
console.log(`\nDONE. ${purchases} purchase(s) this run. Verify settlement: npm run billing-check`);
