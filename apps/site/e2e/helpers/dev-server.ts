import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

const SCRIPT_PATH = '/tmp/start-tensol-qa-dev.sh';
const SESSION = 'qa-dev';
const PORT = 5175;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const POLL_INTERVAL_MS = 1000;
const TIMEOUT_MS = 90_000;

export async function startDevServer(): Promise<void> {
  if (process.env.PW_BASE_URL) return;

  if (await isPortUp()) return;

  fs.writeFileSync(
    SCRIPT_PATH,
    [
      '#!/usr/bin/env bash',
      `cd /Users/saveliy/Documents/пентест\\ ИИ/apps/site`,
      'exec npx vite',
    ].join('\n'),
    { mode: 0o755 },
  );

  spawnSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' });
  execSync(
    `tmux new-session -d -s ${SESSION} "${SCRIPT_PATH} 2>&1 | tee /tmp/tensol-qa-dev.log"`,
  );

  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    if (await isPortUp()) return;
    await sleep(POLL_INTERVAL_MS);
  }

  const log = fs.existsSync('/tmp/tensol-qa-dev.log')
    ? fs.readFileSync('/tmp/tensol-qa-dev.log', 'utf8').slice(-2000)
    : '(no log)';
  throw new Error(
    `Dev server did not start on :${PORT} within ${TIMEOUT_MS / 1000}s.\nLog tail:\n${log}`,
  );
}

export function stopDevServer(): void {
  if (process.env.PW_BASE_URL) return;
  spawnSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' });
}

async function isPortUp(): Promise<boolean> {
  try {
    const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(800) });
    return res.status < 500;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
