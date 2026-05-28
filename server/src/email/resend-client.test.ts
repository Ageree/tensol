import { describe, it, expect, mock } from "bun:test";
import { createEmailClient } from "./resend-client.ts";

describe("createEmailClient — stdout mode", () => {
  it("logs the recipient + subject + html via the injected logger", async () => {
    const lines: string[] = [];
    const client = createEmailClient({
      mode: "stdout",
      logger: (line) => lines.push(line),
    });

    const res = await client.send({
      to: "user@example.com",
      subject: "Test subject",
      html: "<p>hello</p>",
    });

    expect(res.id).toMatch(/^stdout-/);
    const joined = lines.join("\n");
    expect(joined).toContain("user@example.com");
    expect(joined).toContain("Test subject");
    expect(joined).toContain("<p>hello</p>");
  });

  it("does not require resendApiKey in stdout mode", () => {
    expect(() => createEmailClient({ mode: "stdout" })).not.toThrow();
  });

  it("returns distinct ids across calls", async () => {
    const client = createEmailClient({ mode: "stdout", logger: () => {} });
    const a = await client.send({ to: "a@b.com", subject: "s", html: "<p/>" });
    const b = await client.send({ to: "a@b.com", subject: "s", html: "<p/>" });
    expect(a.id).not.toBe(b.id);
  });
});

describe("createEmailClient — resend mode", () => {
  it("invokes the SDK with the expected payload and returns the message id", async () => {
    const send = mock(async () => ({ data: { id: "msg-123" }, error: null }));
    const factory = mock((apiKey: string) => {
      expect(apiKey).toBe("rk_test_xyz");
      return { emails: { send } };
    });

    const client = createEmailClient({
      mode: "resend",
      resendApiKey: "rk_test_xyz",
      sdkFactory: factory,
    });

    const res = await client.send({
      to: "user@example.com",
      subject: "Sign in",
      html: "<a href='https://x'>x</a>",
      text: "https://x",
    });

    expect(res.id).toBe("msg-123");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    const calls = send.mock.calls as unknown as Array<
      [
        {
          from: string;
          to: string;
          subject: string;
          html: string;
          text?: string;
        },
      ]
    >;
    const payload = calls[0]![0];
    expect(payload.to).toBe("user@example.com");
    expect(payload.subject).toBe("Sign in");
    expect(payload.html).toBe("<a href='https://x'>x</a>");
    expect(payload.text).toBe("https://x");
    expect(payload.from).toBe("Tensol <no-reply@tensol.io>");
  });

  it("forwards a custom `from` to the SDK call", async () => {
    const send = mock(async () => ({ data: { id: "msg-2" }, error: null }));
    const client = createEmailClient({
      mode: "resend",
      resendApiKey: "rk_test",
      from: "Custom <hi@example.com>",
      sdkFactory: () => ({ emails: { send } }),
    });

    await client.send({ to: "u@e.com", subject: "s", html: "<p/>" });

    const calls = send.mock.calls as unknown as Array<[{ from: string }]>;
    expect(calls[0]![0].from).toBe("Custom <hi@example.com>");
  });

  it("throws when the SDK returns an error response", async () => {
    const send = mock(async () => ({
      data: null,
      error: { name: "invalid_api_Key", message: "bad key" },
    }));
    const client = createEmailClient({
      mode: "resend",
      resendApiKey: "rk_test",
      sdkFactory: () => ({ emails: { send } }),
    });

    await expect(
      client.send({ to: "u@e.com", subject: "s", html: "<p/>" }),
    ).rejects.toThrow(/bad key|invalid_api_Key/);
  });

  it("throws on creation when resendApiKey is missing (fail-fast)", () => {
    expect(() =>
      createEmailClient({
        mode: "resend",
        sdkFactory: () => ({ emails: { send: async () => ({ data: { id: "x" }, error: null }) } }),
      }),
    ).toThrow(/RESEND_API_KEY|resendApiKey|api key/i);
  });

  it("throws on creation when resendApiKey is an empty string", () => {
    expect(() =>
      createEmailClient({
        mode: "resend",
        resendApiKey: "",
        sdkFactory: () => ({ emails: { send: async () => ({ data: { id: "x" }, error: null }) } }),
      }),
    ).toThrow(/RESEND_API_KEY|resendApiKey|api key/i);
  });

  it("instantiates the SDK exactly once across multiple sends", async () => {
    const send = mock(async () => ({ data: { id: "msg" }, error: null }));
    const factory = mock(() => ({ emails: { send } }));
    const client = createEmailClient({
      mode: "resend",
      resendApiKey: "rk_test",
      sdkFactory: factory,
    });

    await client.send({ to: "a@b.com", subject: "s", html: "<p/>" });
    await client.send({ to: "c@d.com", subject: "s", html: "<p/>" });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
