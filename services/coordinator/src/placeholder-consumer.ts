// Sprint 7 §5.4 A-Q-Coord-3 — recon.browser.placeholder consumer.
//
// No-op handler that validates payload then acks. Sprint 9 will replace
// with the real browser worker.

import type { Handler, HandlerOutcome, JobEnvelope } from '@cyberstrike/queue';
import { ScopeDenyError } from '@cyberstrike/queue';
import { reconPlaceholderPayloadSchema } from './payloads.ts';

export const reconPlaceholderHandler: Handler = async (
  envelope: JobEnvelope,
): Promise<HandlerOutcome> => {
  const parsed = reconPlaceholderPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    // Defence in depth — even though the envelope is well-formed, an
    // upstream coordinator bug could publish a malformed payload. Terminal.
    return {
      kind: 'nack',
      error: new ScopeDenyError('invalid_recon_placeholder_payload', [
        'recon_payload_schema_mismatch',
      ]),
    };
  }
  // Sprint 9 will perform real browser recon here.
  return { kind: 'ack' };
};
