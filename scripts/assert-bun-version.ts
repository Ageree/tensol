import pkg from '../package.json' with { type: 'json' };

const pinned = pkg.packageManager?.split('@')[1];
const running = Bun.version;

if (!pinned) {
  console.error('package.json#packageManager missing or malformed');
  process.exit(1);
}

if (pinned !== running) {
  console.error(`Bun version mismatch: pinned=${pinned} running=${running}`);
  process.exit(1);
}

console.warn(`Bun version OK: ${running}`);
