import { stopDevServer } from './helpers/dev-server.ts';

export default async function globalTeardown(): Promise<void> {
  stopDevServer();
}
