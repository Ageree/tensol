export const name = 'packages/browser-driver' as const;
export { PlaywrightBrowserDriverFacade } from './playwright-facade.ts';
export type {
  ActInput,
  BrowserDriverFacade,
  ExtractResult,
  ObserveResult,
  ObservedElement,
  SemanticActionKind,
} from './types.ts';
