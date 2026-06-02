/**
 * Installations CRUD + Wave-2 repo-settings methods for the review service.
 *
 * Extracted from service.ts (Wave 3 refactor) to keep file sizes under 800
 * lines (Constitution VI). Re-exported from service.ts as a thin barrel —
 * consumers see the same surface; only the physical file changed.
 *
 * Owns: upsertInstallation, getInstallationByGithubId, getInstallationsForUser,
 *       markInstallationDeleted, setInstallationStatus, getInstallationByRowId,
 *       updateRepoSettings, reconcileInstallationRepos, setReposEnabledBySlugs.
 *
 * Arg interfaces are intentionally re-declared here (structural equivalence)
 * to avoid a circular import with service.ts.
 */
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "../db/client.ts";
import {
  installations as installationsTable,
  reviewRepos as reviewReposTable,
  type Installation,
  type ReviewRepo,
} from "../db/schema.ts";
import { ulid } from "../lib/ids.ts";

// ---------------------------------------------------------------------------
// Arg-type aliases (structural duplicates of those in service.ts to avoid
// circular imports; TypeScript's structural typing makes them compatible).
// ---------------------------------------------------------------------------

export interface UpsertInstallationArgs {
  readonly userId: string;
  readonly scm?: string;
  readonly installationId: string;
  readonly accountLogin: string;
  readonly accountType: "User" | "Organization";
  readonly repositorySelection: "all" | "selected";
  readonly status?: "active" | "suspended" | "deleted";
  readonly setupAction?: string | null;
}

export interface UpdateRepoSettingsArgs {
  readonly repoId: string;
  readonly userId: string;
  readonly enabled?: boolean;
  readonly coveredBranches?: string[];
  readonly statusCheckEnabled?: boolean;
  readonly mergeBlockOnCritical?: boolean;
}

export interface ReconcileInstallationReposArgs {
  readonly installationRowId: string;
  readonly installationId: string;
  readonly userId: string;
  readonly selection: "all" | "selected";
  readonly repos: ReadonlyArray<{
    readonly owner: string;
    readonly name: string;
    readonly defaultBranch?: string;
  }>;
}

export interface SetReposEnabledBySlugsArgs {
  readonly installationId: string;
  readonly userId: string;
  readonly slugs: string[];
  readonly enabled: boolean;
}

export interface UpsertRepoArgs {
  readonly userId: string;
  readonly scm?: "github" | "gitlab" | "bitbucket";
  readonly owner: string;
  readonly name: string;
  readonly installationId?: string | null;
  readonly defaultBranch?: string;
  readonly coveredBranches?: string[];
  readonly rulesMd?: string | null;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface InstallationMethods {
  upsertInstallation(args: UpsertInstallationArgs): Promise<Installation>;
  getInstallationByGithubId(
    scm: string,
    installationId: string,
  ): Promise<Installation | null>;
  getInstallationsForUser(userId: string): Promise<Installation[]>;
  markInstallationDeleted(installationId: string): Promise<void>;
  setInstallationStatus(
    installationId: string,
    status: "active" | "suspended",
  ): Promise<Installation>;
  getInstallationByRowId(id: string): Promise<Installation | null>;
  updateRepoSettings(
    args: UpdateRepoSettingsArgs,
  ): Promise<ReviewRepo | null>;
  reconcileInstallationRepos(
    args: ReconcileInstallationReposArgs,
    upsertRepo: (args: UpsertRepoArgs) => Promise<ReviewRepo>,
  ): Promise<void>;
  setReposEnabledBySlugs(args: SetReposEnabledBySlugsArgs): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInstallationMethods(
  db: DB,
  clock: () => number,
  emit: (
    event: string,
    outcome: "success" | "failure" | "rejected",
    metadata: Record<string, unknown>,
    userId?: string | null,
  ) => Promise<void>,
): InstallationMethods {
  return {
    async upsertInstallation(args) {
      const scm = args.scm ?? "github";
      const ts = clock();

      const existing = db
        .select()
        .from(installationsTable)
        .where(
          and(
            eq(installationsTable.scm, scm),
            eq(installationsTable.installationId, args.installationId),
          ),
        )
        .get();

      if (existing) {
        db.update(installationsTable)
          .set({
            accountLogin: args.accountLogin,
            accountType: args.accountType,
            repositorySelection: args.repositorySelection,
            ...(args.status !== undefined ? { status: args.status } : {}),
            ...(args.setupAction !== undefined
              ? { setupAction: args.setupAction }
              : {}),
            updatedAt: ts,
          })
          .where(eq(installationsTable.id, existing.id))
          .run();
        const updated = db
          .select()
          .from(installationsTable)
          .where(eq(installationsTable.id, existing.id))
          .get();
        return updated as Installation;
      }

      const id = ulid(ts);
      const row = {
        id,
        userId: args.userId,
        scm,
        installationId: args.installationId,
        accountLogin: args.accountLogin,
        accountType: args.accountType,
        repositorySelection: args.repositorySelection,
        status: (args.status ?? "active") as "active" | "suspended" | "deleted",
        ...(args.setupAction !== undefined
          ? { setupAction: args.setupAction }
          : { setupAction: null }),
        createdAt: ts,
        updatedAt: ts,
      };
      db.insert(installationsTable).values(row).run();

      await emit(
        "github_app_installed",
        "success",
        {
          installation_id: args.installationId,
          scm,
          account_login: args.accountLogin,
          account_type: args.accountType,
        },
        args.userId,
      );

      return row as Installation;
    },

    async getInstallationByGithubId(scm, installationId) {
      const row = db
        .select()
        .from(installationsTable)
        .where(
          and(
            eq(installationsTable.scm, scm),
            eq(installationsTable.installationId, installationId),
          ),
        )
        .get();
      return (row as Installation) ?? null;
    },

    async getInstallationsForUser(userId) {
      return db
        .select()
        .from(installationsTable)
        .where(eq(installationsTable.userId, userId))
        .orderBy(desc(installationsTable.createdAt))
        .all() as Installation[];
    },

    async markInstallationDeleted(installationId) {
      const ts = clock();

      const existing = db
        .select()
        .from(installationsTable)
        .where(eq(installationsTable.installationId, installationId))
        .get();
      if (!existing) return;

      db.update(reviewReposTable)
        .set({ enabled: 0, updatedAt: ts })
        .where(eq(reviewReposTable.installationRowId, existing.id))
        .run();

      db.update(installationsTable)
        .set({ status: "deleted", updatedAt: ts })
        .where(eq(installationsTable.id, existing.id))
        .run();

      await emit(
        "github_app_uninstalled",
        "success",
        {
          installation_id: installationId,
          scm: existing.scm,
          account_login: existing.accountLogin,
        },
        existing.userId,
      );
    },

    async setInstallationStatus(installationId, status) {
      const ts = clock();

      const existing = db
        .select()
        .from(installationsTable)
        .where(eq(installationsTable.installationId, installationId))
        .get();
      if (!existing) {
        throw new Error(
          `setInstallationStatus: installation not found (id=${installationId})`,
        );
      }

      db.update(installationsTable)
        .set({ status, updatedAt: ts })
        .where(eq(installationsTable.id, existing.id))
        .run();

      const updated = db
        .select()
        .from(installationsTable)
        .where(eq(installationsTable.id, existing.id))
        .get() as Installation;

      if (status === "suspended") {
        await emit(
          "github_app_suspended",
          "success",
          {
            installation_id: installationId,
            scm: existing.scm,
            account_login: existing.accountLogin,
          },
          existing.userId,
        );
      }

      return updated;
    },

    async getInstallationByRowId(id) {
      const row = db
        .select()
        .from(installationsTable)
        .where(eq(installationsTable.id, id))
        .get();
      return (row as Installation) ?? null;
    },

    async updateRepoSettings(args) {
      const ts = clock();

      const existing = db
        .select()
        .from(reviewReposTable)
        .where(eq(reviewReposTable.id, args.repoId))
        .get();

      if (!existing) return null;
      if (existing.userId !== args.userId) return null;

      const patch: Record<string, unknown> = { updatedAt: ts };

      let enabledFlipped: boolean | undefined;
      if (args.enabled !== undefined) {
        const newEnabled = args.enabled ? 1 : 0;
        if (newEnabled !== existing.enabled) {
          enabledFlipped = args.enabled;
        }
        patch.enabled = newEnabled;
      }

      if (args.coveredBranches !== undefined) {
        patch.coveredBranchesJson = JSON.stringify(args.coveredBranches);
      }

      if (args.statusCheckEnabled !== undefined) {
        patch.statusCheckEnabled = args.statusCheckEnabled ? 1 : 0;
      }

      if (args.mergeBlockOnCritical !== undefined) {
        patch.mergeBlockOnCritical = args.mergeBlockOnCritical ? 1 : 0;
      }

      db.update(reviewReposTable)
        .set(patch)
        .where(eq(reviewReposTable.id, args.repoId))
        .run();

      const updated = db
        .select()
        .from(reviewReposTable)
        .where(eq(reviewReposTable.id, args.repoId))
        .get() as ReviewRepo;

      if (enabledFlipped === true) {
        await emit(
          "review_repo_enabled",
          "success",
          { repo_id: args.repoId, owner: existing.owner, name: existing.name },
          args.userId,
        );
      } else if (enabledFlipped === false) {
        await emit(
          "review_repo_disabled",
          "success",
          { repo_id: args.repoId, owner: existing.owner, name: existing.name },
          args.userId,
        );
      }

      const hasOtherChanges =
        args.coveredBranches !== undefined ||
        args.statusCheckEnabled !== undefined ||
        args.mergeBlockOnCritical !== undefined;

      if (hasOtherChanges) {
        await emit(
          "review_settings_changed",
          "success",
          {
            repo_id: args.repoId,
            owner: existing.owner,
            name: existing.name,
            ...(args.coveredBranches !== undefined
              ? { covered_branches: args.coveredBranches }
              : {}),
            ...(args.statusCheckEnabled !== undefined
              ? { status_check_enabled: args.statusCheckEnabled }
              : {}),
            ...(args.mergeBlockOnCritical !== undefined
              ? { merge_block_on_critical: args.mergeBlockOnCritical }
              : {}),
          },
          args.userId,
        );
      }

      return updated;
    },

    async reconcileInstallationRepos(args, upsertRepo) {
      for (const repo of args.repos) {
        const upserted = await upsertRepo({
          userId: args.userId,
          scm: "github",
          owner: repo.owner,
          name: repo.name,
          installationId: args.installationId,
          ...(repo.defaultBranch !== undefined
            ? { defaultBranch: repo.defaultBranch }
            : {}),
        });

        const ts = clock();
        db.update(reviewReposTable)
          .set({
            installationRowId: args.installationRowId,
            enabled: 1,
            updatedAt: ts,
          })
          .where(eq(reviewReposTable.id, upserted.id))
          .run();
      }
    },

    async setReposEnabledBySlugs(args) {
      if (args.slugs.length === 0) return;

      const ts = clock();
      const enabledVal = args.enabled ? 1 : 0;

      const instRow = db
        .select()
        .from(installationsTable)
        .where(
          and(
            eq(installationsTable.installationId, args.installationId),
            eq(installationsTable.userId, args.userId),
          ),
        )
        .get();

      if (!instRow) return;

      for (const slug of args.slugs) {
        const slashIdx = slug.indexOf("/");
        if (slashIdx === -1) continue;
        const owner = slug.slice(0, slashIdx);
        const name = slug.slice(slashIdx + 1);

        db.update(reviewReposTable)
          .set({ enabled: enabledVal, updatedAt: ts })
          .where(
            and(
              eq(reviewReposTable.installationRowId, instRow.id),
              eq(reviewReposTable.owner, owner),
              eq(reviewReposTable.name, name),
              eq(reviewReposTable.userId, args.userId),
            ),
          )
          .run();
      }
    },
  };
}
