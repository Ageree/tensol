export type SemanticActionKind = 'act' | 'observe' | 'extract';

export interface ActInput {
  readonly action: 'click' | 'fill' | 'navigate';
  readonly selector?: string;
  readonly value?: string;
}

export interface ObservedElement {
  readonly selector: string;
  readonly text: string;
  readonly role?: string;
}

export interface ObserveResult {
  readonly elements: ReadonlyArray<ObservedElement>;
  readonly url: string;
}

export interface ExtractResult {
  readonly data: Record<string, unknown>;
  readonly url: string;
}

export interface BrowserDriverFacade {
  act(page: unknown, input: ActInput): Promise<void>;
  observe(page: unknown): Promise<ObserveResult>;
  extract(page: unknown, schema: { parse: (data: unknown) => unknown }): Promise<ExtractResult>;
}
