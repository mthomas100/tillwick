import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SHOP_PORT } from "./registry.js";

// Launch all 5 citizen-owned shops on :4031..4035 (one process each, catalog-driven).
const HERE = dirname(fileURLToPath(import.meta.url)); // shops/
const ROOT = dirname(HERE); // repo root
const tsx = join(ROOT, "node_modules", ".bin", "tsx");

for (const [shop, port] of Object.entries(SHOP_PORT)) {
  const child = spawn(tsx, ["shops/shop-server.ts"], {
    cwd: ROOT,
    env: { ...process.env, SHOP: shop, PORT: String(port) },
  });
  child.stdout.on("data", (d) => process.stdout.write(`[${shop}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${shop}!] ${d}`));
  child.on("exit", (code) => console.error(`[run-shops] ${shop} exited (${code})`));
}
console.log(`launched ${Object.keys(SHOP_PORT).length} shops on :${Object.values(SHOP_PORT).join(", :")}`);
