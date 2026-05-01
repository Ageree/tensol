// Sprint 9 — artifact-writer: pushes screenshot/HAR/trace bytes to object
// storage and returns the per-artifact {key, sha256, sizeBytes} triples
// the worker stamps onto the observations_browser row.
//
// Object key shape (carry-forward CF-7):
//   tenant/<tenantId>/assessment/<assessmentId>/browser/<sessionId>/<artifact>-<sha>.<ext>
//
// SAFE_KEY enforcement is delegated to LocalObjectStorage.put() (Sprint 8).

import type { ObjectPutResult, ObjectStorage } from '@cyberstrike/object-storage';

const SAFE_NAMESPACE_RE = /^[a-zA-Z0-9-]+$/;

const sanitiseId = (id: string, label: string): string => {
  if (!SAFE_NAMESPACE_RE.test(id)) {
    throw new Error(`unsafe_id_for_object_key:${label}:${id}`);
  }
  return id;
};

export interface WriteArtifactsInput {
  readonly tenantId: string;
  readonly assessmentId: string;
  readonly sessionId: string;
  readonly screenshot: Uint8Array;
  /** HAR bytes — caller MUST have run redactCookies() already. */
  readonly har: Uint8Array;
  readonly trace: Uint8Array;
}

export interface WrittenArtifacts {
  readonly screenshot: ObjectPutResult;
  readonly har: ObjectPutResult;
  readonly trace: ObjectPutResult;
}

const ARTIFACT_PREFIXES = {
  screenshot: { name: 'screenshot', ext: 'png', contentType: 'image/png' },
  har: { name: 'har', ext: 'har.json', contentType: 'application/json' },
  trace: { name: 'trace', ext: 'zip', contentType: 'application/zip' },
} as const;

const buildKey = (
  tenantId: string,
  assessmentId: string,
  sessionId: string,
  artifact: keyof typeof ARTIFACT_PREFIXES,
  sha: string,
): string => {
  const cfg = ARTIFACT_PREFIXES[artifact];
  return `tenant/${tenantId}/assessment/${assessmentId}/browser/${sessionId}/${cfg.name}-${sha}.${cfg.ext}`;
};

// Pre-hash bytes so the key embeds the sha. LocalObjectStorage will hash
// again internally (cheap; constant-time on small artefacts) and return
// the same value. We trust LocalObjectStorage's value as the source of
// truth on the observations_browser row.
const sha256Of = async (bytes: Uint8Array): Promise<string> => {
  const hash = new Bun.CryptoHasher('sha256');
  hash.update(bytes);
  return hash.digest('hex');
};

const putOne = async (
  storage: ObjectStorage,
  tenantId: string,
  assessmentId: string,
  sessionId: string,
  artifact: keyof typeof ARTIFACT_PREFIXES,
  bytes: Uint8Array,
): Promise<ObjectPutResult> => {
  const sha = await sha256Of(bytes);
  const key = buildKey(tenantId, assessmentId, sessionId, artifact, sha);
  const cfg = ARTIFACT_PREFIXES[artifact];
  return storage.put({ key, body: Buffer.from(bytes), contentType: cfg.contentType });
};

export const writeArtifacts = async (
  storage: ObjectStorage,
  input: WriteArtifactsInput,
): Promise<WrittenArtifacts> => {
  const tenantId = sanitiseId(input.tenantId, 'tenantId');
  const assessmentId = sanitiseId(input.assessmentId, 'assessmentId');
  const sessionId = sanitiseId(input.sessionId, 'sessionId');
  const screenshot = await putOne(
    storage,
    tenantId,
    assessmentId,
    sessionId,
    'screenshot',
    input.screenshot,
  );
  const har = await putOne(storage, tenantId, assessmentId, sessionId, 'har', input.har);
  const trace = await putOne(storage, tenantId, assessmentId, sessionId, 'trace', input.trace);
  return { screenshot, har, trace };
};
