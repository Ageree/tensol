import { startDevServer } from './helpers/dev-server.ts';

export default async function globalSetup(): Promise<void> {
  await startDevServer();
}
