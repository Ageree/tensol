type ConvexEnv = {
	readonly VITE_CONVEX_URL?: string;
};

const env = (import.meta as unknown as { readonly env?: ConvexEnv }).env ?? {};

export const convexUrl = env.VITE_CONVEX_URL?.trim() ?? "";

export const isConvexConfigured = convexUrl.length > 0;
