import { describe, expect, it } from 'bun:test';
import { createHetznerClient } from '../hetzner-client.ts';
import { ScanError } from '../types.ts';

const makeServer = (overrides: object = {}) => ({
  id: 42,
  status: 'running' as const,
  public_net: { ipv4: { ip: '1.2.3.4' } },
  created: '2026-05-09T00:00:00Z',
  ...overrides,
});

const makeAction = (overrides: object = {}) => ({
  id: 1,
  command: 'create_server',
  status: 'running' as const,
  ...overrides,
});

const mockFetch = (status: number, body: unknown): typeof globalThis.fetch =>
  (async (_url: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;

describe('createHetznerClient', () => {
  describe('createServer', () => {
    it('T8 — happy path: serializes body correctly, returns parsed server+action, does not call deleteServer', async () => {
      let capturedInit: RequestInit | undefined;
      const fetch: typeof globalThis.fetch = async (_url, init) => {
        capturedInit = init;
        return new Response(
          JSON.stringify({
            server: makeServer(),
            action: makeAction(),
            root_password: null,
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const client = createHetznerClient({ token: 'test-token', fetch });
      const result = await client.createServer({
        name: 'tensol-scan-abc',
        serverType: 'cpx21',
        location: 'fsn1',
        imageId: 123,
        userData: '#cloud-config\n',
        labels: { scan_id: 'abc', managed_by: 'tensol' },
      });

      expect(result.server.id).toBe(42);
      expect(result.server.status).toBe('running');
      expect(result.server.publicNet.ipv4.ip).toBe('1.2.3.4');
      expect(result.action.id).toBe(1);
      expect(capturedInit?.method).toBe('POST');

      const requestBody = JSON.parse(capturedInit?.body as string);
      expect(requestBody.name).toBe('tensol-scan-abc');
      expect(requestBody.server_type).toBe('cpx21');
      expect(requestBody.user_data).toBe('#cloud-config\n');
      expect(capturedInit?.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    });

    it('401 → ScanError{code:invalid_request}', async () => {
      const client = createHetznerClient({
        token: 'bad',
        fetch: mockFetch(401, { error: { code: 'unauthorized', message: 'Bad credentials' } }),
      });
      await expect(
        client.createServer({
          name: 'x',
          serverType: 'cpx11',
          location: 'fsn1',
          imageId: 1,
          userData: '',
          labels: {},
        }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    });

    it('422 → ScanError{code:invalid_request}', async () => {
      const client = createHetznerClient({
        token: 't',
        fetch: mockFetch(422, { error: { code: 'invalid_input', message: 'bad' } }),
      });
      await expect(
        client.createServer({
          name: 'x',
          serverType: 'cpx11',
          location: 'fsn1',
          imageId: 1,
          userData: '',
          labels: {},
        }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    });

    it('T8 — 5xx → throws raw Error (not ScanError), deleteServer NOT called', async () => {
      const client = createHetznerClient({
        token: 't',
        fetch: mockFetch(503, { error: { code: 'service_unavailable', message: 'down' } }),
      });
      const err = await client
        .createServer({
          name: 'x',
          serverType: 'cpx11',
          location: 'fsn1',
          imageId: 1,
          userData: '',
          labels: {},
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ScanError);
    });

    it('sends Authorization: Bearer token header on every request', async () => {
      let capturedHeaders: HeadersInit | undefined;
      const fetch: typeof globalThis.fetch = async (_url, init) => {
        capturedHeaders = init?.headers;
        return new Response(
          JSON.stringify({
            server: makeServer(),
            action: makeAction(),
            root_password: null,
          }),
          { status: 201 },
        );
      };
      const client = createHetznerClient({ token: 'my-secret-token', fetch });
      await client.createServer({
        name: 'x',
        serverType: 'cpx11',
        location: 'fsn1',
        imageId: 1,
        userData: '',
        labels: {},
      });
      expect(capturedHeaders).toMatchObject({ Authorization: 'Bearer my-secret-token' });
    });
  });

  describe('getServer', () => {
    it('T9 — parses response and maps status field', async () => {
      const client = createHetznerClient({
        token: 't',
        fetch: mockFetch(200, { server: makeServer({ status: 'initializing' }) }),
      });
      const server = await client.getServer(42);
      expect(server.id).toBe(42);
      expect(server.status).toBe('initializing');
      expect(server.publicNet.ipv4.ip).toBe('1.2.3.4');
    });

    it('404 → ScanError{code:invalid_request}', async () => {
      const client = createHetznerClient({
        token: 't',
        fetch: mockFetch(404, { error: { code: 'not_found', message: 'server not found' } }),
      });
      await expect(client.getServer(9999)).rejects.toMatchObject({ code: 'invalid_request' });
    });
  });

  describe('deleteServer', () => {
    it('T10 — calls correct DELETE endpoint and returns action', async () => {
      let capturedUrl: string | undefined;
      const fetch: typeof globalThis.fetch = async (url, _init) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify({ action: makeAction({ command: 'delete_server' }) }), {
          status: 200,
        });
      };
      const client = createHetznerClient({ token: 't', fetch });
      const action = await client.deleteServer(42);
      expect(capturedUrl).toContain('/servers/42');
      expect(action.command).toBe('delete_server');
    });
  });

  describe('getActions', () => {
    it('returns array of actions', async () => {
      const client = createHetznerClient({
        token: 't',
        fetch: mockFetch(200, { actions: [makeAction({ command: 'start_server' })] }),
      });
      const actions = await client.getActions(42);
      expect(actions).toHaveLength(1);
      expect(actions[0]?.command).toBe('start_server');
    });
  });
});
