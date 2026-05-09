import { TENSOL_I18N } from '../../src/i18n.ts';

function collectLeafKeys(obj: unknown, acc: string[] = []): string[] {
  if (typeof obj !== 'object' || obj === null) return acc;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    acc.push(k);
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      collectLeafKeys(v, acc);
    }
  }
  return acc;
}

export const i18nKeys: readonly string[] = Object.freeze(collectLeafKeys(TENSOL_I18N.en));

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
