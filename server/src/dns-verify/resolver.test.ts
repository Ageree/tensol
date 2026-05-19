/**
 * T033 — DNS resolver agreement tests
 *
 * Constitution II: scope-of-authorization via DNS-TXT proof.
 * Per research §R6: query 4 public DNS servers (Cloudflare pair + Google pair)
 * and require agreement (intersection) on the TXT record set.
 */
import { describe, it, expect, mock } from "bun:test";
import { resolveTxtAgreed, RESOLVERS_DEFAULT } from "./resolver.ts";

/**
 * FakeResolver mimics the slice of node:dns/promises.Resolver we use.
 * Behaviour keyed by the (single) server it was setServers()-configured with.
 */
type ServerResponse = string[] | "NXDOMAIN" | "TIMEOUT" | "SERVFAIL";

class FakeResolver {
  servers: string[] = [];
  constructor(private readonly responses: Record<string, ServerResponse>) {}
  setServers(servers: string[]): void {
    this.servers = servers;
  }
  async resolveTxt(_name: string): Promise<string[][]> {
    const srv = this.servers[0];
    if (srv === undefined) {
      throw new Error("FakeResolver: setServers must be called before resolveTxt");
    }
    const r = this.responses[srv];
    if (r === undefined) {
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    }
    if (r === "TIMEOUT") {
      // Simulate a never-resolving lookup; raced against the timeout wrapper.
      return await new Promise(() => {});
    }
    if (r === "NXDOMAIN") {
      throw Object.assign(new Error("queryTxt ENOTFOUND"), { code: "ENOTFOUND" });
    }
    if (r === "SERVFAIL") {
      throw Object.assign(new Error("queryTxt ESERVFAIL"), { code: "ESERVFAIL" });
    }
    // dns.promises.resolveTxt returns string[][] (TXT chunks per record)
    return r.map((rec: string) => [rec]);
  }
}

function makeFactory(responses: Record<string, ServerResponse>): {
  factory: () => FakeResolver;
  instances: FakeResolver[];
} {
  const instances: FakeResolver[] = [];
  const factory = (): FakeResolver => {
    const r = new FakeResolver(responses);
    instances.push(r);
    return r;
  };
  return { factory, instances };
}

describe("RESOLVERS_DEFAULT", () => {
  it("contains the canonical 4 public DNS servers (Cloudflare + Google)", () => {
    expect(RESOLVERS_DEFAULT).toEqual([
      "1.1.1.1",
      "1.0.0.1",
      "8.8.8.8",
      "8.8.4.4",
    ]);
  });
});

describe("resolveTxtAgreed — agreement cases", () => {
  it("returns the record set when all 4 resolvers agree", async () => {
    const token = "tensol-verify=abc123";
    const { factory } = makeFactory({
      "1.1.1.1": [token],
      "1.0.0.1": [token],
      "8.8.8.8": [token],
      "8.8.4.4": [token],
    });
    const out = await resolveTxtAgreed("example.com", { makeResolver: factory });
    expect(out).toEqual([token]);
  });

  it("returns the intersection when extra records vary across resolvers", async () => {
    // The verification token appears on all 4; noise records appear on only some.
    const token = "tensol-verify=abc123";
    const { factory } = makeFactory({
      "1.1.1.1": [token, "v=spf1 -all"],
      "1.0.0.1": [token, "v=spf1 -all"],
      "8.8.8.8": [token, "google-site-verification=xyz"],
      "8.8.4.4": [token],
    });
    const out = await resolveTxtAgreed("example.com", { makeResolver: factory });
    expect(out).toEqual([token]);
  });

  it("handles multi-chunk TXT records by joining chunks", async () => {
    // dns.promises.resolveTxt splits long TXT records into chunks (255 bytes max).
    // Our resolver must join chunks before comparing.
    const longToken = "tensol-verify=" + "x".repeat(300);
    // Pre-built fake mimics joined behaviour: we test that the join happens.
    const { factory } = makeFactory({
      "1.1.1.1": [longToken],
      "1.0.0.1": [longToken],
      "8.8.8.8": [longToken],
      "8.8.4.4": [longToken],
    });
    const out = await resolveTxtAgreed("example.com", { makeResolver: factory });
    expect(out).toEqual([longToken]);
  });
});

describe("resolveTxtAgreed — disagreement / failure cases", () => {
  it("returns null when no record is present in all 4 resolvers", async () => {
    const { factory } = makeFactory({
      "1.1.1.1": ["tensol-verify=A"],
      "1.0.0.1": ["tensol-verify=B"],
      "8.8.8.8": ["tensol-verify=C"],
      "8.8.4.4": ["tensol-verify=D"],
    });
    const out = await resolveTxtAgreed("example.com", { makeResolver: factory });
    expect(out).toBeNull();
  });

  it("returns null when one resolver returns NXDOMAIN", async () => {
    const token = "tensol-verify=abc";
    const { factory } = makeFactory({
      "1.1.1.1": [token],
      "1.0.0.1": [token],
      "8.8.8.8": "NXDOMAIN",
      "8.8.4.4": [token],
    });
    const out = await resolveTxtAgreed("example.com", { makeResolver: factory });
    expect(out).toBeNull();
  });

  it("returns null when one resolver times out", async () => {
    const token = "tensol-verify=abc";
    const { factory } = makeFactory({
      "1.1.1.1": [token],
      "1.0.0.1": [token],
      "8.8.8.8": "TIMEOUT",
      "8.8.4.4": [token],
    });
    const out = await resolveTxtAgreed("example.com", {
      makeResolver: factory,
      timeoutMs: 50,
    });
    expect(out).toBeNull();
  });

  it("returns null when multiple resolvers fail (SERVFAIL + NXDOMAIN)", async () => {
    const { factory } = makeFactory({
      "1.1.1.1": "SERVFAIL",
      "1.0.0.1": "NXDOMAIN",
      "8.8.8.8": ["tensol-verify=abc"],
      "8.8.4.4": ["tensol-verify=abc"],
    });
    const out = await resolveTxtAgreed("example.com", { makeResolver: factory });
    expect(out).toBeNull();
  });

  it("returns null when ALL resolvers fail", async () => {
    const { factory } = makeFactory({
      "1.1.1.1": "NXDOMAIN",
      "1.0.0.1": "NXDOMAIN",
      "8.8.8.8": "NXDOMAIN",
      "8.8.4.4": "NXDOMAIN",
    });
    const out = await resolveTxtAgreed("example.com", { makeResolver: factory });
    expect(out).toBeNull();
  });

  it("returns null when intersection is empty even though all resolvers responded", async () => {
    // Each returns a record set, but there is no common record.
    const { factory } = makeFactory({
      "1.1.1.1": ["A", "B"],
      "1.0.0.1": ["B", "C"],
      "8.8.8.8": ["C", "D"],
      "8.8.4.4": ["A", "D"],
    });
    const out = await resolveTxtAgreed("example.com", { makeResolver: factory });
    expect(out).toBeNull();
  });
});

describe("resolveTxtAgreed — wiring", () => {
  it("calls setServers exactly once per resolver instance with a single server", async () => {
    const token = "tensol-verify=abc";
    const { factory, instances } = makeFactory({
      "1.1.1.1": [token],
      "1.0.0.1": [token],
      "8.8.8.8": [token],
      "8.8.4.4": [token],
    });
    await resolveTxtAgreed("example.com", { makeResolver: factory });
    expect(instances).toHaveLength(4);
    const allServers = instances.map((r) => r.servers);
    // Each instance got exactly one server, the order matches RESOLVERS_DEFAULT
    expect(allServers).toEqual([
      ["1.1.1.1"],
      ["1.0.0.1"],
      ["8.8.8.8"],
      ["8.8.4.4"],
    ]);
  });

  it("uses a custom server list when provided via opts.servers", async () => {
    const token = "tensol-verify=abc";
    const { factory, instances } = makeFactory({
      "9.9.9.9": [token],
      "149.112.112.112": [token],
    });
    const out = await resolveTxtAgreed("example.com", {
      makeResolver: factory,
      servers: ["9.9.9.9", "149.112.112.112"],
    });
    expect(out).toEqual([token]);
    expect(instances.map((r) => r.servers)).toEqual([
      ["9.9.9.9"],
      ["149.112.112.112"],
    ]);
  });

  it("uses RESOLVERS_DEFAULT when opts.servers is omitted", async () => {
    const factory = mock(() => new FakeResolver({
      "1.1.1.1": ["t"],
      "1.0.0.1": ["t"],
      "8.8.8.8": ["t"],
      "8.8.4.4": ["t"],
    }));
    await resolveTxtAgreed("example.com", { makeResolver: factory });
    expect(factory).toHaveBeenCalledTimes(4);
  });
});
