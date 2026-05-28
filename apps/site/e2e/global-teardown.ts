import { stopDevServer } from './helpers/dev-server.ts';
import { stopBackend } from './helpers/backend-server.ts';

export default async function globalTeardown(): Promise<void> {
  stopDevServer();
  await stopBackend();
}
