import type { Kysely } from 'kysely';
import type { Database } from '../schema.ts';

export interface TargetCredentialRow {
  readonly id: string;
  readonly tenantId: string;
  readonly targetId: string;
  readonly recipeId: string;
  // Sprint 23 mig 022: recipe stored as plain text (bytea dropped).
  readonly recipeText: string;
  // Sprint 23 G shim: encryptedBlob = Buffer.from(recipeText) so targets.ts diff === 0.
  readonly encryptedBlob: Buffer;
  readonly createdBy: string;
  // Sprint 17 mig 020: cosmetic display name (set once at INSERT).
  readonly name: string;
  readonly createdAt: Date;
}

export interface InsertTargetCredentialInput {
  readonly db: Kysely<Database>;
  readonly tenantId: string;
  readonly targetId: string;
  readonly recipeId: string;
  // targets.ts passes encryptedBlob (via shim = plaintext); stored as recipe_text.
  readonly encryptedBlob: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly createdBy: string;
  readonly name?: string;
}

const mapRow = (r: {
  id: unknown;
  tenant_id: unknown;
  target_id: unknown;
  recipe_id: unknown;
  recipe_text: unknown;
  created_by: unknown;
  name: unknown;
  created_at: unknown;
}): TargetCredentialRow => {
  const recipeText = (r.recipe_text as string) ?? '';
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    targetId: r.target_id as string,
    recipeId: r.recipe_id as string,
    recipeText,
    encryptedBlob: Buffer.from(recipeText, 'utf8'),
    createdBy: r.created_by as string,
    name: (r.name as string) ?? '',
    createdAt: r.created_at as Date,
  };
};

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
      // encryptedBlob is the shim output (plaintext bytes); store as recipe_text.
      recipe_text: fields.encryptedBlob.toString('utf8'),
      created_by: fields.createdBy,
      name: fields.name ?? '',
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
