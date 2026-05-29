/**
 * Tests for `github/webhook.ts` — `classifyWebhook(eventName, payload)`.
 *
 * One test per routing branch:
 *   - pull_request opened / reopened / ready_for_review → pr_opened
 *   - pull_request synchronize                          → pr_synchronize
 *   - pull_request opened on a DRAFT                     → ignored (draft skip)
 *   - pull_request closed / labeled                      → ignored
 *   - issue_comment "@tensol review" by human            → review_requested
 *   - issue_comment "@sthrip review" by human            → review_requested (rebrand)
 *   - issue_comment "/tensol review" (case-insensitive)  → review_requested
 *   - issue_comment "/sthrip review" (case-insensitive)  → review_requested (rebrand)
 *   - issue_comment by a Bot user                        → ignored (loop guard)
 *   - issue_comment on a plain issue (no pull_request)   → ignored
 *   - issue_comment without the trigger phrase           → ignored
 *   - any other event name                               → ignored
 *   - installation created/deleted/suspend/unsuspend     → installation_* kinds
 *   - installation_repositories added/removed            → installation_repos_* kinds
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

// ---------------------------------------------------------------------------
// Sthrip rebranded command trigger
// ---------------------------------------------------------------------------

describe("classifyWebhook — pull_request baseRef extraction (T023)", () => {
  test("pull_request opened carries baseRef when base.ref is present in payload", () => {
    const payload = GithubWebhookSchema.parse({
      action: "opened",
      installation: { id: 42 },
      repository: { full_name: "acme/widgets" },
      pull_request: {
        number: 7,
        draft: false,
        head: { sha: "headsha123" },
        base: { sha: "basesha456", ref: "main" },
        user: { login: "alice", type: "User" },
      },
    });
    const ev = classifyWebhook("pull_request", payload);
    expect(ev.kind).toBe("pr_opened");
    expect(ev.baseRef).toBe("main");
  });

  test("pull_request without base.ref has baseRef undefined", () => {
    const payload = GithubWebhookSchema.parse({
      action: "opened",
      installation: { id: 42 },
      repository: { full_name: "acme/widgets" },
      pull_request: {
        number: 7,
        draft: false,
        head: { sha: "headsha123" },
        base: { sha: "basesha456" },
        user: { login: "alice", type: "User" },
      },
    });
    const ev = classifyWebhook("pull_request", payload);
    expect(ev.kind).toBe("pr_opened");
    expect(ev.baseRef).toBeUndefined();
  });
});

describe("classifyWebhook — @sthrip / /sthrip review trigger (rebrand)", () => {
  test("@sthrip review by a human → review_requested", () => {
    const ev = classifyWebhook(
      "issue_comment",
      commentPayload({ body: "please @sthrip review this" }),
    );
    expect(ev.kind).toBe("review_requested");
    expect(ev.prNumber).toBe(9);
    expect(ev.repoFullName).toBe("acme/widgets");
    expect(ev.installationId).toBe("42");
  });

  test("/sthrip review → review_requested (case-insensitive)", () => {
    const ev = classifyWebhook(
      "issue_comment",
      commentPayload({ body: "/STHRIP REVIEW" }),
    );
    expect(ev.kind).toBe("review_requested");
  });

  test("@tensol review still works (back-compat)", () => {
    const ev = classifyWebhook(
      "issue_comment",
      commentPayload({ body: "@tensol review this PR" }),
    );
    expect(ev.kind).toBe("review_requested");
  });

  test("/tensol review still works (back-compat)", () => {
    const ev = classifyWebhook(
      "issue_comment",
      commentPayload({ body: "/tensol review" }),
    );
    expect(ev.kind).toBe("review_requested");
  });
});

// ---------------------------------------------------------------------------
// installation events
// ---------------------------------------------------------------------------

function installationPayload(opts: {
  action: string;
  installationId?: number;
  accountLogin?: string;
  accountType?: string;
  repositorySelection?: string;
  repositories?: Array<{ id: number; full_name: string; name: string; private: boolean }>;
}) {
  return parse({
    action: opts.action,
    installation: {
      id: opts.installationId ?? 1001,
      account: {
        login: opts.accountLogin ?? "acme-org",
        type: opts.accountType ?? "Organization",
      },
      repository_selection: opts.repositorySelection ?? "all",
      ...(opts.repositories !== undefined ? { repositories: opts.repositories } : {}),
    },
  });
}

function installationReposPayload(opts: {
  action: "added" | "removed";
  installationId?: number;
  repositoriesAdded?: Array<{ id: number; full_name: string; name: string; private: boolean }>;
  repositoriesRemoved?: Array<{ id: number; full_name: string; name: string; private: boolean }>;
}) {
  return parse({
    action: opts.action,
    installation: { id: opts.installationId ?? 1001 },
    repositories_added: opts.repositoriesAdded ?? [],
    repositories_removed: opts.repositoriesRemoved ?? [],
  });
}

describe("classifyWebhook — installation events", () => {
  test("installation created → installation_created with required fields", () => {
    const ev = classifyWebhook(
      "installation",
      installationPayload({
        action: "created",
        installationId: 555,
        accountLogin: "my-org",
        accountType: "Organization",
        repositorySelection: "all",
        repositories: [
          { id: 1, full_name: "my-org/repo-a", name: "repo-a", private: false },
          { id: 2, full_name: "my-org/repo-b", name: "repo-b", private: true },
        ],
      }),
    );
    expect(ev.kind).toBe("installation_created");
    expect(ev.installationId).toBe("555");
    expect(ev.accountLogin).toBe("my-org");
    expect(ev.accountType).toBe("Organization");
    expect(ev.repositorySelection).toBe("all");
    expect(ev.repositories).toHaveLength(2);
    expect(ev.repositories?.[0]).toBe("my-org/repo-a");
    expect(ev.repositories?.[1]).toBe("my-org/repo-b");
  });

  test("installation deleted → installation_deleted", () => {
    const ev = classifyWebhook(
      "installation",
      installationPayload({ action: "deleted", installationId: 777 }),
    );
    expect(ev.kind).toBe("installation_deleted");
    expect(ev.installationId).toBe("777");
    expect(ev.accountLogin).toBe("acme-org");
  });

  test("installation suspend → installation_suspend", () => {
    const ev = classifyWebhook(
      "installation",
      installationPayload({ action: "suspend", installationId: 888 }),
    );
    expect(ev.kind).toBe("installation_suspend");
    expect(ev.installationId).toBe("888");
  });

  test("installation unsuspend → installation_unsuspend", () => {
    const ev = classifyWebhook(
      "installation",
      installationPayload({ action: "unsuspend", installationId: 999 }),
    );
    expect(ev.kind).toBe("installation_unsuspend");
    expect(ev.installationId).toBe("999");
  });

  test("installation unhandled action → ignored", () => {
    const ev = classifyWebhook(
      "installation",
      installationPayload({ action: "new_permissions_accepted" }),
    );
    expect(ev.kind).toBe("ignored");
    expect(ev.reason).toBeDefined();
  });

  test("installation created without account → ignored gracefully", () => {
    // account is missing → can't extract required accountLogin; emit ignored
    const ev = classifyWebhook(
      "installation",
      parse({ action: "created", installation: { id: 12 } }),
    );
    expect(ev.kind).toBe("ignored");
    expect(ev.reason).toBeDefined();
  });

  test("installation without installation field → ignored", () => {
    const ev = classifyWebhook("installation", parse({ action: "created" }));
    expect(ev.kind).toBe("ignored");
    expect(ev.reason).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// installation_repositories events
// ---------------------------------------------------------------------------

describe("classifyWebhook — installation_repositories events", () => {
  test("installation_repositories added → installation_repos_added with slugs", () => {
    const ev = classifyWebhook(
      "installation_repositories",
      installationReposPayload({
        action: "added",
        installationId: 1001,
        repositoriesAdded: [
          { id: 10, full_name: "acme/backend", name: "backend", private: false },
          { id: 11, full_name: "acme/frontend", name: "frontend", private: true },
        ],
        repositoriesRemoved: [],
      }),
    );
    expect(ev.kind).toBe("installation_repos_added");
    expect(ev.installationId).toBe("1001");
    expect(ev.repositories).toHaveLength(2);
    expect(ev.repositories).toContain("acme/backend");
    expect(ev.repositories).toContain("acme/frontend");
  });

  test("installation_repositories removed → installation_repos_removed with slugs", () => {
    const ev = classifyWebhook(
      "installation_repositories",
      installationReposPayload({
        action: "removed",
        installationId: 2002,
        repositoriesAdded: [],
        repositoriesRemoved: [
          { id: 20, full_name: "acme/old-service", name: "old-service", private: false },
        ],
      }),
    );
    expect(ev.kind).toBe("installation_repos_removed");
    expect(ev.installationId).toBe("2002");
    expect(ev.repositories).toHaveLength(1);
    expect(ev.repositories?.[0]).toBe("acme/old-service");
  });

  test("installation_repositories unhandled action → ignored", () => {
    const ev = classifyWebhook(
      "installation_repositories",
      parse({ action: "unknown", installation: { id: 1 } }),
    );
    expect(ev.kind).toBe("ignored");
    expect(ev.reason).toBeDefined();
  });

  test("installation_repositories missing installation field → ignored", () => {
    const ev = classifyWebhook(
      "installation_repositories",
      parse({ action: "added" }),
    );
    expect(ev.kind).toBe("ignored");
    expect(ev.reason).toBeDefined();
  });
});
