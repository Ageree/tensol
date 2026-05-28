// T078 — Reducer + state types for the 4-step Blackbox scan-order wizard.
//
// State persists across step navigation in the parent container; each step
// component reads/dispatches via the reducer surface returned by
// `useScanWizardState()`. Step content (T079-T083) drives validation +
// network calls; this hook only owns the in-memory shape.
//
// Types mirror the wire shape (snake_case) from
// specs/002-blackbox-mvp/contracts/openapi.yaml — see `apps/site/src/lib/
// api-client.ts` for the authoritative TS mirror.

import { useReducer, type Dispatch } from 'react';
import type {
  AttackSurfaceHeader,
  ScanOrder,
} from '../../lib/api-client.ts';

export type WizardStep = 1 | 2 | 3 | 4;

export interface WizardState {
  /** Server-side draft id once created (POST /v1/scan-orders → 201). */
  orderId: string | null;
  /** Currently rendered step. URL is source of truth; state mirrors it. */
  step: WizardStep;
  /** Primary domain bound at creation; immutable in subsequent steps. */
  domain: string;
  /** Subdomains the user opted IN to (subset of candidates). */
  subdomains: string[];
  /** Candidates surfaced by recon/probe; not yet committed. */
  candidateSubdomains: string[];
  /** Global headers applied to every probe request (FR-006). */
  headers: AttackSurfaceHeader[];
  /** Safety: max requests-per-second budget (FR-007). */
  rps: number;
  /** DNS TXT verification token (FR-008). Set by step 3. */
  dnsToken: string | null;
  /** DNS verified (poll loop result). */
  dnsVerified: boolean;
  /** In-flight async (network) marker for current step. */
  loading: boolean;
  /** Last error code/message (cleared on next mutation). */
  error: string | null;
}

export const initialWizardState: WizardState = {
  orderId: null,
  step: 1,
  domain: '',
  subdomains: [],
  candidateSubdomains: [],
  headers: [],
  rps: 5,
  dnsToken: null,
  dnsVerified: false,
  loading: false,
  error: null,
};

export type WizardAction =
  | { type: 'loaded'; payload: Partial<WizardState> }
  | { type: 'setDomain'; payload: string }
  | { type: 'setSubdomains'; payload: string[] }
  | { type: 'setCandidateSubdomains'; payload: string[] }
  | { type: 'addHeader' }
  | { type: 'setHeader'; index: number; key: string; value: string }
  | { type: 'removeHeader'; index: number }
  | { type: 'setRps'; payload: number }
  | { type: 'dnsToken'; payload: string }
  | { type: 'dnsVerified' }
  | { type: 'stepTo'; payload: WizardStep }
  | { type: 'loading'; payload: boolean }
  | { type: 'error'; payload: string | null };

/**
 * Hydrate state from a server-returned ScanOrder. Used after `get(orderId)`
 * on refresh / direct-URL entry; lets the wizard resume mid-flight.
 */
export const hydrateFromOrder = (order: ScanOrder): Partial<WizardState> => {
  const surface = order.attack_surface ?? [];
  const subdomains = surface
    .filter((e) => !e.primary)
    .map((e) => e.domain);
  const primary = surface.find((e) => e.primary);
  return {
    orderId: order.id,
    domain: order.primary_domain,
    subdomains,
    headers: primary?.headers ?? [],
    rps: order.safety_rps,
    dnsToken: order.dns_verify_token ?? null,
    dnsVerified: order.dns_verified_at !== null && order.dns_verified_at !== undefined,
  };
};

export const wizardReducer = (state: WizardState, action: WizardAction): WizardState => {
  switch (action.type) {
    case 'loaded':
      return { ...state, ...action.payload, error: null };
    case 'setDomain':
      return { ...state, domain: action.payload, error: null };
    case 'setSubdomains':
      return { ...state, subdomains: action.payload };
    case 'setCandidateSubdomains':
      return { ...state, candidateSubdomains: action.payload };
    case 'addHeader':
      return { ...state, headers: [...state.headers, { k: '', v: '' }] };
    case 'setHeader': {
      const next = state.headers.map((h, i) =>
        i === action.index ? { k: action.key, v: action.value } : h,
      );
      return { ...state, headers: next };
    }
    case 'removeHeader':
      return {
        ...state,
        headers: state.headers.filter((_, i) => i !== action.index),
      };
    case 'setRps':
      return { ...state, rps: action.payload };
    case 'dnsToken':
      return { ...state, dnsToken: action.payload, dnsVerified: false };
    case 'dnsVerified':
      return { ...state, dnsVerified: true, error: null };
    case 'stepTo':
      return { ...state, step: action.payload, error: null };
    case 'loading':
      return { ...state, loading: action.payload };
    case 'error':
      return { ...state, error: action.payload, loading: false };
    default: {
      // Exhaustiveness check at compile time.
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
};

export interface ScanWizardStateApi {
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
}

/**
 * React hook surface for the wizard reducer. Keeps the
 * `useReducer(wizardReducer, initialWizardState)` call colocated so consumers
 * never hand-roll the reducer wiring.
 */
export const useScanWizardState = (
  seed: Partial<WizardState> = {},
): ScanWizardStateApi => {
  const [state, dispatch] = useReducer(wizardReducer, {
    ...initialWizardState,
    ...seed,
  });
  return { state, dispatch };
};
