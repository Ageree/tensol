// T079 — Step 1: Attack Surface (FR-006).
//
// Drives:
//   - Primary domain entry (validated client-side; server is canonical).
//   - In-scope subdomain list (toggle to include / exclude per request).
//   - Up to 10 global request headers attached to every probe.
//
// Committed via PUT /v1/scan-orders/:id/attack-surface (T077 api-client)
// when the container advances. The step exposes a `commit()` helper through
// the props surface so the container's single "Next" button drives both
// validation and the API write before navigating to step 2.
//
// Constitution VII: ≤ 800 LOC. Constitution IX: client validates loosely;
// the server-side Zod (AttackSurfaceEntrySchema) is the source of truth.

import { useMemo, useState, type CSSProperties, type ReactElement } from 'react';
import { Btn, Field, Input, Mono } from '../../components/primitives.tsx';
import { TENSOL_I18N } from '../../i18n.ts';
import type { AttackSurfaceHeader } from '../../lib/api-client.ts';
import type { ScanWizardStateApi } from './useScanWizardState.ts';

export interface Step1AttackSurfaceProps {
  readonly api: ScanWizardStateApi;
}

/**
 * Lowercase RFC 1035 hostname check — mirrors the server-side regex in
 * `server/src/schemas/scan-orders.ts` (`HostnameSchema`). Loose enough to
 * be friendly; server returns 422 on the strict pattern + length.
 */
const HOSTNAME_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function isValidHostname(value: string): boolean {
  if (!value) return false;
  if (value.length > 253) return false;
  return HOSTNAME_RE.test(value);
}

const ROW_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr auto',
  gap: 8,
  alignItems: 'center',
};

const SUBROW_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr auto',
  gap: 8,
  alignItems: 'center',
};

const SECTION_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const PAGE_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 24,
  padding: 24,
  maxWidth: 760,
};

const MAX_HEADERS = 10 as const;

export const Step1AttackSurface = ({
  api,
}: Step1AttackSurfaceProps): ReactElement => {
  const t = TENSOL_I18N.en;
  const { state, dispatch } = api;
  const [subdomainDraft, setSubdomainDraft] = useState('');
  const [subdomainErr, setSubdomainErr] = useState<string | null>(null);

  // ── Domain validation ──
  const domainErr = useMemo<string | null>(() => {
    if (state.domain === '') return null; // empty == not yet entered; not an error here
    return isValidHostname(state.domain) ? null : t.wizard.step1.domainErrInvalid;
  }, [state.domain, t.wizard.step1.domainErrInvalid]);

  const onDomainChange = (value: string): void => {
    dispatch({ type: 'setDomain', payload: value.trim().toLowerCase() });
  };

  // ── Subdomains ──
  const onAddSubdomain = (): void => {
    const candidate = subdomainDraft.trim().toLowerCase();
    if (!isValidHostname(candidate)) {
      setSubdomainErr(t.wizard.step1.subdomainErrInvalid);
      return;
    }
    if (
      state.subdomains.includes(candidate) ||
      candidate === state.domain.trim().toLowerCase()
    ) {
      setSubdomainErr(t.wizard.step1.subdomainErrDup);
      return;
    }
    dispatch({ type: 'setSubdomains', payload: [...state.subdomains, candidate] });
    setSubdomainDraft('');
    setSubdomainErr(null);
  };

  const onRemoveSubdomain = (sub: string): void => {
    dispatch({
      type: 'setSubdomains',
      payload: state.subdomains.filter((s) => s !== sub),
    });
  };

  // ── Headers ──
  const onAddHeader = (): void => {
    if (state.headers.length >= MAX_HEADERS) return;
    dispatch({ type: 'addHeader' });
  };

  const onChangeHeader = (
    index: number,
    field: 'k' | 'v',
    next: string,
  ): void => {
    const current: AttackSurfaceHeader = state.headers[index] ?? { k: '', v: '' };
    dispatch({
      type: 'setHeader',
      index,
      key: field === 'k' ? next : current.k,
      value: field === 'v' ? next : current.v,
    });
  };

  const onRemoveHeader = (index: number): void => {
    dispatch({ type: 'removeHeader', index });
  };

  return (
    <div style={PAGE_STYLE}>
      {/* ── Primary domain ────────────────────────────────────────────── */}
      <section style={SECTION_STYLE}>
        <Field
          label={t.wizard.step1.domainLabel}
          hint={t.wizard.step1.domainHint}
          error={domainErr ?? undefined}
        >
          <Input
            value={state.domain}
            placeholder="example.com"
            error={Boolean(domainErr)}
            onChange={(e) => onDomainChange(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            data-testid="wizard-step1-domain"
          />
        </Field>
      </section>

      {/* ── Subdomains ─────────────────────────────────────────────────── */}
      <section style={SECTION_STYLE}>
        <Mono
          size={11}
          color="var(--fg-2)"
          style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}
        >
          {t.wizard.step1.subdomainsLabel}
        </Mono>
        <Mono size={11} color="var(--fg-3)">
          {t.wizard.step1.subdomainsHint}
        </Mono>

        {state.subdomains.length === 0 ? (
          <Mono size={12} color="var(--fg-3)">
            {t.wizard.step1.subdomainsEmpty}
          </Mono>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {state.subdomains.map((sub) => (
              <div key={sub} style={SUBROW_STYLE}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    background: 'var(--fg)',
                    display: 'inline-block',
                  }}
                />
                <Mono size={13} color="var(--fg)">
                  {sub}
                </Mono>
                <Btn
                  kind="ghost"
                  size="sm"
                  onClick={() => onRemoveSubdomain(sub)}
                  title={t.wizard.step1.subdomainRemove}
                >
                  ×
                </Btn>
              </div>
            ))}
          </div>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            gap: 8,
            alignItems: 'center',
          }}
        >
          <Input
            value={subdomainDraft}
            placeholder={t.wizard.step1.subdomainAddPlaceholder}
            error={Boolean(subdomainErr)}
            onChange={(e) => {
              setSubdomainDraft(e.target.value);
              if (subdomainErr) setSubdomainErr(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onAddSubdomain();
              }
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            data-testid="wizard-step1-subdomain-input"
          />
          <Btn
            kind="secondary"
            size="md"
            onClick={onAddSubdomain}
            disabled={subdomainDraft.trim().length === 0}
          >
            {t.wizard.step1.subdomainAdd}
          </Btn>
        </div>
        {subdomainErr ? (
          <Mono size={11} color="var(--red)">
            {subdomainErr}
          </Mono>
        ) : null}
      </section>

      {/* ── Global headers ─────────────────────────────────────────────── */}
      <section style={SECTION_STYLE}>
        <Mono
          size={11}
          color="var(--fg-2)"
          style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}
        >
          {t.wizard.step1.headersLabel}
        </Mono>
        <Mono size={11} color="var(--fg-3)">
          {t.wizard.step1.headersHint}
        </Mono>

        {state.headers.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {state.headers.map((h, idx) => (
              <div key={idx} style={ROW_STYLE}>
                <Input
                  value={h.k}
                  placeholder={t.wizard.step1.headerKey}
                  onChange={(e) => onChangeHeader(idx, 'k', e.target.value)}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="off"
                  data-testid={`wizard-step1-header-k-${idx}`}
                />
                <Input
                  value={h.v}
                  placeholder={t.wizard.step1.headerValue}
                  onChange={(e) => onChangeHeader(idx, 'v', e.target.value)}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="off"
                  data-testid={`wizard-step1-header-v-${idx}`}
                />
                <Btn
                  kind="ghost"
                  size="sm"
                  onClick={() => onRemoveHeader(idx)}
                  title={t.wizard.step1.headerRemove}
                >
                  ×
                </Btn>
              </div>
            ))}
          </div>
        ) : null}

        <div>
          <Btn
            kind="secondary"
            size="md"
            onClick={onAddHeader}
            disabled={state.headers.length >= MAX_HEADERS}
          >
            {t.wizard.step1.headerAdd}
          </Btn>
          {state.headers.length >= MAX_HEADERS ? (
            <Mono size={11} color="var(--fg-3)" style={{ marginLeft: 12 }}>
              {t.wizard.step1.headersMax}
            </Mono>
          ) : null}
        </div>
      </section>

      {state.loading ? (
        <Mono size={11} color="var(--fg-2)">
          {t.wizard.step1.saving}
        </Mono>
      ) : null}
    </div>
  );
};

export default Step1AttackSurface;
