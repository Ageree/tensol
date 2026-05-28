/**
 * Tests for `github/webhook.ts` — `classifyWebhook(eventName, payload)`.
 *
 * One test per routing branch:
 *   - pull_request opened / reopened / ready_for_review → pr_opened
 *   - pull_request synchronize                          → pr_synchronize
 *   - pull_request opened on a DRAFT                     → ignored (draft skip)
 *   - pull_request closed / labeled                      → ignored
 *   - issue_comment "@tensol review" by human            → review_requested
 *   - issue_comment "/tensol review" (case-insensitive)  → review_requested
 *   - issue_comment by a Bot user                        → ignored (loop guard)
 *   - issue_comment on a plain issue (no pull_request)   → ignored
 *   - issue_comment without the trigger phrase           → ignored
 *   - any other event name                               → ignored
 *
 * Payloads are validated through `GithubWebhookSchema` so the fixtures match
 * the real wire shape the boundary parser accepts.
 */
import { describe, expect, test } from "bun:test";

import { GithubWebhookSchema } from "../schemas.ts";
import { classifyWebhook } from "./webhook.ts";

function parse(raw: unknown) {
  return GithubWebhookSchema.parse(raw);
}

function prPayload(opts: {
  action: string;
  draft?: boolean;
}) {
  return parse({
    action: opts.action,
    installation: { id: 42 },
    repository: { full_name: "acme/widgets" },
    pull_request: {
      number: 7,
      draft: opts.draft ?? false,
      head: { sha: "headsha123" },
      base: { sha: "basesha456" },
      user: { login: "alice", type: "User" },
    },
  });
}

function commentPayload(opts: {
  body: string;
  isPr?: boolean;
  userType?: string;
  action?: string;
}) {
  return parse({
    action: opts.action ?? "created",
    installation: { id: 42 },
    repository: { full_name: "acme/widgets" },
    issue: {
      number: 9,
      ...(opts.isPr === false ? {} : { pull_request: { url: "x" } }),
    },
    comment: {
      body: opts.body,
      user: { login: "bob", type: opts.userType ?? "User" },
    },
  });
}

describe("classifyWebhook — pull_request", () => {
  test.each(["opened", "reopened", "ready_for_review"])(
    "action %s → pr_opened with extracted fields",
    (action) => {
      const ev = classifyWebhook("pull_request", prPayload({ action }));
      expect(ev.kind).toBe("pr_opened");
      expect(ev.repoFullName).toBe("acme/widgets");
      expect(ev.prNumber).toBe(7);
      expect(ev.headSha).toBe("headsha123");
      expect(ev.baseSha).toBe("basesha456");
      expect(ev.installationId).toBe("42");
    },
  );

  test("action synchronize → pr_synchronize", () => {
    const ev = classifyWebhook("pull_request", prPayload({ action: "synchronize" }));
    expect(ev.kind).toBe("pr_synchronize");
    expect(ev.prNumber).toBe(7);
    expect(ev.headSha).toBe("headsha123");
  });

  test("draft opened → ignored with a reason", () => {
    const ev = classifyWebhook("pull_request", prPayload({ action: "opened", draft: true }));
    expect(ev.kind).toBe("ignored");
    expect(ev.reason).toBeDefined();
  });

  test("draft ready_for_review → pr_opened (draft becoming ready)", () => {
    const ev = classifyWebhook(
      "pull_request",
      prPayload({ action: "ready_for_review", draft: true }),
    );
    expect(ev.kind).toBe("pr_opened");
  });

  test("unhandled action closed → ignored", () => {
    const ev = classifyWebhook("pull_request", prPayload({ action: "closed" }));
    expect(ev.kind).toBe("ignored");
  });

  test("unhandled action labeled → ignored", () => {
    const ev = classifyWebhook("pull_request", prPayload({ action: "labeled" }));
    expect(ev.kind).toBe("ignored");
  });
});

describe("classifyWebhook — issue_comment", () => {
  test("@tensol review by a human → review_requested", () => {
    const ev = classifyWebhook(
      "issue_comment",
      commentPayload({ body: "please @tensol review this" }),
    );
    expect(ev.kind).toBe("review_requested");
    expect(ev.prNumber).toBe(9);
    expect(ev.repoFullName).toBe("acme/widgets");
    expect(ev.installationId).toBe("42");
  });

  test("/tensol review uppercase is matched case-insensitively", () => {
    const ev = classifyWebhook(
      "issue_comment",
      commentPayload({ body: "/TENSOL REVIEW" }),
    );
    expect(ev.kind).toBe("review_requested");
  });

  test("comment by a Bot user → ignored (loop guard)", () => {
    const ev = classifyWebhook(
      "issue_comment",
      commentPayload({ body: "@tensol review", userType: "Bot" }),
    );
    expect(ev.kind).toBe("ignored");
    expect(ev.reason).toBeDefined();
  });

  test("comment on a plain issue (no pull_request) → ignored", () => {
    const ev = classifyWebhook(
      "issue_comment",
      commentPayload({ body: "@tensol review", isPr: false }),
    );
    expect(ev.kind).toBe("ignored");
  });

  test("comment without the trigger phrase → ignored", () => {
    const ev = classifyWebhook(
      "issue_comment",
      commentPayload({ body: "looks good to me" }),
    );
    expect(ev.kind).toBe("ignored");
  });

  test("non-created comment action → ignored", () => {
    const ev = classifyWebhook(
      "issue_comment",
      commentPayload({ body: "@tensol review", action: "edited" }),
    );
    expect(ev.kind).toBe("ignored");
  });
});

describe("classifyWebhook — other events", () => {
  test("unknown event name → ignored", () => {
    const ev = classifyWebhook("push", parse({ action: "n/a" }));
    expect(ev.kind).toBe("ignored");
  });

  test("ping → ignored", () => {
    const ev = classifyWebhook("ping", parse({}));
    expect(ev.kind).toBe("ignored");
  });
});
