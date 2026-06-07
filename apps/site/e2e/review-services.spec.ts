import { test, expect, request as pwRequest } from '@playwright/test';
import {
  attachSessionCookie,
  BACKEND_BASE_URL,
  E2E_GITHUB_WEBHOOK_SECRET,
  FRONTEND_BASE_URL,
  pollUntil,
  seedReviewRepo,
  seedSession,
  signGitHubWebhookBody,
} from './helpers/scan-wizard-helpers.ts';

test.describe('review services dashboard flow', () => {
  test.setTimeout(90_000);

  test('repositories → whitebox launch → PR webhook trigger', async ({
    page,
    context,
  }) => {
    const backend = await pwRequest.newContext({ baseURL: BACKEND_BASE_URL });
    let authedBackend: Awaited<ReturnType<typeof pwRequest.newContext>> | null = null;

    try {
      const seed = await seedSession(
        backend,
        `e2e+review+${Date.now()}@example.test`,
      );
      await attachSessionCookie(context, seed.session_id, FRONTEND_BASE_URL);
      authedBackend = await pwRequest.newContext({
        baseURL: BACKEND_BASE_URL,
        extraHTTPHeaders: { Cookie: `tensol_session=${seed.session_id}` },
      });

      const owner = 'octo-org';
      const name = 'juice-shop';
      const installationId = String(Date.now() % 1_000_000_000);
      const repo = await seedReviewRepo(backend, {
        userId: seed.user_id,
        owner,
        name,
        installationId,
        enabled: false,
        coveredBranches: ['main'],
        statusCheckEnabled: false,
        mergeBlockOnCritical: false,
      });

      await page.goto('/dashboard');
      await expect(page.getByRole('link', { name: 'Blackbox' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'PR reviews' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Whitebox' })).toBeVisible();

      await page.goto('/repositories');
      const repoRow = page.locator('tr', { hasText: `${owner}/${name}` });
      await expect(repoRow).toBeVisible({ timeout: 15_000 });

      await repoRow.getByRole('switch').last().click();
      await expect(repoRow).toContainText('Enabled', { timeout: 10_000 });

      await page.goto('/reviews');
      await expect(page.locator('body')).toContainText(`${owner}/${name}`, {
        timeout: 15_000,
      });
      await page.locator('button:has-text("Run scan")').click();
      await page.waitForURL(/\/reviews\/[0-9A-HJKMNP-TV-Z]{26}$/i, {
        timeout: 15_000,
      });
      await expect(page.locator('body')).toContainText(/completed/i, {
        timeout: 20_000,
      });
      await expect(page.locator('body')).toContainText(
        'E2E fixture review completed without findings.',
      );

      const webhookBody = JSON.stringify({
        action: 'opened',
        installation: { id: Number(installationId) },
        repository: {
          full_name: `${owner}/${name}`,
          name,
          owner: { login: owner },
          default_branch: 'main',
        },
        pull_request: {
          number: 17,
          head: { sha: 'e2e-head-sha' },
          base: { sha: 'e2e-base-sha', ref: 'main' },
          draft: false,
        },
      });

      const webhookRes = await backend.post('/v1/review/github/webhook', {
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': `delivery-${Date.now()}`,
          'x-hub-signature-256': signGitHubWebhookBody(
            E2E_GITHUB_WEBHOOK_SECRET,
            webhookBody,
          ),
        },
        data: webhookBody,
      });
      expect(webhookRes.status()).toBe(202);
      const webhookJson = (await webhookRes.json()) as {
        status: string;
        review_id?: string;
        job_id?: string;
      };
      expect(webhookJson.status).toBe('queued');
      expect(webhookJson.review_id).toBeTruthy();
      expect(webhookJson.job_id).toBeTruthy();

      const prReview = await pollUntil(
        async () => {
          const res = await authedBackend!.get(`/v1/review/${webhookJson.review_id}`);
          expect(res.ok()).toBe(true);
          const json = (await res.json()) as {
            kind: string;
            status: string;
            pr_number?: number;
            summary_md?: string | null;
          };
          return json.status === 'completed' ? json : undefined;
        },
        { intervalMs: 500, timeoutMs: 20_000, label: 'pr-review-completed' },
      );
      expect(prReview.kind).toBe('pr');
      expect(prReview.pr_number).toBe(17);
      expect(prReview.summary_md).toBe(
        'E2E fixture review completed without findings.',
      );

      const reposAfterReview = await authedBackend.get(
        `/v1/github/installations/${repo.installation_row_id}/repos`,
      );
      expect(reposAfterReview.ok()).toBe(true);
      const reposJson = (await reposAfterReview.json()) as Array<{
        repo_id?: string | null;
        enabled?: boolean;
        last_review?: { review_id: string; status: string } | null;
      }>;
      const updatedRepo = reposJson.find((r) => r.repo_id === repo.repo_id);
      expect(updatedRepo?.enabled).toBe(true);
      expect(updatedRepo?.last_review?.review_id).toBe(webhookJson.review_id);
      expect(updatedRepo?.last_review?.status).toBe('completed');
    } finally {
      await authedBackend?.dispose();
      await backend.dispose();
    }
  });
});
