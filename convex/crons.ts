import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const crons = cronJobs();

crons.interval("noop backend heartbeat", { hours: 6 }, internal.crons.backendHeartbeat, {});

export default crons;

export const backendHeartbeat = internalAction({
  args: {},
  handler: async () => null,
});
