import { SignIn, useAuth } from "@clerk/react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { AuthShell } from "../components/AuthShell.tsx";
import { RouteHead } from "../components/RouteHead.tsx";
import { Mono } from "../components/primitives.tsx";
import { TENSOL_I18N } from "../i18n.ts";
import { normalizeReturnTo } from "../lib/auth-routing.ts";
import { isClerkConfigured, isE2EAuthBypass } from "../lib/clerk.ts";

const ERROR_COPY: Record<string, string> = {
	auth_not_configured: "clerk_publishable_key_missing",
	unauthenticated: "sign_in_required",
};

export default function Login() {
	const t = TENSOL_I18N.en;
	const navigate = useNavigate();
	const [search] = useSearchParams();
	const returnTo = normalizeReturnTo(search.get("return_to"));
	const error = search.get("error");
	const errorCode = error ? (ERROR_COPY[error] ?? error) : null;
	const onBack = () => navigate("/");

	if (isClerkConfigured && !isE2EAuthBypass) {
		return (
			<ConfiguredLoginPage
				errorCode={errorCode}
				onBack={onBack}
				returnTo={returnTo}
			/>
		);
	}

	return (
		<AuthShell
			onBack={onBack}
			language="en"
			brand="sthrip"
			eyebrow={t.authLoginEyebrow}
			title="Log in to Sthrip."
			sub="Use Google or GitHub through Clerk to unlock the workspace."
		>
			<RouteHead title="Log In — Sthrip" />
			<div
				data-screen-label="03 Auth — clerk sign in"
				style={{ display: "flex", flexDirection: "column", gap: 14 }}
			>
				{errorCode && <AuthError code={errorCode} />}
				<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
					<Mono size={12} color="var(--red)">
						auth_not_configured
					</Mono>
					<Mono size={12} color="var(--fg-2)">
						Set VITE_CLERK_PUBLISHABLE_KEY for local development.
					</Mono>
				</div>
			</div>
		</AuthShell>
	);
}

function ConfiguredLoginPage({
	errorCode,
	onBack,
	returnTo,
}: {
	readonly errorCode: string | null;
	readonly onBack: () => void;
	readonly returnTo: string;
}) {
	const t = TENSOL_I18N.en;
	const { isLoaded, isSignedIn } = useAuth();

	if (!isLoaded) {
		return <AuthLoading title="Log In — Sthrip" />;
	}

	if (isSignedIn) {
		return <Navigate to={returnTo} replace />;
	}

	return (
		<AuthShell
			onBack={onBack}
			language="en"
			brand="sthrip"
			eyebrow={t.authLoginEyebrow}
			title="Log in to Sthrip."
			sub="Use Google or GitHub through Clerk to unlock the workspace."
		>
			<RouteHead title="Log In — Sthrip" />
			<div
				data-screen-label="03 Auth — clerk sign in"
				style={{ display: "flex", flexDirection: "column", gap: 14 }}
			>
				{errorCode && <AuthError code={errorCode} />}

				<div className="auth-clerk-frame">
					<SignIn
						routing="path"
						path="/login"
						signUpUrl="/signup"
						forceRedirectUrl={returnTo}
						fallback={<Mono size={12}>loading auth</Mono>}
					/>
				</div>
			</div>
		</AuthShell>
	);
}

function AuthError({ code }: { readonly code: string }) {
	return (
		<div
			style={{
				padding: "10px 12px",
				border: "1px solid var(--red)",
				color: "var(--red)",
				fontFamily: "'JetBrains Mono', monospace",
				fontSize: 12,
			}}
		>{`[fail] ${code}`}</div>
	);
}

function AuthLoading({ title }: { readonly title: string }) {
	return (
		<main className="auth-route-loading">
			<RouteHead title={title} />
			<Mono size={12}>loading auth</Mono>
		</main>
	);
}
