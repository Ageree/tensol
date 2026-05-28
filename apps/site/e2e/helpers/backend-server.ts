/**
 * T090 — Spawn the Tensol backend as a Bun child process for E2E.
 *
 * Why a separate Bun process and not in-process:
 *   The Playwright runner executes globalSetup + test files under Node,
 *   and our backend uses `bun:sqlite` + `Bun.serve` which only exist on
 *   the Bun runtime. We therefore shell out to `bun run` against
 *   `tensol-test-server.ts` and wait for it to print the `READY <port>`
 *   sentinel to stdout before letting the test suite proceed.
 *
 * Lifecycle:
 *   - `startBackend()` spawns the child, waits for sentinel up to
 *     `TIMEOUT_MS`, returns the port.
 *   - `stopBackend()` sends SIGINT (so the child can teardown the DB
 *     handle + listener cleanly), then SIGKILL if it lingers.
 *
 * No-op safety:
 *   - Honors `PW_BACKEND_BASE_URL` — if set, assumes a backend is already
 *     running and skips the spawn entirely. This keeps the helper usable
 *     in CI that boots its own service container.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolved relative to this file: apps/site/e2e/helpers → repo-root/server/scripts.
const SERVER_SCRIPT = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'server',
  'scripts',
  'e2e-test-server.ts',
);
const DEFAULT_PORT = 3001;
const TIMEOUT_MS = 30_000;

let child: ChildProcessWithoutNullStreams | null = null;

export async function startBackend(opts?: {
  port?: number;
}): Promise<{ port: number; baseUrl: string }> {
  if (process.env.PW_BACKEND_BASE_URL) {
    const url = new URL(process.env.PW_BACKEND_BASE_URL);
    return {
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      baseUrl: process.env.PW_BACKEND_BASE_URL,
    };
  }
  if (child) {
    throw new Error('backend already started');
  }
  const port = opts?.port ?? DEFAULT_PORT;

  const proc = spawn('bun', ['run', SERVER_SCRIPT], {
    env: {
      ...process.env,
      TENSOL_E2E_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = proc;

  let stderrBuf = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk: string) => {
    stderrBuf += chunk;
    // Mirror to parent stderr so test debugging surfaces backend errors.
    process.stderr.write(`[backend] ${chunk}`);
  });

  proc.stdout.setEncoding('utf8');
  const ready = await new Promise<number>((resolve, reject) => {
    let stdoutBuf = '';
    const timer = setTimeout(() => {
      reject(
        new Error(
          `backend did not become READY within ${TIMEOUT_MS}ms.\nstdout:\n${stdoutBuf}\nstderr:\n${stderrBuf}`,
        ),
      );
    }, TIMEOUT_MS);

    proc.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      process.stdout.write(`[backend] ${chunk}`);
      const match = stdoutBuf.match(/READY (\d+)/);
      if (match && match[1]) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `backend exited before READY (code=${code}).\nstdout:\n${stdoutBuf}\nstderr:\n${stderrBuf}`,
        ),
      );
    });
  });

  return { port: ready, baseUrl: `http://127.0.0.1:${ready}` };
}

export async function stopBackend(): Promise<void> {
  if (process.env.PW_BACKEND_BASE_URL) return;
  if (!child) return;
  const proc = child;
  child = null;
  proc.kill('SIGINT');
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5_000);
    proc.on('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited) {
    proc.kill('SIGKILL');
  }
}
