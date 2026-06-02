import { describe, expect, test } from "bun:test";

import { runCli, type CliIo } from "./index.ts";

function makeIo(): CliIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    writeOut: (line) => stdout.push(line),
    writeErr: (line) => stderr.push(line),
  };
}

function makeClient() {
  return {
    health: async () => ({ ok: true }),
    listReviews: async () => ({ reviews: [{ review_id: "01REV", mode: "fast" }] }),
    getReview: async (reviewId: string) => ({ id: reviewId, status: "completed" }),
    listFindings: async (reviewId: string) => ({ review_id: reviewId, findings: [] }),
    startWhitebox: async (args: Record<string, unknown>) => ({
      review_id: "01REV",
      job_id: "01JOB",
      status: "queued",
      args,
    }),
    getJob: async (jobId: string) => ({ job_id: jobId, status: "pending" }),
  };
}

describe("runCli", () => {
  test("health prints JSON", async () => {
    const io = makeIo();
    const exitCode = await runCli(["health"], { client: makeClient(), io });

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout[0]!)).toEqual({ ok: true });
    expect(io.stderr).toEqual([]);
  });

  test("reviews get and findings list route positional ids", async () => {
    const io = makeIo();
    const client = makeClient();

    expect(await runCli(["reviews", "get", "01REV"], { client, io })).toBe(0);
    expect(await runCli(["findings", "list", "01REV"], { client, io })).toBe(0);

    expect(JSON.parse(io.stdout[0]!)).toEqual({ id: "01REV", status: "completed" });
    expect(JSON.parse(io.stdout[1]!)).toEqual({ review_id: "01REV", findings: [] });
  });

  test("whitebox start parses repo, ref, and mode flags", async () => {
    const io = makeIo();
    const exitCode = await runCli(
      ["whitebox", "start", "--repo", "acme/api", "--ref", "main", "--mode", "deep"],
      { client: makeClient(), io },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout[0]!)).toEqual({
      review_id: "01REV",
      job_id: "01JOB",
      status: "queued",
      args: { repo: "acme/api", ref: "main", mode: "deep" },
    });
  });

  test("jobs get prints job JSON", async () => {
    const io = makeIo();
    const exitCode = await runCli(["jobs", "get", "01JOB"], {
      client: makeClient(),
      io,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout[0]!)).toEqual({ job_id: "01JOB", status: "pending" });
  });

  test("invalid command returns 2 and writes usage", async () => {
    const io = makeIo();
    const exitCode = await runCli(["whitebox", "start", "--mode", "slow"], {
      client: makeClient(),
      io,
    });

    expect(exitCode).toBe(2);
    expect(io.stdout).toEqual([]);
    expect(io.stderr.join("\n")).toContain("Usage:");
  });

  test("help and unknown commands do not require API env vars", async () => {
    const helpIo = makeIo();
    expect(await runCli(["--help"], { io: helpIo })).toBe(0);
    expect(helpIo.stdout.join("\n")).toContain("Usage:");
    expect(helpIo.stdout.join("\n")).toContain("bun run agent:cli -- health");
    expect(helpIo.stderr).toEqual([]);

    const invalidIo = makeIo();
    expect(await runCli(["wat"], { io: invalidIo })).toBe(2);
    expect(invalidIo.stdout).toEqual([]);
    expect(invalidIo.stderr.join("\n")).toContain("Usage:");
  });

  test("extra positional arguments print usage instead of failing silently", async () => {
    const io = makeIo();
    expect(await runCli(["reviews", "get", "01REV", "extra"], { client: makeClient(), io }))
      .toBe(2);

    expect(io.stdout).toEqual([]);
    expect(io.stderr.join("\n")).toContain("unexpected extra arguments");
    expect(io.stderr.join("\n")).toContain("Usage:");
  });
});
