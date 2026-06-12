import { Link, useNavigate } from 'react-router-dom';

type DropdownItem = {
  readonly label: string;
  readonly description: string;
  readonly href: string;
  readonly icon: string;
  readonly external?: boolean;
};

export const SOLUTION_ITEMS: readonly DropdownItem[] = [
  {
    label: 'Blackbox',
    href: '/solutions/blackbox',
    description: 'Autonomous runtime testing for live apps and APIs',
    icon: '01',
  },
  {
    label: 'Whitebox',
    href: '/solutions/whitebox',
    description: 'Source-backed pentests in hours, not weeks',
    icon: '02',
  },
  {
    label: 'PR Review',
    href: '/solutions/pr-review',
    description: 'Catch exploitable changes before they ship',
    icon: '03',
  },
] as const;

const RESOURCE_ITEMS: readonly DropdownItem[] = [
  {
    label: 'Resources',
    href: '/resources',
    description: 'Security notes, trust docs, and legal references',
    icon: '//',
  },
  {
    label: 'Team',
    href: '/about',
    description: 'Meet the operators behind Sthrip',
    icon: 'TM',
  },
  {
    label: 'Legal',
    href: '/legal/terms',
    description: 'Terms, refunds, privacy, and data processing',
    icon: '§',
  },
  {
    label: 'Refunds',
    href: '/legal/refund',
    description: 'Refund, cancellation, and service-credit policy',
    icon: '$',
  },
] as const;

export function ArrowIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 18 18"
      className="minimal-arrow"
      focusable="false"
    >
      <path d="M3 9h11" />
      <path d="m10 5 4 4-4 4" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 18 18"
      className="minimal-external"
      focusable="false"
    >
      <path d="M5 5h8v8" />
      <path d="M5 13 13 5" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 18 18"
      className="minimal-chevron"
      focusable="false"
    >
      <path d="m4 7 5 5 5-5" />
    </svg>
  );
}

function DropdownLink({ item }: { item: DropdownItem }) {
  const external = item.external ?? item.href.startsWith('http');
  const content = (
    <>
      <span className="minimal-dropdown-icon" aria-hidden="true">
        {item.icon}
      </span>
      <span className="minimal-dropdown-copy">
        <span className="minimal-dropdown-label">
          {item.label}
          <ArrowIcon />
        </span>
        <span>{item.description}</span>
      </span>
    </>
  );

  if (external) {
    return (
      <a href={item.href} role="menuitem" target="_blank" rel="noreferrer">
        {content}
      </a>
    );
  }

  return (
    <Link to={item.href} role="menuitem">
      {content}
    </Link>
  );
}

function NavDropdown({
  label,
  items,
  align = 'left',
}: {
  readonly label: string;
  readonly items: readonly DropdownItem[];
  readonly align?: 'left' | 'right';
}) {
  return (
    <div className={`minimal-nav-dropdown minimal-nav-dropdown-${align}`}>
      <button type="button" aria-haspopup="menu">
        {label}
        <ChevronIcon />
      </button>
      <div className="minimal-dropdown-menu" role="menu">
        {items.map((item) => (
          <DropdownLink key={item.href} item={item} />
        ))}
      </div>
    </div>
  );
}

export function SignalBackground() {
  return (
    <div className="minimal-bg" aria-hidden="true">
      <div className="minimal-bg-image minimal-bg-image-primary" />
      <div className="minimal-bg-image minimal-bg-image-secondary" />
      <div className="minimal-bg-fade" />
      <div className="minimal-grid-lines" />
      <div className="minimal-scanline" />
    </div>
  );
}

export function FrameCorners({ className = '' }: { readonly className?: string }) {
  void className;
  return null;
}

export function HudOverlay() {
  return null;
}

type MarketingNavProps = {
  readonly onSignIn?: () => void;
  readonly onSignUp?: () => void;
  readonly onDemo?: () => void;
};

export function MarketingNav({ onSignIn, onSignUp }: MarketingNavProps) {
  const navigate = useNavigate();
  const handleSignIn = () => {
    if (onSignIn) {
      onSignIn();
      return;
    }
    navigate('/login');
  };
  const handleSignUp = () => {
    if (onSignUp) {
      onSignUp();
      return;
    }
    navigate('/signup');
  };

  return (
    <header className="minimal-nav">
      <Link to="/" className="minimal-wordmark minimal-wordmark-with-mark" aria-label="STHRIP">
        <img
          className="minimal-wordmark-mark"
          src="/assets/sthrip-logo-mark-white.png"
          alt=""
          aria-hidden="true"
        />
        <img className="minimal-wordmark-type" src="/assets/sthrip-wordmark-white.png" alt="STHRIP" />
      </Link>
      <nav className="minimal-nav-links" aria-label="Primary navigation">
        <Link to="/resources" className="minimal-docs-link">
          Docs
          <ExternalIcon />
        </Link>
        <NavDropdown label="Solutions" items={SOLUTION_ITEMS} />
        <Link to="/pricing">Pricing</Link>
        <Link to="/about">About</Link>
        <NavDropdown label="Resources" items={RESOURCE_ITEMS} align="right" />
      </nav>
      <div className="minimal-nav-actions">
        <button
          type="button"
          className="minimal-button minimal-button-secondary minimal-nav-login"
          onClick={handleSignIn}
        >
          Sign in
        </button>
        <button
          type="button"
          className="minimal-button minimal-button-primary minimal-nav-cta"
          onClick={handleSignUp}
        >
          Start for free
          <ArrowIcon />
        </button>
      </div>
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className="minimal-footer">
      <span>STHRIP</span>
      <nav className="minimal-footer-links" aria-label="Footer legal links">
        <Link to="/pricing">Pricing</Link>
        <Link to="/legal/terms">Terms</Link>
        <Link to="/legal/privacy">Privacy</Link>
        <Link to="/legal/refund">Refunds</Link>
      </nav>
      <a href="mailto:hello@sthrip.dev">hello@sthrip.dev</a>
    </footer>
  );
}
