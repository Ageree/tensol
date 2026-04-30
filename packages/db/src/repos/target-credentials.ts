import type { Kysely } from 'kysely';
import type { Database } from '../schema.ts';

export interface TargetCredentialRow {
  readonly id: string;
  readonly tenantId: string;
  readonly targetId: string;
  readonly recipeId: string;
  readonly encryptedBlob: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export interface InsertTargetCredentialInput {
  readonly db: Kysely<Database>;
  readonly tenantId: string;
  readonly targetId: string;
  readonly recipeId: string;
  readonly encryptedBlob: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly createdBy: string;
}

const mapRow = (r: {
  id: unknown;
  tenant_id: unknown;
  target_id: unknown;
  recipe_id: unknown;
  encrypted_blob: unknown;
  iv: unknown;
  auth_tag: unknown;
  created_by: unknown;
  created_at: unknown;
}): TargetCredentialRow => ({
  id: r.id as string,
  tenantId: r.tenant_id as string,
  targetId: r.target_id as string,
  recipeId: r.recipe_id as string,
  encryptedBlob: r.encrypted_blob as Buffer,
  iv: r.iv as Buffer,
  authTag: r.auth_tag as Buffer,
  createdBy: r.created_by as string,
  createdAt: r.created_at as Date,
});

export const insertTargetCredential = async (
  input: InsertTargetCredentialInput,
): Promise<{ id: string }> => {
  const { db, ...fields } = input;
  const row = await db
    .insertInto('target_credentials')
    .values({
      tenant_id: fields.tenantId,
      target_id: fields.targetId,
      recipe_id: fields.recipeId,
      encrypted_blob: fields.encryptedBlob,
      iv: fields.iv,
      auth_tag: fields.authTag,
      created_by: fields.createdBy,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id };
};

export const getTargetCredential = async (
  db: Kysely<Database>,
  id: string,
  tenantId: string,
): Promise<TargetCredentialRow | null> => {
  const row = await db
    .selectFrom('target_credentials')
    .selectAll()
    .where('id', '=', id)
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
  return row ? mapRow(row) : null;
};

export const listTargetCredentials = async (
  db: Kysely<Database>,
  tenantId: string,
  targetId: string,
): Promise<ReadonlyArray<TargetCredentialRow>> => {
  const rows = await db
    .selectFrom('target_credentials')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('target_id', '=', targetId)
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map(mapRow);
};
