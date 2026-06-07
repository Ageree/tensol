import { anyApi } from 'convex/server';

// The Vercel project root is apps/site, so the site bundle cannot import the
// generated Convex API from the monorepo-level convex/_generated directory.
// At runtime Convex function references are resolved dynamically by module path.
export const api = anyApi;
