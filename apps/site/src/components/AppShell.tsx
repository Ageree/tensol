import { Show, UserButton } from "@clerk/react";
import {
	Activity,
	Code2,
	FileText,
	Gauge,
	GitBranch,
	Link2,
	PanelLeftClose,
	PanelLeftOpen,
	Settings as SettingsIcon,
	ShieldCheck,
} from "lucide-react";
// Sthrip — App shell: sticky left nav, breadcrumb topbar, content slot.
import {
	type CSSProperties,
	Fragment,
	type ReactElement,
	type ReactNode,
	useState,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTensol } from "../context";
import { TENSOL_DATA } from "../data";
import { TENSOL_I18N, type TensolLang } from "../i18n";
import { isClerkConfigured, isE2EAuthBypass } from "../lib/clerk.ts";
import { LangSwitcher } from "./LangSwitcher.tsx";
import { DASHBOARD_UI_CSS } from "./dashboard-ui.tsx";
import { Eyebrow, LogoLockup, Mono, StatusChip } from "./primitives";

export type AppRoute =
	| "dashboard"
	| "live"
	| "findings"
	| "reports"
	| "reviews"
	| "connect"
	| "repositories"
	| "settings";

export type AppRole =
	| "security_lead"
	| "operator"
	| "viewer"
	| "auditor"
	| "tenant_admin"
	| "platform_admin"
	| "developer";

export interface AppShellProps {
	breadcrumb?: string[];
	actions?: ReactNode;
	children: ReactNode;
	role?: AppRole;
	density?: "comfortable" | "compact";
	brand?: "sthrip";
	language?: TensolLang;
	showLanguageSwitcher?: boolean;
	surface?: "default" | "white-mono" | "hacktron-light";
}

const ROUTE_PATHS: Record<AppRoute, string> = {
	dashboard: "/dashboard",
	live: "/live",
	findings: "/findings",
	reports: "/reports",
	reviews: "/reviews",
	connect: "/connect",
	repositories: "/repositories",
	settings: "/settings",
};

const SIDEBAR_COLLAPSED_KEY = "sthrip.sidebar.collapsed";
const APP_SHELL_RESPONSIVE_CSS = `
@media (max-width: 760px) {
  .app-shell--hacktron-light {
    grid-template-columns: minmax(0, 1fr) !important;
  }

  .app-shell--hacktron-light .app-shell-sidebar {
    position: sticky !important;
    top: 0 !important;
    z-index: 70 !important;
    height: auto !important;
    min-height: 64px !important;
    flex-direction: row !important;
    align-items: center !important;
    overflow-x: auto !important;
    overflow-y: hidden !important;
    border-right: 0 !important;
    border-bottom: 1px solid var(--line-soft, var(--fg)) !important;
  }

  .app-shell--hacktron-light .app-shell-brandbar {
    min-height: 64px !important;
    flex: 0 0 auto !important;
    border-bottom: 0 !important;
    padding: 12px !important;
  }

  .app-shell--hacktron-light .app-shell-nav-group {
    display: flex !important;
    align-items: center !important;
    padding: 0 !important;
  }

  .app-shell--hacktron-light .app-shell-group-eyebrow {
    display: none !important;
  }

  .app-shell--hacktron-light .app-shell-nav-group button {
    width: 44px !important;
    min-width: 44px !important;
    margin: 0 4px !important;
    padding: 8px 0 !important;
    justify-content: center !important;
  }

  .app-shell--hacktron-light .app-shell-nav-group button > span:nth-child(2),
  .app-shell--hacktron-light .app-shell-nav-group button > span:nth-child(3) {
    display: none !important;
  }

  .app-shell--hacktron-light .app-shell-status {
    display: none !important;
  }

  .app-shell--hacktron-light .app-shell-topbar {
    position: static !important;
    padding: 10px 14px !important;
    flex-wrap: wrap !important;
  }

  .app-shell--hacktron-light .app-shell-main {
    padding: 0 !important;
  }
}

@media (max-width: 520px) {
  .app-shell--hacktron-light .app-shell-brandbar img[alt="STHRIP"] {
    display: none !important;
  }
}
`;

function getInitialSidebarCollapsed(): boolean {
	if (typeof window === "undefined") return false;

	try {
		return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
	} catch {
		return false;
	}
}

function pathToRoute(pathname: string): AppRoute | null {
	const parts = pathname.split("/").filter(Boolean);
	const seg = parts[0];
	if (!seg) return null;
	if (seg === "scan") {
		if (parts[2] === "findings") return "findings";
		if (parts[2] === "report") return "reports";
		return "live";
	}
	if (seg === "wizard") return "live";
	const candidate = seg as AppRoute;
	if (candidate in ROUTE_PATHS) return candidate;
	return null;
}

interface NavItemProps {
	icon: ReactNode;
	label: string;
	active: boolean;
	badge?: string;
	onClick: () => void;
	disabled?: boolean;
	collapsed?: boolean;
	tone?: "default" | "hacktron-light";
}

function NavItem({
	icon,
	label,
	active,
	badge,
	onClick,
	disabled,
	collapsed = false,
	tone = "default",
}: NavItemProps): ReactElement {
	const [hov, setHov] = useState(false);
	const hacktronLight = tone === "hacktron-light";
	const style: CSSProperties = {
		display: "flex",
		alignItems: "center",
		justifyContent: collapsed ? "center" : "flex-start",
		gap: collapsed ? 0 : 10,
		minHeight: 38,
		padding: collapsed ? "8px 0" : "8px 12px",
		background: active
			? hacktronLight
				? "var(--bg-alt)"
				: "var(--fg)"
			: hov
				? "var(--bg-alt)"
				: "transparent",
		color: active
			? hacktronLight
				? "var(--fg)"
				: "var(--bg)"
			: disabled
				? "var(--fg-3)"
				: hacktronLight
					? "var(--fg-2)"
					: "var(--fg)",
		border: "none",
		borderLeft: collapsed
			? "none"
			: `2px solid ${active ? (hacktronLight ? "transparent" : "var(--red)") : "transparent"}`,
		borderRadius: hacktronLight ? 0 : 8,
		fontFamily: hacktronLight ? "inherit" : "'JetBrains Mono', monospace",
		fontSize: hacktronLight ? 15 : 12,
		letterSpacing: hacktronLight ? 0 : "0.04em",
		textTransform: hacktronLight ? "none" : "uppercase",
		cursor: disabled ? "not-allowed" : "pointer",
		opacity: disabled ? 0.4 : 1,
		textAlign: "left",
		width: collapsed
			? "calc(100% - 16px)"
			: hacktronLight
				? "calc(100% - 20px)"
				: "calc(100% - 24px)",
		margin: collapsed
			? "0 8px 4px"
			: hacktronLight
				? "0 10px 4px"
				: "0 12px 4px",
		position: "relative",
		transition: "background 140ms ease, color 140ms ease",
	};
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			onMouseEnter={() => setHov(true)}
			onMouseLeave={() => setHov(false)}
			aria-label={label}
			title={collapsed ? label : undefined}
			style={style}
		>
			<span
				style={{
					width: collapsed ? 22 : 16,
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					opacity: active ? 1 : 0.82,
				}}
			>
				{icon}
			</span>
			{!collapsed && <span style={{ flex: 1 }}>{label}</span>}
			{badge != null && !collapsed && (
				<span
					style={{
						fontSize: 10,
						padding: "1px 5px",
						background: active ? "var(--bg)" : "var(--red)",
						color: active ? "var(--fg)" : "var(--paper)",
						letterSpacing: 0,
						lineHeight: 1.4,
					}}
				>
					{badge}
				</span>
			)}
			{badge != null && collapsed && (
				<span
					aria-hidden="true"
					style={{
						position: "absolute",
						top: 5,
						right: 12,
						width: 5,
						height: 5,
						background: active ? "var(--bg)" : "var(--fg)",
					}}
				/>
			)}
		</button>
	);
}

export function AppShell({
	breadcrumb,
	actions,
	children,
	role,
	density = "comfortable",
	brand = "sthrip",
	language,
	showLanguageSwitcher = true,
	surface = "default",
}: AppShellProps): ReactElement {
	const { t: contextT } = useTensol();
	const t = language ? TENSOL_I18N[language] : contextT;
	const navigate = useNavigate();
	const location = useLocation();
	const route = pathToRoute(location.pathname);
	const isReadOnly = role === "viewer" || role === "auditor";
	const assessmentsActive = route === "live";
	const [sidebarCollapsed, setSidebarCollapsed] = useState(
		getInitialSidebarCollapsed,
	);

	const go = (r: AppRoute): void => {
		navigate(ROUTE_PATHS[r]);
	};

	const toggleSidebarCollapsed = (): void => {
		setSidebarCollapsed((value) => {
			const next = !value;
			try {
				window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
			} catch {
				// Ignore storage failures; the in-memory UI state still updates.
			}
			return next;
		});
	};

	const crumbs = breadcrumb ?? [];
	const lastCrumbIdx = crumbs.length - 1;
	const isWhiteMono = surface === "white-mono";
	const isHacktronLight = surface === "hacktron-light";
	const shouldShowTopbar =
		(!isWhiteMono && !isHacktronLight) ||
		actions != null ||
		showLanguageSwitcher;
	const shouldShowSidebarLabels = !isWhiteMono && !sidebarCollapsed;
	const showClerkControls = isClerkConfigured && !isE2EAuthBypass;
	const navIconProps = { size: 17, strokeWidth: 1.8 };
	const navTone = isHacktronLight ? "hacktron-light" : "default";

	return (
		<div
			className={`app-shell app-shell--${surface}${sidebarCollapsed ? " app-shell--collapsed" : ""}`}
			data-screen-label={`shell-${route ?? "unknown"}`}
			style={{
				...(isWhiteMono
					? ({
							"--paper": "#fbf4e2",
							"--bg": "#fbf4e2",
							"--bg-alt": "#f3ead2",
							"--fg-inv": "#fbf4e2",
							"--line-soft": "rgba(18, 12, 13, 0.22)",
							"--red": "#120c0d",
							"--red-deep": "#120c0d",
							"--red-tint": "rgba(18, 12, 13, 0.08)",
						} as CSSProperties)
					: isHacktronLight
						? ({
								"--paper": "#f5f5f4",
								"--bg": "#eeeeec",
								"--bg-alt": "#ffffff",
								"--fg-inv": "#ffffff",
								"--ink": "#242424",
								"--fg": "#202020",
								"--fg-2": "#6f6f6f",
								"--fg-3": "#90908d",
								"--line": "#d8d6d2",
								"--line-soft": "#e4e2de",
								"--red": "#111111",
								"--red-deep": "#111111",
								"--red-tint": "rgba(17, 17, 17, 0.06)",
								"--ok": "#6f6f6f",
							} as CSSProperties)
						: {}),
				minHeight: "100vh",
				background: "var(--paper)",
				color: "var(--ink)",
				display: "grid",
				fontFamily: isHacktronLight
					? '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif'
					: undefined,
				gridTemplateColumns: sidebarCollapsed
					? "72px minmax(0, 1fr)"
					: isHacktronLight
						? "300px minmax(0, 1fr)"
						: "232px minmax(0, 1fr)",
				transition: "grid-template-columns 180ms ease",
			}}
		>
			{isHacktronLight && (
				<style>{`${APP_SHELL_RESPONSIVE_CSS}\n${DASHBOARD_UI_CSS}`}</style>
			)}
			<aside
				className="app-shell-sidebar"
				style={{
					background: "var(--bg)",
					borderRight: `1px solid ${isHacktronLight ? "var(--line-soft)" : "var(--fg)"}`,
					display: "flex",
					flexDirection: "column",
					position: "sticky",
					top: 0,
					height: "100vh",
					overflow: "hidden",
				}}
			>
				<div
					className="app-shell-brandbar"
					style={{
						minHeight: 76,
						padding: sidebarCollapsed
							? "18px 0 14px"
							: isHacktronLight
								? "18px 18px 14px"
								: "20px 16px",
						borderBottom: isWhiteMono
							? "none"
							: `1px solid ${isHacktronLight ? "var(--line-soft)" : "var(--fg)"}`,
						display: "flex",
						alignItems: "center",
						justifyContent: sidebarCollapsed ? "center" : "space-between",
						gap: 10,
					}}
				>
					{!sidebarCollapsed && brand === "sthrip" && isHacktronLight ? (
						<button
							type="button"
							aria-label="STHRIP organization"
							onClick={() => navigate("/dashboard")}
							style={{
								display: "inline-flex",
								alignItems: "center",
								gap: 10,
								minWidth: 0,
								border: 0,
								background: "transparent",
								padding: 0,
								color: "var(--fg)",
								cursor: "pointer",
								fontFamily: "inherit",
								fontSize: 16,
								fontWeight: 600,
							}}
						>
							<span
								aria-hidden="true"
								style={{
									width: 24,
									height: 24,
									display: "inline-flex",
									alignItems: "center",
									justifyContent: "center",
									borderRadius: 999,
									background: "#fff",
									color: "var(--fg-2)",
									fontSize: 12,
									fontWeight: 500,
									textTransform: "lowercase",
								}}
							>
								s
							</span>
							<span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
								sthrip
							</span>
							<span
								aria-hidden="true"
								style={{ color: "var(--fg-3)", fontSize: 13 }}
							>
								⌄
							</span>
						</button>
					) : !sidebarCollapsed && brand === "sthrip" ? (
						<button
							type="button"
							aria-label="STHRIP home"
							onClick={() => navigate("/")}
							style={{
								display: "inline-flex",
								alignItems: "center",
								gap: 8,
								border: 0,
								background: "transparent",
								padding: 0,
								cursor: "pointer",
							}}
						>
							<img
								src="/assets/sthrip-logo-mark-white.png"
								alt=""
								aria-hidden="true"
								style={{
									display: "block",
									width: 30,
									height: 30,
									filter: "invert(1) brightness(0.12)",
								}}
							/>
							<img
								src="/assets/sthrip-wordmark-white.png"
								alt="STHRIP"
								style={{
									display: "block",
									width: 112,
									height: "auto",
									filter: "invert(1) brightness(0.12)",
								}}
							/>
						</button>
					) : !sidebarCollapsed ? (
						<LogoLockup
							size={16}
							color="var(--fg)"
							onClick={() => navigate("/")}
						/>
					) : null}
					<button
						type="button"
						aria-label={
							sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"
						}
						title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
						onClick={toggleSidebarCollapsed}
						style={{
							width: sidebarCollapsed ? 38 : 32,
							height: sidebarCollapsed ? 38 : 32,
							display: "inline-flex",
							alignItems: "center",
							justifyContent: "center",
							border: "none",
							background: "transparent",
							color: "var(--fg)",
							cursor: "pointer",
							padding: 0,
						}}
					>
						{sidebarCollapsed ? (
							<PanelLeftOpen size={18} strokeWidth={1.9} aria-hidden="true" />
						) : (
							<PanelLeftClose size={18} strokeWidth={1.9} aria-hidden="true" />
						)}
					</button>
					{sidebarCollapsed && (
						<span
							aria-hidden="true"
							style={{
								position: "absolute",
								left: 0,
								right: 0,
								bottom: 0,
								height: isWhiteMono ? 0 : 1,
								background: "var(--fg)",
							}}
						/>
					)}
				</div>

				<div
					className="app-shell-nav-group"
					style={{ padding: isHacktronLight ? "0" : "12px 0 0" }}
				>
					{shouldShowSidebarLabels && !isHacktronLight && (
						<div className="app-shell-group-eyebrow">
							<Eyebrow style={{ padding: "0 16px 8px", fontSize: 10 }}>
								{t.navProduct}
							</Eyebrow>
						</div>
					)}
					<NavItem
						icon={<Gauge {...navIconProps} />}
						label={t.navDashboard}
						active={route === "dashboard"}
						onClick={() => go("dashboard")}
						collapsed={sidebarCollapsed}
						tone={navTone}
					/>
					<NavItem
						icon={<Code2 {...navIconProps} />}
						label={isHacktronLight ? "PR Reviews" : t.navReviews}
						active={route === "reviews"}
						onClick={() => go("reviews")}
						collapsed={sidebarCollapsed}
						tone={navTone}
					/>
					<NavItem
						icon={<Activity {...navIconProps} />}
						label={isHacktronLight ? "Blackbox Scans" : t.navAssessments}
						active={assessmentsActive}
						onClick={() => navigate("/scan/new")}
						badge={isHacktronLight ? undefined : "2"}
						collapsed={sidebarCollapsed}
						tone={navTone}
					/>
					<NavItem
						icon={<ShieldCheck {...navIconProps} />}
						label={t.navFindings}
						active={route === "findings"}
						onClick={() => go("findings")}
						collapsed={sidebarCollapsed}
						tone={navTone}
					/>
					<NavItem
						icon={<FileText {...navIconProps} />}
						label={isHacktronLight ? "Usage" : t.navReports}
						active={route === "reports"}
						onClick={() => go("reports")}
						collapsed={sidebarCollapsed}
						tone={navTone}
					/>
					<NavItem
						icon={<Link2 {...navIconProps} />}
						label={isHacktronLight ? "Integrations" : t.navConnect}
						active={route === "connect"}
						onClick={() => go("connect")}
						collapsed={sidebarCollapsed}
						tone={navTone}
					/>
					<NavItem
						icon={<GitBranch {...navIconProps} />}
						label={t.navRepositories}
						active={route === "repositories"}
						onClick={() => go("repositories")}
						collapsed={sidebarCollapsed}
						tone={navTone}
					/>
				</div>

				<div
					className="app-shell-nav-group"
					style={{ padding: isHacktronLight ? "18px 0 0" : "24px 0 0" }}
				>
					{shouldShowSidebarLabels && (
						<div className="app-shell-group-eyebrow">
							<Eyebrow style={{ padding: "0 16px 8px", fontSize: 10 }}>
								{isHacktronLight ? "Management" : t.navAccount}
							</Eyebrow>
						</div>
					)}
					<NavItem
						icon={<SettingsIcon {...navIconProps} />}
						label={t.navSettings}
						active={route === "settings"}
						onClick={() => go("settings")}
						collapsed={sidebarCollapsed}
						tone={navTone}
					/>
				</div>

				{!isWhiteMono && !isHacktronLight && (
					<div
						className="app-shell-status"
						style={{
							marginTop: "auto",
							padding: sidebarCollapsed ? "16px 0" : "16px",
							borderTop: "1px solid var(--fg)",
							display: sidebarCollapsed ? "flex" : "block",
							justifyContent: "center",
						}}
					>
						{sidebarCollapsed ? (
							<span
								title={t.engineHealth}
								style={{
									width: 8,
									height: 8,
									background: "#1F7A3A",
									display: "block",
								}}
							/>
						) : (
							<>
								<Eyebrow style={{ marginBottom: 8 }}>{t.engineHealth}</Eyebrow>
								<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
									<span
										style={{ width: 8, height: 8, background: "#1F7A3A" }}
									/>
									<Mono size={12} color="var(--fg)">
										ok · 14ms p50
									</Mono>
								</div>
								<div style={{ marginTop: 12 }}>
									<Mono size={11} color="var(--fg)">
										{TENSOL_DATA.user.name}
									</Mono>
									<Mono
										size={10}
										color="var(--fg-3)"
										style={{ display: "block" }}
									>
										{role ?? TENSOL_DATA.user.role}
									</Mono>
								</div>
							</>
						)}
					</div>
				)}
			</aside>

			<div
				className="app-shell-content"
				style={{ display: "flex", flexDirection: "column", minWidth: 0 }}
			>
				{shouldShowTopbar && (
					<header
						className="app-shell-topbar"
						style={{
							position: "sticky",
							top: 0,
							zIndex: 50,
							background: "var(--paper)",
							borderBottom: "1px solid var(--fg)",
							padding: density === "compact" ? "10px 24px" : "14px 28px",
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							gap: 16,
						}}
					>
						<div
							style={{
								fontFamily: "'JetBrains Mono', monospace",
								fontSize: 12,
								letterSpacing: "0.04em",
								color: "var(--fg-2)",
								display: "flex",
								alignItems: "center",
								gap: 8,
								minWidth: 0,
								overflow: "hidden",
							}}
						>
							<span>{TENSOL_DATA.user.tenant}</span>
							{crumbs.map((b, i) => (
								<Fragment key={`${i}-${b}`}>
									<span>▸</span>
									<span
										style={{
											color: i === lastCrumbIdx ? "var(--fg)" : "var(--fg-2)",
										}}
									>
										{b}
									</span>
								</Fragment>
							))}
							{isReadOnly && role && (
								<span style={{ marginLeft: 12 }}>
									<StatusChip
										status={`read-only · ${role}`}
										tone="warn"
										size="sm"
									/>
								</span>
							)}
						</div>
						<div style={{ display: "flex", alignItems: "center", gap: 12 }}>
							{showLanguageSwitcher && <LangSwitcher />}
							{showClerkControls && (
								<Show when="signed-in">
									<UserButton />
								</Show>
							)}
							{actions}
						</div>
					</header>
				)}

				<main
					className="app-shell-main"
					style={{
						padding: isHacktronLight
							? 0
							: density === "compact"
								? "20px 24px"
								: "32px 28px",
						flex: 1,
						minWidth: 0,
					}}
				>
					{children}
				</main>
			</div>
		</div>
	);
}
