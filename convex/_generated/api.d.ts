/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentTokens from "../agentTokens.js";
import type * as auth from "../auth.js";
import type * as config from "../config.js";
import type * as crons from "../crons.js";
import type * as deepInquiries from "../deepInquiries.js";
import type * as gcloud from "../gcloud.js";
import type * as github from "../github.js";
import type * as http from "../http.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_gcloudProvisioning from "../lib/gcloudProvisioning.js";
import type * as lib_quota from "../lib/quota.js";
import type * as lib_webhook from "../lib/webhook.js";
import type * as lib_wire from "../lib/wire.js";
import type * as ops from "../ops.js";
import type * as review from "../review.js";
import type * as scanOrders from "../scanOrders.js";
import type * as scanOrdersInternal from "../scanOrdersInternal.js";
import type * as scans from "../scans.js";
import type * as settings from "../settings.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentTokens: typeof agentTokens;
  auth: typeof auth;
  config: typeof config;
  crons: typeof crons;
  deepInquiries: typeof deepInquiries;
  gcloud: typeof gcloud;
  github: typeof github;
  http: typeof http;
  "lib/auth": typeof lib_auth;
  "lib/gcloudProvisioning": typeof lib_gcloudProvisioning;
  "lib/quota": typeof lib_quota;
  "lib/webhook": typeof lib_webhook;
  "lib/wire": typeof lib_wire;
  ops: typeof ops;
  review: typeof review;
  scanOrders: typeof scanOrders;
  scanOrdersInternal: typeof scanOrdersInternal;
  scans: typeof scans;
  settings: typeof settings;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
