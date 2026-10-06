// The economy's shop wiring: which shop is on which port, who owns it, and which good sells where.
// Owners match personas (baker→bakery, etc.) so buying moves USDC into the owner's wallet → circulation.
export const SHOP_PORT: Record<string, number> = {
  bakery: 4031,
  cafe: 4032,
  grocer: 4033,
  depot: 4034,
  smithy: 4035,
};

export const SHOP_OWNER: Record<string, string> = {
  bakery: "baker",
  cafe: "barista",
  grocer: "grocer",
  depot: "courier",
  smithy: "smith",
};

export const GOOD_TO_SHOP: Record<string, string> = {
  bread: "bakery",
  bun: "bakery",
  coffee: "cafe",
  apple: "grocer",
  milk: "grocer",
  delivery: "depot",
  nail: "smithy",
};

export const shopUrl = (shopId: string): string => `http://localhost:${SHOP_PORT[shopId]}`;
