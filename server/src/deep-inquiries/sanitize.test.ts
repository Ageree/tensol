import { describe, it, expect } from "bun:test";
import { sanitizeScopeText, sanitizeScopeTextSimple } from "./sanitize.ts";

// NOTE: every credential-shaped string in this file is SYNTHETIC.
// Do not match these against any real secret-detection regex.

describe("sanitizeScopeText — key:value password patterns", () => {
  it("redacts password:value (colon, no space)", () => {
    const r = sanitizeScopeText("password:foo123");
    expect(r.sanitized).toBe("password: [REDACTED]");
    expect(r.redactedCount).toBe(1);
    expect(r.rulesHit).toContain("password-key-value");
  });

  it("redacts password = \"quoted value\"", () => {
    const r = sanitizeScopeText('password = "secret-value"');
    expect(r.sanitized).toBe("password = [REDACTED]");
    expect(r.redactedCount).toBe(1);
  });

  it("redacts pwd:abc", () => {
    const r = sanitizeScopeText("pwd:abc");
    expect(r.sanitized).toBe("pwd: [REDACTED]");
  });

  it("redacts Pass: 'qwerty' (single quotes, case-insensitive)", () => {
    const r = sanitizeScopeText("Pass: 'qwerty'");
    expect(r.sanitized).toBe("Pass: [REDACTED]");
  });

  it("redacts api_key=xyz", () => {
    const r = sanitizeScopeText("api_key=xyz");
    expect(r.sanitized).toBe("api_key= [REDACTED]");
  });

  it("redacts apikey=xyz (no separator)", () => {
    const r = sanitizeScopeText("apikey=xyz");
    expect(r.sanitized).toBe("apikey= [REDACTED]");
  });

  it("redacts api-key:xyz (dashed)", () => {
    const r = sanitizeScopeText("api-key:xyz");
    expect(r.sanitized).toBe("api-key: [REDACTED]");
  });

  it("redacts secret=mySecret", () => {
    const r = sanitizeScopeText("secret=mySecret");
    expect(r.sanitized).toBe("secret= [REDACTED]");
  });

  it("redacts token: abc.def.ghi", () => {
    const r = sanitizeScopeText("token: abc.def.ghi");
    expect(r.sanitized).toBe("token: [REDACTED]");
  });

  it("redacts Bearer eyJhbGciOiJIUzI1NiJ9.foo.bar", () => {
    const r = sanitizeScopeText("Bearer eyJhbGciOiJIUzI1NiJ9.foo.bar");
    // Bearer is matched as key; separator is whitespace -> falls to space-key form
    // We support `bearer <value>` (no colon/equals) too via a dedicated rule entry
    expect(r.sanitized).toContain("[REDACTED]");
    expect(r.sanitized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });
});

describe("sanitizeScopeText — URL basic auth", () => {
  it("redacts password in https://user:password@host", () => {
    const r = sanitizeScopeText("https://admin:hunter2@srv.example.com/path");
    expect(r.sanitized).toBe("https://admin:[REDACTED]@srv.example.com/path");
    expect(r.rulesHit).toContain("url-basic-auth");
  });

  it("redacts password in http://user:pw@host (http)", () => {
    const r = sanitizeScopeText("http://u:p@h.example/");
    expect(r.sanitized).toBe("http://u:[REDACTED]@h.example/");
  });

  it("does not redact URL without basic-auth", () => {
    const r = sanitizeScopeText("https://srv.example.com/path");
    expect(r.sanitized).toBe("https://srv.example.com/path");
    expect(r.redactedCount).toBe(0);
  });
});

describe("sanitizeScopeText — provider-specific token patterns", () => {
  it("redacts AWS access key AKIA...", () => {
    const r = sanitizeScopeText("AKIA0123456789ABCDEF");
    expect(r.sanitized).toBe("[REDACTED]");
    expect(r.rulesHit).toContain("aws-access-key");
  });

  it("redacts GitHub PAT ghp_...", () => {
    const r = sanitizeScopeText("ghp_AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPPQQ");
    expect(r.sanitized).toBe("[REDACTED]");
    expect(r.rulesHit).toContain("github-pat");
  });

  it("redacts Slack token xoxb-...", () => {
    const r = sanitizeScopeText("xoxb-1234567890-abcdefghijk");
    expect(r.sanitized).toBe("[REDACTED]");
    expect(r.rulesHit).toContain("slack-token");
  });

  it("redacts Anthropic key sk-ant-FAKETEST...", () => {
    const r = sanitizeScopeText(
      "sk-ant-FAKETEST-abcdefghijklmnopqrstuvwxyz-NOT_REAL"
    );
    expect(r.sanitized).toBe("[REDACTED]");
    expect(r.rulesHit).toContain("anthropic-key");
  });

  it("redacts OpenAI-style key sk-FAKETEST...", () => {
    const r = sanitizeScopeText("sk-FAKETESTabcdefghijklmnopqrstuvwxyz0123");
    expect(r.sanitized).toBe("[REDACTED]");
    expect(r.rulesHit).toContain("openai-key");
  });
});

describe("sanitizeScopeText — negative + edge cases", () => {
  it("leaves prose 'strong password policy' untouched", () => {
    const r = sanitizeScopeText("We use a strong password policy here.");
    expect(r.sanitized).toBe("We use a strong password policy here.");
    expect(r.redactedCount).toBe(0);
    expect(r.rulesHit).toEqual([]);
  });

  it("leaves 'password requirements' prose untouched", () => {
    const r = sanitizeScopeText("Document the password requirements clearly.");
    expect(r.sanitized).toBe("Document the password requirements clearly.");
    expect(r.redactedCount).toBe(0);
  });

  it("handles empty string", () => {
    const r = sanitizeScopeText("");
    expect(r.sanitized).toBe("");
    expect(r.redactedCount).toBe(0);
    expect(r.rulesHit).toEqual([]);
  });

  it("handles null-ish input gracefully", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = sanitizeScopeText(null as unknown as string);
    expect(r.sanitized).toBe("");
    expect(r.redactedCount).toBe(0);
  });

  it("redacts multiple credentials in a single input", () => {
    const r = sanitizeScopeText(
      "Login: password:foo123 and api_key=ABCDEFG please test."
    );
    expect(r.sanitized).toContain("password: [REDACTED]");
    expect(r.sanitized).toContain("api_key= [REDACTED]");
    expect(r.redactedCount).toBeGreaterThanOrEqual(2);
  });

  it("redacts multiple distinct rule classes in one input", () => {
    const input =
      "Use https://admin:hunter2@srv.example.com and AKIA0123456789ABCDEF for now.";
    const r = sanitizeScopeText(input);
    expect(r.sanitized).toContain("[REDACTED]");
    expect(r.sanitized).not.toContain("hunter2");
    expect(r.sanitized).not.toContain("AKIA0123456789ABCDEF");
    expect(r.rulesHit).toContain("url-basic-auth");
    expect(r.rulesHit).toContain("aws-access-key");
    expect(r.redactedCount).toBeGreaterThanOrEqual(2);
  });
});

describe("sanitizeScopeText — JWT tokens", () => {
  it("redacts a classic JWT", () => {
    const r = sanitizeScopeText(
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqb2huIn0.signature_abc"
    );
    expect(r.sanitized).toBe("[REDACTED]");
    expect(r.rulesHit).toContain("jwt-token");
  });

  it("redacts a JWT embedded in prose, preserving surrounding text", () => {
    const r = sanitizeScopeText(
      "my token is eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqb2huIn0.signature_abc please rotate"
    );
    expect(r.sanitized).toBe("my token is [REDACTED] please rotate");
    expect(r.sanitized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });
});

describe("sanitizeScopeText — SSH private keys", () => {
  it("redacts an RSA PEM private key block", () => {
    const block =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...synthetic...\nfake-key-body-multiline\n-----END RSA PRIVATE KEY-----";
    const r = sanitizeScopeText(`prefix\n${block}\nsuffix`);
    expect(r.sanitized).toBe("prefix\n[REDACTED]\nsuffix");
    expect(r.rulesHit).toContain("ssh-private-key");
  });

  it("redacts an OPENSSH PEM private key block", () => {
    const block =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAfake\nsynthetic-body\n-----END OPENSSH PRIVATE KEY-----";
    const r = sanitizeScopeText(block);
    expect(r.sanitized).toBe("[REDACTED]");
    expect(r.rulesHit).toContain("ssh-private-key");
  });

  it("redacts an ED25519 PEM private key block", () => {
    const block =
      "-----BEGIN ED25519 PRIVATE KEY-----\nsynthetic-ed25519-body\n-----END ED25519 PRIVATE KEY-----";
    const r = sanitizeScopeText(block);
    expect(r.sanitized).toBe("[REDACTED]");
    expect(r.rulesHit).toContain("ssh-private-key");
  });

  it("redacts a bare PRIVATE KEY block (no algorithm prefix)", () => {
    const block =
      "-----BEGIN PRIVATE KEY-----\nsynthetic-pkcs8-body\n-----END PRIVATE KEY-----";
    const r = sanitizeScopeText(block);
    expect(r.sanitized).toBe("[REDACTED]");
    expect(r.rulesHit).toContain("ssh-private-key");
  });
});

describe("sanitizeScopeText — DB / broker connection strings", () => {
  it("redacts postgres connection string with embedded password", () => {
    const r = sanitizeScopeText(
      "postgres://admin:hunter2@db.example.com:5432/myapp"
    );
    expect(r.sanitized).toBe(
      "postgres://admin:[REDACTED]@db.example.com:5432/myapp"
    );
    expect(r.rulesHit).toContain("conn-string-with-pwd");
  });

  it("redacts mongodb+srv connection string", () => {
    const r = sanitizeScopeText(
      "mongodb+srv://user:pwd@cluster.mongodb.net/db"
    );
    expect(r.sanitized).toBe(
      "mongodb+srv://user:[REDACTED]@cluster.mongodb.net/db"
    );
    expect(r.rulesHit).toContain("conn-string-with-pwd");
  });

  it("redacts redis connection string with empty username", () => {
    const r = sanitizeScopeText("redis://:password@redis.local:6379");
    expect(r.sanitized).toBe("redis://:[REDACTED]@redis.local:6379");
    expect(r.rulesHit).toContain("conn-string-with-pwd");
  });

  it("redacts mysql connection string", () => {
    const r = sanitizeScopeText("mysql://root:toor@127.0.0.1:3306/app");
    expect(r.sanitized).toBe(
      "mysql://root:[REDACTED]@127.0.0.1:3306/app"
    );
  });

  it("redacts amqps broker URL", () => {
    const r = sanitizeScopeText("amqps://svc:s3cret@mq.example.com:5671/vh");
    expect(r.sanitized).toBe(
      "amqps://svc:[REDACTED]@mq.example.com:5671/vh"
    );
  });

  it("does not double-redact https URL (handled by url-basic-auth)", () => {
    const r = sanitizeScopeText("https://user:password@host.example/path");
    // exactly one [REDACTED], from url-basic-auth not conn-string-with-pwd
    expect(r.sanitized).toBe("https://user:[REDACTED]@host.example/path");
    expect(r.rulesHit).toContain("url-basic-auth");
    expect(r.rulesHit).not.toContain("conn-string-with-pwd");
    expect(r.redactedCount).toBe(1);
  });

  it("leaves connection string without password untouched", () => {
    const r = sanitizeScopeText("postgres://host.example:5432/db");
    expect(r.sanitized).toBe("postgres://host.example:5432/db");
    expect(r.redactedCount).toBe(0);
  });
});

describe("sanitizeScopeTextSimple — convenience wrapper", () => {
  it("returns only the sanitized string", () => {
    const out = sanitizeScopeTextSimple("password:foo123");
    expect(out).toBe("password: [REDACTED]");
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeScopeTextSimple("")).toBe("");
  });

  it("preserves prose unchanged", () => {
    const prose = "Scope: scan https://example.com login flow.";
    expect(sanitizeScopeTextSimple(prose)).toBe(prose);
  });
});
