/**
 * PAT-backed GitHubClient for the REAL end-to-end verification.
 *
 * No GitHub App is configured locally, so we authenticate the REAL HTTP client
 * with a classic PAT (Ageree, full scopes) via an injected tokenProvider.
 * Everything the poster needs works with a PAT on a repo you own EXCEPT the
 * check-run API (App-only). We wrap createCheckRun: try the real call, and on
 * ANY failure fall back to the commit Status API (PAT-compatible) so the
 * "Sthrip N/5" gate still appears on the PR head commit.
 */
import { createHttpGitHubClient, type GitHubClient } from "../../src/review/github/client.ts";

const GITHUB_API = "https://api.github.com";
const BASE_HEADERS: Record<string, string> = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "sthrip-e2e",
};
type Conclusion = "success" | "failure" | "neutral" | "action_required";
function conclusionToState(c: Conclusion): "success" | "failure" {
  return c === "success" || c === "neutral" ? "success" : "failure";
}

export interface PatClient extends GitHubClient {
  readonly flags: { checkRunFellBackToStatus: boolean; lastStatusId?: string };
}

export function createPatGitHubClient(opts: { pat: string; fetchImpl?: typeof fetch }): PatClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const inner = createHttpGitHubClient({
    appId: "pat-mode",
    privateKeyPem: "pat-mode",
    fetchImpl,
    tokenProvider: async () => opts.pat,
  });
  const flags: { checkRunFellBackToStatus: boolean; lastStatusId?: string } = { checkRunFellBackToStatus: false };

  async function postCommitStatus(a: { owner: string; name: string; headSha: string; conclusion: Conclusion; title: string; summary: string }) {
    const url = `${GITHUB_API}/repos/${a.owner}/${a.name}/statuses/${a.headSha}`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { ...BASE_HEADERS, authorization: `Bearer ${opts.pat}`, "content-type": "application/json" },
      body: JSON.stringify({ state: conclusionToState(a.conclusion), context: a.title, description: a.summary.slice(0, 140) }),
    });
    if (!res.ok) throw new Error(`PAT fallback commit-status failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { id?: number | string };
    flags.lastStatusId = String(json.id ?? "");
    return { checkRunId: `status-${flags.lastStatusId}` };
  }

  return {
    ...inner,
    flags,
    async createCheckRun(a) {
      try {
        return await inner.createCheckRun(a);
      } catch {
        flags.checkRunFellBackToStatus = true;
        return postCommitStatus(a);
      }
    },
  };
}
