import { ClerkProvider, useAuth } from "@clerk/react";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import {
	clerkPublishableKey,
	isClerkConfigured,
	isE2EAuthBypass,
} from "./lib/clerk.ts";
import "./styles.css";
import { startTensolReveal } from "./tns-anim.ts";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

const app = (
	<BrowserRouter>
		<App />
	</BrowserRouter>
);

const convexUrl =
	(
		import.meta as unknown as { env?: { VITE_CONVEX_URL?: string } }
	).env?.VITE_CONVEX_URL?.trim() ?? "";
const convex = convexUrl ? new ConvexReactClient(convexUrl) : null;

ReactDOM.createRoot(root).render(
	<React.StrictMode>
		{isClerkConfigured && !isE2EAuthBypass ? (
			<ClerkProvider publishableKey={clerkPublishableKey} afterSignOutUrl="/">
				{convex ? (
					<ConvexProviderWithClerk client={convex} useAuth={useAuth}>
						{app}
					</ConvexProviderWithClerk>
				) : (
					app
				)}
			</ClerkProvider>
		) : (
			app
		)}
	</React.StrictMode>,
);

startTensolReveal();
