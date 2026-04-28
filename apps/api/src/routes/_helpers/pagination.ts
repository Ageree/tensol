// Sprint 5 — shared cursor pagination helper.
//
// Cursor shape per Sprint 4 A14: opaque base64 of {createdAt, id}; ORDER BY
// created_at DESC, id DESC; cursor is EXCLUSIVE.
//
// Each list endpoint that uses this helper accepts `?limit=N&cursor=base64`
// and returns `{ data: T[], nextCursor: string | null }`.

export interface ListCursor {
  readonly createdAt: string;
  readonly id: string;
}

export const encodeListCursor = (cursor: ListCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64');

export const decodeListCursor = (raw: string): ListCursor | null => {
  try {
    const json = Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as Partial<ListCursor>;
    if (
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.id !== 'string' ||
      parsed.createdAt.length === 0 ||
      parsed.id.length === 0
    ) {
      return null;
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
};
