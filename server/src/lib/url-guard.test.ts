import { describe, it, expect } from "bun:test";
import { guardTargetUrl } from "./url-guard.ts";

describe("guardTargetUrl — valid public URLs pass", () => {
  it("accepts https://example.com", () => {
    const r = guardTargetUrl("https://example.com");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url.hostname).toBe("example.com");
  });

  it("accepts https://api.example.com:443/path", () => {
    const r = guardTargetUrl("https://api.example.com:443/path");
    expect(r.ok).toBe(true);
  });

  it("accepts plain http://example.com", () => {
    const r = guardTargetUrl("http://example.com");
    expect(r.ok).toBe(true);
  });

  it("accepts public IPv4 http://1.2.3.4", () => {
    const r = guardTargetUrl("http://1.2.3.4");
    expect(r.ok).toBe(true);
  });

  it("accepts deep subdomain + query string", () => {
    const r = guardTargetUrl(
      "https://very-deep-domain.subdomain.example.org/some/path?query=1",
    );
    expect(r.ok).toBe(true);
  });

  it("accepts public IPv6 https://[2606:4700:4700::1111]", () => {
    const r = guardTargetUrl("https://[2606:4700:4700::1111]");
    expect(r.ok).toBe(true);
  });
});

describe("guardTargetUrl — malformed / unsupported scheme rejected", () => {
  it("rejects empty string", () => {
    const r = guardTargetUrl("");
    expect(r.ok).toBe(false);
  });

  it("rejects whitespace-only", () => {
    const r = guardTargetUrl("   ");
    expect(r.ok).toBe(false);
  });

  it("rejects 'not-a-url'", () => {
    const r = guardTargetUrl("not-a-url");
    expect(r.ok).toBe(false);
  });

  it("rejects file:///etc/passwd", () => {
    const r = guardTargetUrl("file:///etc/passwd");
    expect(r.ok).toBe(false);
  });

  it("rejects javascript:alert(1)", () => {
    const r = guardTargetUrl("javascript:alert(1)");
    expect(r.ok).toBe(false);
  });

  it("rejects ftp://example.com", () => {
    const r = guardTargetUrl("ftp://example.com");
    expect(r.ok).toBe(false);
  });

  it("rejects data: URLs", () => {
    const r = guardTargetUrl("data:text/plain,hello");
    expect(r.ok).toBe(false);
  });
});

describe("guardTargetUrl — private IPv4 rejected", () => {
  it("rejects http://192.168.1.1 (RFC1918)", () => {
    const r = guardTargetUrl("http://192.168.1.1");
    expect(r.ok).toBe(false);
  });

  it("rejects http://10.0.0.1 (RFC1918)", () => {
    const r = guardTargetUrl("http://10.0.0.1");
    expect(r.ok).toBe(false);
  });

  it("rejects http://172.16.5.10 (RFC1918)", () => {
    const r = guardTargetUrl("http://172.16.5.10");
    expect(r.ok).toBe(false);
  });

  it("rejects http://172.31.255.254 (RFC1918 upper bound)", () => {
    const r = guardTargetUrl("http://172.31.255.254");
    expect(r.ok).toBe(false);
  });

  it("accepts http://172.32.0.1 (just outside RFC1918)", () => {
    const r = guardTargetUrl("http://172.32.0.1");
    expect(r.ok).toBe(true);
  });

  it("rejects http://127.0.0.1 (loopback)", () => {
    const r = guardTargetUrl("http://127.0.0.1");
    expect(r.ok).toBe(false);
  });

  it("rejects http://127.5.5.5 (entire loopback /8)", () => {
    const r = guardTargetUrl("http://127.5.5.5");
    expect(r.ok).toBe(false);
  });

  it("rejects http://0.0.0.0 (this network)", () => {
    const r = guardTargetUrl("http://0.0.0.0");
    expect(r.ok).toBe(false);
  });

  it("rejects http://169.254.169.254 (AWS metadata!)", () => {
    const r = guardTargetUrl("http://169.254.169.254");
    expect(r.ok).toBe(false);
  });
});

describe("guardTargetUrl — private IPv6 rejected", () => {
  it("rejects http://[::1] (loopback)", () => {
    const r = guardTargetUrl("http://[::1]/");
    expect(r.ok).toBe(false);
  });

  it("rejects http://[::] (unspecified)", () => {
    const r = guardTargetUrl("http://[::]/");
    expect(r.ok).toBe(false);
  });

  it("rejects http://[fc00::1] (ULA)", () => {
    const r = guardTargetUrl("http://[fc00::1]/");
    expect(r.ok).toBe(false);
  });

  it("rejects http://[fd12:3456:789a::1] (ULA)", () => {
    const r = guardTargetUrl("http://[fd12:3456:789a::1]/");
    expect(r.ok).toBe(false);
  });

  it("rejects http://[fe80::1] (link-local)", () => {
    const r = guardTargetUrl("http://[fe80::1]/");
    expect(r.ok).toBe(false);
  });
});

describe("guardTargetUrl — localhost variants rejected", () => {
  it("rejects http://localhost", () => {
    const r = guardTargetUrl("http://localhost");
    expect(r.ok).toBe(false);
  });

  it("rejects http://LOCALHOST (case-insensitive)", () => {
    const r = guardTargetUrl("http://LOCALHOST");
    expect(r.ok).toBe(false);
  });

  it("rejects http://localhost.localdomain", () => {
    const r = guardTargetUrl("http://localhost.localdomain");
    expect(r.ok).toBe(false);
  });

  it("rejects http://foo.localhost (*.localhost)", () => {
    const r = guardTargetUrl("http://foo.localhost");
    expect(r.ok).toBe(false);
  });
});
