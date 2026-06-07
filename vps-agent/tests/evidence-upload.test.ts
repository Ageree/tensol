/**
 * T134 — tests for evidence-upload.ts (T133).
 *
 * Verifies the S3 client wiring used by vps-agent to push `evidence.tar.gz`
 * bundles to Google Cloud Storage (S3-wire-compatible). Per research §R9
 * the wire protocol is S3, so we keep the contract test focused on:
 *   - the constructed object key  → `<prefix><scanId>/<filename>`
 *   - the command shape sent into the S3 client (Bucket, Key, ContentType)
 *   - the multipart boundary at the 5 MiB threshold
 *
 * Strategy: hand-rolled DI fakes for the S3 client and `Upload` class so the
 * tests stay hermetic — no AWS SDK network code is exercised.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEvidenceUploader,
  type UploadEvidenceOpts,
} from "../src/evidence-upload.ts";

/**
 * Drain (read to EOF) and close a stream-shaped `Body` the way the real AWS S3
 * client does. The uploader hands `PutObjectCommand` / `Upload` a lazily-opened
 * `fs.createReadStream` as the `Body`; a real S3 client consumes that stream,
 * so our hermetic fakes must too. If they don't, the stream's *deferred*
 * `open()` syscall fires AFTER the test's `afterEach` deletes the temp dir,
 * surfacing as an ENOENT `'error'` event with no listener → Bun reports
 * "Unhandled error between tests" (a CI-timing-sensitive flake that fails
 * whichever upload happened to lose the open-vs-rm race). Consuming the body
 * here closes the fd before teardown and handles any error in-band.
 */
interface StreamLikeBody {
  on(event: string, cb: () => void): unknown;
  resume(): unknown;
}

function isStreamLike(body: unknown): body is StreamLikeBody {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { on?: unknown }).on === "function"
  );
}

function drainBody(body: unknown): Promise<void> {
  if (!isStreamLike(body)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    body.on("error", finish); // ENOENT etc. handled in-band, never "unhandled"
    body.on("close", finish);
    body.on("end", finish);
    if (typeof body.resume === "function") body.resume();
    // flowing mode → triggers open(), reads to EOF, then close
  });
}

/**
 * Minimal recorder for `S3Client.send` invocations. We don't need a full S3
 * stub — only the captured command + the fake ETag the implementation returns
 * to its caller.
 */
function makeFakeS3(etag = '"fake-etag-abc123"') {
  const calls: Array<{ commandName: string; input: Record<string, unknown> }> =
    [];
  const s3 = {
    send: async (cmd: { constructor: { name: string }; input: unknown }) => {
      calls.push({
        commandName: cmd.constructor.name,
        input: cmd.input as Record<string, unknown>,
      });
      // Mirror the real S3 client: consume the Body stream so its lazily-opened
      // fd is read + closed before the test's afterEach removes the temp dir.
      await drainBody((cmd.input as { Body?: unknown }).Body);
      return { ETag: etag };
    },
  };
  return { s3, calls };
}

/**
 * Fake `Upload` constructor — captures construction args, returns a `.done()`
 * that resolves with a fixed ETag. Mirrors `@aws-sdk/lib-storage` shape just
 * enough for the uploader to dispatch into it.
 */
function makeFakeUpload(etag = '"fake-multipart-etag"') {
  const calls: Array<{ params: Record<string, unknown> }> = [];
  class FakeUpload {
    public params: Record<string, unknown>;
    constructor(args: { params: Record<string, unknown> }) {
      this.params = args.params;
      calls.push({ params: args.params });
    }
    async done() {
      // Mirror the real multipart Upload: consume the Body stream before
      // resolving so its lazily-opened fd is closed ahead of test teardown.
      await drainBody(this.params.Body);
      return { ETag: etag };
    }
  }
  return { FakeUpload, calls };
}

let workDir: string;
let smallFile: string;
let bigFile: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "tensol-evidence-test-"));
  smallFile = join(workDir, "evidence.tar.gz");
  writeFileSync(smallFile, Buffer.from("hello-evidence", "utf8"));

  // 6 MiB > 5 MiB multipart threshold
  bigFile = join(workDir, "evidence-big.tar.gz");
  writeFileSync(bigFile, Buffer.alloc(6 * 1024 * 1024, 0x41));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function buildOpts(
  overrides: Partial<UploadEvidenceOpts> = {},
): UploadEvidenceOpts {
  const fake = makeFakeS3();
  return {
    bucket: "tensol-evidence-prod",
    s3: fake.s3,
    ...overrides,
  };
}

describe("createEvidenceUploader — small-file PutObject path", () => {
  test("dispatches PutObjectCommand with expected key + body + content type", async () => {
    const fake = makeFakeS3();
    const uploader = createEvidenceUploader({
      bucket: "tensol-evidence-prod",
      s3: fake.s3,
    });

    const result = await uploader.uploadEvidence({
      scanId: "scan_01HXX",
      filePath: smallFile,
    });

    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]!.commandName).toBe("PutObjectCommand");
    expect(fake.calls[0]!.input.Bucket).toBe("tensol-evidence-prod");
    expect(fake.calls[0]!.input.Key).toBe(
      "evidence/scan_01HXX/evidence.tar.gz",
    );
    expect(fake.calls[0]!.input.ContentType).toBe("application/gzip");
    expect(fake.calls[0]!.input.Body).toBeDefined();

    expect(result.bucket).toBe("tensol-evidence-prod");
    expect(result.key).toBe("evidence/scan_01HXX/evidence.tar.gz");
    expect(result.size).toBe("hello-evidence".length);
    expect(result.etag).toBe('"fake-etag-abc123"');
  });

  test("does NOT invoke the multipart Upload class for small files", async () => {
    const fake = makeFakeS3();
    const fakeUpload = makeFakeUpload();
    const uploader = createEvidenceUploader({
      bucket: "tensol-evidence-prod",
      s3: fake.s3,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      uploadCtor: fakeUpload.FakeUpload as any,
    });

    await uploader.uploadEvidence({
      scanId: "scan_01HXX",
      filePath: smallFile,
    });

    expect(fakeUpload.calls.length).toBe(0);
    expect(fake.calls.length).toBe(1);
  });
});

describe("createEvidenceUploader — key construction", () => {
  test("default prefix is 'evidence/'", async () => {
    const fake = makeFakeS3();
    const uploader = createEvidenceUploader({
      bucket: "b",
      s3: fake.s3,
    });
    const r = await uploader.uploadEvidence({
      scanId: "scan_abc",
      filePath: smallFile,
    });
    expect(r.key).toBe("evidence/scan_abc/evidence.tar.gz");
  });

  test("custom prefix is honoured verbatim (incl. trailing slash semantics)", async () => {
    const fake = makeFakeS3();
    const uploader = createEvidenceUploader({
      bucket: "b",
      keyPrefix: "reports/",
      s3: fake.s3,
    });
    const r = await uploader.uploadEvidence({
      scanId: "scan_abc",
      filePath: smallFile,
    });
    expect(r.key).toBe("reports/scan_abc/evidence.tar.gz");
  });

  test("filename derived from the basename of filePath", async () => {
    const renamed = join(workDir, "har-bundle.tgz");
    writeFileSync(renamed, "x");
    const fake = makeFakeS3();
    const uploader = createEvidenceUploader({
      bucket: "b",
      s3: fake.s3,
    });
    const r = await uploader.uploadEvidence({
      scanId: "scan_xyz",
      filePath: renamed,
    });
    expect(r.key).toBe("evidence/scan_xyz/har-bundle.tgz");
  });
});

describe("createEvidenceUploader — multipart threshold (>=5 MiB)", () => {
  test("file >=5 MiB routes through Upload (multipart), not PutObject", async () => {
    const fake = makeFakeS3();
    const fakeUpload = makeFakeUpload();
    const uploader = createEvidenceUploader({
      bucket: "tensol-evidence-prod",
      s3: fake.s3,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      uploadCtor: fakeUpload.FakeUpload as any,
    });

    const result = await uploader.uploadEvidence({
      scanId: "scan_big",
      filePath: bigFile,
    });

    // Multipart fake invoked exactly once
    expect(fakeUpload.calls.length).toBe(1);
    // PutObjectCommand fast-path NOT taken
    expect(fake.calls.length).toBe(0);

    const params = fakeUpload.calls[0]!.params;
    expect(params.Bucket).toBe("tensol-evidence-prod");
    expect(params.Key).toBe("evidence/scan_big/evidence-big.tar.gz");
    expect(params.ContentType).toBe("application/gzip");
    expect(params.Body).toBeDefined();

    expect(result.key).toBe("evidence/scan_big/evidence-big.tar.gz");
    expect(result.size).toBe(6 * 1024 * 1024);
    expect(result.etag).toBe('"fake-multipart-etag"');
  });

  test("file at exactly 5 MiB triggers multipart (>= threshold)", async () => {
    const exactlyThreshold = join(workDir, "exact.tar.gz");
    writeFileSync(exactlyThreshold, Buffer.alloc(5 * 1024 * 1024, 0x42));

    const fake = makeFakeS3();
    const fakeUpload = makeFakeUpload();
    const uploader = createEvidenceUploader({
      bucket: "b",
      s3: fake.s3,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      uploadCtor: fakeUpload.FakeUpload as any,
    });

    await uploader.uploadEvidence({
      scanId: "scan_edge",
      filePath: exactlyThreshold,
    });

    expect(fakeUpload.calls.length).toBe(1);
    expect(fake.calls.length).toBe(0);
  });

  test("file at 5 MiB - 1 byte stays on PutObject fast-path", async () => {
    const justUnder = join(workDir, "under.tar.gz");
    writeFileSync(justUnder, Buffer.alloc(5 * 1024 * 1024 - 1, 0x43));

    const fake = makeFakeS3();
    const fakeUpload = makeFakeUpload();
    const uploader = createEvidenceUploader({
      bucket: "b",
      s3: fake.s3,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      uploadCtor: fakeUpload.FakeUpload as any,
    });

    await uploader.uploadEvidence({
      scanId: "scan_under",
      filePath: justUnder,
    });

    expect(fakeUpload.calls.length).toBe(0);
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]!.commandName).toBe("PutObjectCommand");
  });
});

describe("createEvidenceUploader — content type", () => {
  test("default content type is application/gzip", async () => {
    const fake = makeFakeS3();
    const uploader = createEvidenceUploader({
      bucket: "b",
      s3: fake.s3,
    });
    await uploader.uploadEvidence({
      scanId: "scan_abc",
      filePath: smallFile,
    });
    expect(fake.calls[0]!.input.ContentType).toBe("application/gzip");
  });

  test("custom content type is propagated", async () => {
    const fake = makeFakeS3();
    const uploader = createEvidenceUploader({
      bucket: "b",
      s3: fake.s3,
    });
    await uploader.uploadEvidence({
      scanId: "scan_abc",
      filePath: smallFile,
      contentType: "application/octet-stream",
    });
    expect(fake.calls[0]!.input.ContentType).toBe("application/octet-stream");
  });

  test("custom content type is propagated through multipart path", async () => {
    const fake = makeFakeS3();
    const fakeUpload = makeFakeUpload();
    const uploader = createEvidenceUploader({
      bucket: "b",
      s3: fake.s3,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      uploadCtor: fakeUpload.FakeUpload as any,
    });
    await uploader.uploadEvidence({
      scanId: "scan_big",
      filePath: bigFile,
      contentType: "application/x-tar",
    });
    expect(fakeUpload.calls[0]!.params.ContentType).toBe("application/x-tar");
  });
});

describe("createEvidenceUploader — validation", () => {
  test("empty bucket throws synchronously at factory call", () => {
    const opts = buildOpts({ bucket: "" });
    expect(() => createEvidenceUploader(opts)).toThrow(
      /bucket.*required/i,
    );
  });

  test("missing file throws when uploading", async () => {
    const fake = makeFakeS3();
    const uploader = createEvidenceUploader({
      bucket: "b",
      s3: fake.s3,
    });
    await expect(
      uploader.uploadEvidence({
        scanId: "scan_abc",
        filePath: join(workDir, "does-not-exist.tar.gz"),
      }),
    ).rejects.toThrow();
  });
});

describe("createEvidenceUploader — result shape", () => {
  test("returns {bucket, key, size, etag}", async () => {
    const fake = makeFakeS3('"my-etag"');
    const uploader = createEvidenceUploader({
      bucket: "tensol-evidence-prod",
      s3: fake.s3,
    });
    const r = await uploader.uploadEvidence({
      scanId: "scan_ok",
      filePath: smallFile,
    });
    expect(r).toEqual({
      bucket: "tensol-evidence-prod",
      key: "evidence/scan_ok/evidence.tar.gz",
      size: "hello-evidence".length,
      etag: '"my-etag"',
    });
  });
});
