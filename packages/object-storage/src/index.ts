// Sprint 8 — minimal object storage abstraction.
//
// Sprint 9 will add MinIO/S3 adapters; for now a filesystem-backed stub
// satisfies the OPPLAN artifact write path. The interface is content-
// addressed: callers do not pick a key — `put({key,body})` returns sha256 +
// size, the caller stores those alongside their domain row.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const name = 'packages/object-storage' as const;

export interface ObjectPutInput {
  readonly key: string;
  readonly body: Buffer | Uint8Array | string;
  readonly contentType: string;
}

export interface ObjectPutResult {
  readonly key: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly contentType: string;
}

export interface ObjectStorage {
  put(input: ObjectPutInput): Promise<ObjectPutResult>;
  get(key: string): Promise<Buffer>;
}

export interface LocalObjectStorageDeps {
  readonly baseDir: string;
}

const SAFE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._/=:-]*$/;

const toBuffer = (body: Buffer | Uint8Array | string): Buffer => {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Buffer) return body;
  return Buffer.from(body);
};

const sha256Hex = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

export class LocalObjectStorage implements ObjectStorage {
  readonly baseDir: string;

  constructor(deps: LocalObjectStorageDeps) {
    this.baseDir = deps.baseDir;
  }

  async put(input: ObjectPutInput): Promise<ObjectPutResult> {
    if (!SAFE_KEY.test(input.key) || input.key.includes('..')) {
      throw new Error(`unsafe_object_key:${input.key}`);
    }
    const buf = toBuffer(input.body);
    const sha = sha256Hex(buf);
    const target = path.join(this.baseDir, input.key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, buf);
    return {
      key: input.key,
      sha256: sha,
      sizeBytes: buf.byteLength,
      contentType: input.contentType,
    };
  }

  async get(key: string): Promise<Buffer> {
    if (!SAFE_KEY.test(key) || key.includes('..')) {
      throw new Error(`unsafe_object_key:${key}`);
    }
    const target = path.join(this.baseDir, key);
    return await readFile(target);
  }
}
