// Sprint 18 — services/oob-receiver entry point.
// Starts HTTP + DNS OOB callback listeners (dev/lab fixture only).
// NOT wired to prod compose.

export const name = 'services/oob-receiver';

export {
  startHttpListener,
  type OobHttpListenerDeps,
  type OobHttpListenerHandle,
} from './http-listener.ts';
export {
  startDnsListener,
  type OobDnsListenerDeps,
  type OobDnsListenerHandle,
} from './dns-listener.ts';
export { parseToken, extractTokenFromPath, type ParsedToken } from './token.ts';
export { redactHeaders } from './redact.ts';
