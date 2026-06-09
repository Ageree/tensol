export const BILLING_PRODUCTS = [
  {
    key: "starter",
    name: "Sthrip Starter",
    monthly_usd_cents: 9_900,
    scan_credits: 2,
    asset_limit: 5,
    concurrent_tests: 1,
    description:
      "Two blackbox assessments per month for early teams validating public attack surface.",
    features: [
      "2 tests per month",
      "1 concurrent test",
      "Up to 5 assets",
      "Authenticated web/API scans",
      "PDF reports",
    ],
  },
  {
    key: "team",
    name: "Sthrip Team",
    monthly_usd_cents: 29_900,
    scan_credits: 15,
    asset_limit: 20,
    concurrent_tests: 4,
    description:
      "A self-serve team plan for recurring web/API coverage and compliance-ready reports.",
    features: [
      "15 tests per month",
      "4 concurrent tests",
      "Up to 20 assets",
      "API and GraphQL coverage",
      "Compliance reports",
      "Branded reports",
    ],
  },
  {
    key: "pro",
    name: "Sthrip Pro",
    monthly_usd_cents: 59_900,
    scan_credits: 50,
    asset_limit: 100,
    concurrent_tests: 10,
    description:
      "High-throughput coverage for product security teams with broader attack-surface monitoring.",
    features: [
      "50 tests per month",
      "10 concurrent tests",
      "Up to 100 assets",
      "Internal and external scanning",
      "Attack-surface monitoring",
      "Priority support",
    ],
  },
] as const;

export type BillingProduct = (typeof BILLING_PRODUCTS)[number];
export type BillingProductKey = BillingProduct["key"];

export function productByKey(key: string): BillingProduct | null {
  return BILLING_PRODUCTS.find((product) => product.key === key) ?? null;
}

