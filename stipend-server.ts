import "dotenv/config";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { loadCitizens } from "./lib.js";

// The "central bank window": one paid route per citizen, payTo = that citizen's wallet.
// The treasury pays these routes (npm run fund-agents) → USDC moves treasury→citizen, GASLESS
// (EIP-3009, facilitator-sponsored). Funding the whole economy needs zero ETH — only the
// treasury's USDC. This is just the x402 seller pattern with the citizen as the payee.
const STIPEND = process.env.STIPEND ?? "$0.02";
const PORT = 4040;

const facilitator = new HTTPFacilitatorClient({
  url: process.env.FACILITATOR_URL ?? "https://x402.org/facilitator",
});
const server = new x402ResourceServer(facilitator).register("eip155:84532", new ExactEvmScheme());

const citizens = loadCitizens();
const routes = Object.fromEntries(
  citizens.map((c) => [
    `GET /stipend/${c.id}`,
    {
      accepts: [{ scheme: "exact", price: STIPEND, network: "eip155:84532", payTo: c.address }],
      description: `Stipend to ${c.id}`,
    },
  ]),
) as Parameters<typeof paymentMiddleware>[0];

const app = express();
app.use(paymentMiddleware(routes, server));
for (const c of citizens) {
  app.get(`/stipend/${c.id}`, (_q, r) => r.json({ ok: true, to: c.id, address: c.address }));
}

app.listen(PORT, "127.0.0.1", () => // loopback only: wallets + control plane, never the LAN
  console.log(`🏦 Stipend window at http://localhost:${PORT} — ${citizens.length} citizens @ ${STIPEND} each (payTo each citizen)`),
);
