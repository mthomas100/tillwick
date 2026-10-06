import "dotenv/config";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCitizens } from "../lib.js";
import { SHOP_PORT, SHOP_OWNER } from "./registry.js";

// A catalog-driven x402 shop. `SHOP=bakery PORT=4031 tsx shops/shop-server.ts` (defaults to bakery:4031).
// Goods come from world.json; payTo = the OWNING citizen's wallet (so buying circulates money). The shop
// holds no private key — the facilitator settles. Only buy routes are paywalled; /shop catalog is free.
const HERE = dirname(fileURLToPath(import.meta.url)); // shops/
const ROOT = dirname(HERE); // repo root
const world = JSON.parse(readFileSync(join(ROOT, "sim", "world.json"), "utf8"));

const SHOP = process.env.SHOP ?? "bakery";
const PORT = Number(process.env.PORT ?? SHOP_PORT[SHOP] ?? 4031);
const FACILITATOR = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";

const b = world.buildings.find((x: { id: string; type: string }) => x.id === SHOP);
if (!b || b.type !== "shop") {
  console.error(`❌ "${SHOP}" is not a shop in world.json`);
  process.exit(1);
}
const owner = SHOP_OWNER[SHOP];
const ownerCitizen = loadCitizens().find((c) => c.id === owner);
if (!ownerCitizen) {
  console.error(`❌ owner "${owner}" not in citizens.local.json — run \`npm run gen-citizens\``);
  process.exit(1);
}
const payTo = ownerCitizen.address;
const goods: Array<{ id: string; price: string }> = b.goods ?? [];

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR });
const server = new x402ResourceServer(facilitator).register("eip155:84532", new ExactEvmScheme());

const stock: Record<string, number> = {};
for (const g of goods) stock[g.id] = 100;

const routes = Object.fromEntries(
  goods.map((g) => [
    `GET /shop/buy/${g.id}`,
    { accepts: [{ scheme: "exact", price: g.price, network: "eip155:84532", payTo }], description: `Buy ${g.id} from ${b.label}` },
  ]),
) as Parameters<typeof paymentMiddleware>[0];

const app = express();
app.use(paymentMiddleware(routes, server));

app.get("/shop", (_q, r) =>
  r.json({ shop: SHOP, label: b.label, owner, payTo, goods: goods.map((g) => ({ ...g, stock: stock[g.id] })) }),
);
for (const g of goods) {
  app.get(`/shop/buy/${g.id}`, (_q, r) => {
    stock[g.id] = Math.max(0, (stock[g.id] ?? 0) - 1);
    r.json({ item: g.id, ok: true, stockLeft: stock[g.id], shop: SHOP, owner });
  });
}

app.listen(PORT, "127.0.0.1", () => // loopback only: wallets + control plane, never the LAN
  console.log(`🏪 ${b.label} (${SHOP}, owner ${owner}) :${PORT} — ${goods.map((g) => `${g.id} ${g.price}`).join(", ")} → ${payTo}`),
);
