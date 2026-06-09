import { SignUp, useAuth } from "@clerk/react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { AuthShell } from "../components/AuthShell.tsx";
import { RouteHead } from "../components/RouteHead.tsx";
import { Mono } from "../components/primitives.tsx";
import { normalizeReturnTo } from "../lib/auth-routing.ts";
import { isClerkConfigured, isE2EAuthBypass } from "../lib/clerk.ts";

export default function SignUpPage() {
	const navigate = useNavigate();
	const [search] = useSearchParams();
	const returnTo = normalizeReturnTo(search.get("return_to"));
	const onBack = () => navigate("/");

	if (isClerkConfigured && !isE2EAuthBypass) {
		return <ConfiguredSignUpPage onBack={onBack} returnTo={returnTo} />;
	}

	return (
		<AuthShell
			onBack={onBack}
			language="en"
			brand="sthrip"
			eyebrow="// SIGN UP"
			title="Create your Sthrip account."
			sub="Use Google or GitHub through Clerk to unlock the workspace."
		>
			<RouteHead title="Sign Up — Sthrip" />
			<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
				<Mono size={12} color="var(--red)">
					auth_not_configured
				</Mono>
				<Mono size={12} color="var(--fg-2)">
					Set VITE_CLERK_PUBLISHABLE_KEY for local development.
				</Mono>
			</div>
		</AuthShell>
	);
}

function ConfiguredSignUpPage({
	onBack,
	returnTo,
}: {
	readonly onBack: () => void;
	readonly returnTo: string;
}) {
	const { isLoaded, isSignedIn } = useAuth();

	if (!isLoaded) {
		return <AuthLoading title="Sign Up — Sthrip" />;
	}

	if (isSignedIn) {
		return <Navigate to={returnTo} replace />;
	}

	return (
		<AuthShell
			onBack={onBack}
			language="en"
			brand="sthrip"
			eyebrow="// SIGN UP"
			title="Create your Sthrip account."
			sub="Use Google or GitHub through Clerk to unlock the workspace."
		>
			<RouteHead title="Sign Up — Sthrip" />
			<div className="auth-clerk-frame">
				<SignUp
					routing="path"
					path="/signup"
					signInUrl="/login"
					forceRedirectUrl={returnTo}
					fallback={<Mono size={12}>loading auth</Mono>}
				/>
			</div>
		</AuthShell>
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
