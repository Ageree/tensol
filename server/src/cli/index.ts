import {
  createHttpSthripAgentClientFromEnv,
  type StartWhiteboxArgs,
  type SthripAgentClient,
} from "../agent/client.ts";

export interface CliIo {
  writeOut(line: string): void;
  writeErr(line: string): void;
}

export interface RunCliOptions {
  readonly client?: SthripAgentClient;
  readonly io?: CliIo;
}

const USAGE = [
  "Usage:",
  "  bun run agent:cli -- health",
  "  bun run agent:cli -- reviews list",
  "  bun run agent:cli -- reviews get <review_id>",
  "  bun run agent:cli -- findings list <review_id>",
  "  bun run agent:cli -- whitebox start (--repo owner/name | --repo-id id) [--ref ref] [--mode fast|deep]",
  "  bun run agent:cli -- jobs get <job_id>",
  "",
  "Environment:",
  "  STHRIP_API_URL    Base API URL, for example https://api.sthrip.dev",
  "  STHRIP_API_TOKEN  Agent bearer token created in Settings",
].join("\n");

function defaultIo(): CliIo {
  return {
    writeOut: (line) => process.stdout.write(`${line}\n`),
    writeErr: (line) => process.stderr.write(`${line}\n`),
  };
}

function writeJson(io: CliIo, payload: unknown): void {
  io.writeOut(JSON.stringify(payload, null, 2));
}

function usage(io: CliIo, detail?: string): number {
  if (detail) io.writeErr(detail);
  io.writeErr(USAGE);
  return 2;
}

function help(io: CliIo): number {
  io.writeOut(USAGE);
  return 0;
}

function requireArg(io: CliIo, value: string | undefined, name: string): string | null {
  if (value) return value;
  usage(io, `missing ${name}`);
  return null;
}

function parseWhiteboxArgs(io: CliIo, args: string[]): StartWhiteboxArgs | null {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const value = args[i + 1];
    if (!flag?.startsWith("--")) return null;
    if (!value || value.startsWith("--")) return null;
    if (flag === "--repo") out.repo = value;
    else if (flag === "--repo-id") out.repo_id = value;
    else if (flag === "--ref") out.ref = value;
    else if (flag === "--mode") out.mode = value;
    else return null;
    i += 1;
  }
  if (!out.repo && !out.repo_id) return null;
  if (out.mode !== undefined && out.mode !== "fast" && out.mode !== "deep") {
    return null;
  }
  return {
    ...(out.repo_id !== undefined ? { repo_id: out.repo_id } : {}),
    ...(out.repo !== undefined ? { repo: out.repo } : {}),
    ...(out.ref !== undefined ? { ref: out.ref } : {}),
    ...(out.mode !== undefined ? { mode: out.mode as "fast" | "deep" } : {}),
  };
}

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const io = options.io ?? defaultIo();
  const [resource, action, arg, ...rest] = argv;
  const getClient = () => options.client ?? createHttpSthripAgentClientFromEnv();

  try {
    if (
      resource === "help" ||
      resource === "--help" ||
      resource === "-h"
    ) {
      return help(io);
    }

    if (resource === "health" && action === undefined) {
      const client = getClient();
      writeJson(io, await client.health());
      return 0;
    }

    if (resource === "reviews" && action === "list" && arg === undefined) {
      const client = getClient();
      writeJson(io, await client.listReviews());
      return 0;
    }

    if (resource === "reviews" && action === "get") {
      const reviewId = requireArg(io, arg, "review_id");
      if (!reviewId) return 2;
      if (rest.length > 0) return usage(io, "unexpected extra arguments");
      const client = getClient();
      writeJson(io, await client.getReview(reviewId));
      return 0;
    }

    if (resource === "findings" && action === "list") {
      const reviewId = requireArg(io, arg, "review_id");
      if (!reviewId) return 2;
      if (rest.length > 0) return usage(io, "unexpected extra arguments");
      const client = getClient();
      writeJson(io, await client.listFindings(reviewId));
      return 0;
    }

    if (resource === "whitebox" && action === "start") {
      const parsed = parseWhiteboxArgs(
        io,
        [arg, ...rest].filter((value): value is string => value !== undefined),
      );
      if (!parsed) return usage(io, "invalid whitebox arguments");
      const client = getClient();
      writeJson(io, await client.startWhitebox(parsed));
      return 0;
    }

    if (resource === "jobs" && action === "get") {
      const jobId = requireArg(io, arg, "job_id");
      if (!jobId) return 2;
      if (rest.length > 0) return usage(io, "unexpected extra arguments");
      const client = getClient();
      writeJson(io, await client.getJob(jobId));
      return 0;
    }

    return usage(io);
  } catch (error) {
    io.writeErr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  const code = await runCli(Bun.argv.slice(2));
  process.exitCode = code;
}
