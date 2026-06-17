import {
  useAction,
  useConvexAuth,
  useQuery_experimental as useQueryState,
} from 'convex/react';
import { CreditCard, ExternalLink } from 'lucide-react';
import {
  type CSSProperties,
  type ReactElement,
  useMemo,
  useState,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import {
  DashboardButton,
  DashboardPage,
} from '../components/dashboard-ui.tsx';
import { Card, Mono, StatusChip } from '../components/primitives.tsx';
import { api } from '../lib/convex-api.ts';
import { isConvexConfigured } from '../lib/convex.ts';

interface BillingProduct {
  key: 'pr_review' | 'starter' | 'team' | 'pro';
  name: string;
  monthly_usd_cents: number;
  scan_credits: number;
  review_credits: number;
  asset_limit: number;
  concurrent_tests: number;
  description: string;
  features: string[];
}

interface BillingStatus {
  scan_credits: number;
  review_credits: number;
  checkout_sessions: Array<{
    id: string;
    product_key: string;
    product_name: string;
    status: string;
    amount_usd_cents: number;
    review_credits: number;
    provider_payment_url: string | null;
    provider_track_id: string | null;
    created_at: number;
    updated_at: number;
    paid_at: number | null;
    expires_at: number | null;
  }>;
}

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
  gap: 16,
};

function formatUsd(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function returnPath(productKey: string): string {
  return `/billing?checkout=return&product=${encodeURIComponent(productKey)}`;
}

function productAllocation(product: BillingProduct): string {
  const parts: string[] = [];
  if (product.review_credits > 0) {
    parts.push(`${product.review_credits} PR reviews`);
  }
  if (product.scan_credits > 0) {
    parts.push(`${product.scan_credits} scan credits`);
  }
  return `${parts.join(' + ')} / month`;
}

function BillingUnavailable(): ReactElement {
  return (
    <AppShell
      surface="hacktron-light"
      breadcrumb={['Dashboard', 'Billing']}
      showLanguageSwitcher={false}
    >
      <DashboardPage
        title="Billing"
        section="Billing"
        description="Billing requires Convex configuration so checkout sessions can be signed and fulfilled."
        data-screen-label="billing"
      >
        <StatusChip status="Convex unavailable" tone="warn" size="md" />
      </DashboardPage>
    </AppShell>
  );
}

export default function Billing(): ReactElement {
  const [params] = useSearchParams();
  const convexAuth = useConvexAuth();
  const requestedProduct = params.get('product');
  const returnedFromCheckout = params.get('checkout') === 'return';
  const productsState = useQueryState({
    query: api.billing.listProducts,
    args: isConvexConfigured ? {} : 'skip',
  });
  const statusState = useQueryState({
    query: api.billing.myBillingStatus,
    args: isConvexConfigured && convexAuth.isAuthenticated ? {} : 'skip',
  });
  const createCheckout = useAction(api.billing.createCheckout);
  const [busyProduct, setBusyProduct] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  const products = useMemo<BillingProduct[]>(
    () =>
      productsState.status === 'success'
        ? (productsState.data as BillingProduct[])
        : [],
    [productsState],
  );
  const billingStatus =
    statusState.status === 'success'
      ? (statusState.data as BillingStatus)
      : null;

  if (!isConvexConfigured) return <BillingUnavailable />;

  const startCheckout = async (product: BillingProduct): Promise<void> => {
    setBusyProduct(product.key);
    setCheckoutError(null);
    try {
      const result = await createCheckout({
        product_key: product.key,
        return_path: returnPath(product.key),
      });
      window.location.assign(result.payment_url);
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : 'checkout_failed');
      setBusyProduct(null);
    }
  };

  return (
    <>
      <RouteHead
        title="Billing - Sthrip"
        description="Buy Sthrip subscriptions through OxaPay hosted checkout."
      />
      <AppShell
        surface="hacktron-light"
        breadcrumb={['Dashboard', 'Billing']}
        showLanguageSwitcher={false}
      >
        <DashboardPage
          title="Billing"
          section="Billing"
          description="Buy Sthrip subscriptions with OxaPay hosted checkout. Entitlements are granted after OxaPay sends a signed paid webhook."
          data-screen-label="billing"
          actions={<StatusChip status="OxaPay" tone="ok" size="md" />}
        >
          <div style={{ display: 'grid', gap: 18 }}>
            {returnedFromCheckout ? (
              <Card style={{ padding: 18, borderColor: 'var(--h-line)' }}>
                <Mono size={13} color="var(--h-text)">
                  Payment return received. OxaPay usually confirms credits within
                  a few moments after the signed webhook arrives.
                </Mono>
              </Card>
            ) : null}

            <div style={gridStyle}>
              <Card style={{ padding: 18, borderColor: 'var(--h-line)' }}>
                <div style={{ display: 'grid', gap: 8 }}>
                  <Mono size={11} color="var(--h-muted)">
                    AVAILABLE SCAN CREDITS
                  </Mono>
                  <strong style={{ fontSize: 34, lineHeight: 1 }}>
                    {billingStatus?.scan_credits ?? '...'}
                  </strong>
                </div>
              </Card>
              <Card style={{ padding: 18, borderColor: 'var(--h-line)' }}>
                <div style={{ display: 'grid', gap: 8 }}>
                  <Mono size={11} color="var(--h-muted)">
                    PR REVIEW CREDITS
                  </Mono>
                  <strong style={{ fontSize: 34, lineHeight: 1 }}>
                    {billingStatus?.review_credits ?? '...'}
                  </strong>
                </div>
              </Card>
            </div>

            {checkoutError ? (
              <Card style={{ padding: 18, borderColor: 'var(--h-critical)' }}>
                <Mono size={12} color="var(--h-critical)">
                  {checkoutError}
                </Mono>
              </Card>
            ) : null}

            <div style={gridStyle}>
              {products.map((product) => {
                const selected = requestedProduct === product.key;
                return (
                  <Card
                    key={product.key}
                    style={{
                      padding: 20,
                      borderColor: selected ? 'var(--h-black)' : 'var(--h-line)',
                      background: selected ? 'var(--h-white)' : 'var(--h-card)',
                    }}
                  >
                    <div style={{ display: 'grid', gap: 16, height: '100%' }}>
                      <div style={{ display: 'grid', gap: 8 }}>
                        <Mono size={11} color="var(--h-muted)">
                          {productAllocation(product)}
                        </Mono>
                        <h2 style={{ margin: 0, fontSize: 22 }}>
                          {product.name}
                        </h2>
                        <strong style={{ fontSize: 30 }}>
                          {formatUsd(product.monthly_usd_cents)}
                        </strong>
                        <p className="hack-muted-copy" style={{ margin: 0 }}>
                          {product.description}
                        </p>
                      </div>
                      <div style={{ display: 'grid', gap: 8 }}>
                        {product.features.map((feature) => (
                          <Mono key={feature} size={12} color="var(--h-text)">
                            {feature}
                          </Mono>
                        ))}
                      </div>
                      <DashboardButton
                        type="button"
                        variant="primary"
                        icon={CreditCard}
                        trailingIcon={ExternalLink}
                        disabled={busyProduct !== null || productsState.status !== 'success'}
                        onClick={() => void startCheckout(product)}
                      >
                        {busyProduct === product.key
                          ? 'Creating checkout'
                          : 'Pay with OxaPay'}
                      </DashboardButton>
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>
        </DashboardPage>
      </AppShell>
    </>
  );
}
