import { query } from "./_generated/server";

export const getFeatureFlags = query({
  args: {},
  handler: async () => ({
    yookassa_live: false,
    billing_live: true,
    billing_provider: "manual" as const,
    research_enabled: true,
    exploit_enabled: true,
  }),
});
