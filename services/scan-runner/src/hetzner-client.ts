import { z } from 'zod';
import {
  type CreateServerOpts,
  type HetznerAction,
  type HetznerClient,
  type HetznerClientDeps,
  type HetznerServer,
  ScanError,
} from './types.ts';

const DEFAULT_BASE_URL = 'https://api.hetzner.cloud/v1';

const hetznerServerSchema = z.object({
  id: z.number(),
  status: z.enum(['initializing', 'starting', 'running', 'stopping', 'off', 'deleting']),
  public_net: z.object({
    ipv4: z.object({ ip: z.string() }),
  }),
  created: z.string(),
});

const hetznerActionSchema = z.object({
  id: z.number(),
  command: z.string(),
  status: z.enum(['running', 'success', 'error']),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

const createServerResponseSchema = z.object({
  server: hetznerServerSchema,
  action: hetznerActionSchema,
  root_password: z.string().nullable().optional(),
});

const getServerResponseSchema = z.object({
  server: hetznerServerSchema,
});

const deleteServerResponseSchema = z.object({
  action: hetznerActionSchema,
});

const getActionsResponseSchema = z.object({
  actions: z.array(hetznerActionSchema),
});

function mapServer(raw: z.infer<typeof hetznerServerSchema>): HetznerServer {
  return {
    id: raw.id,
    status: raw.status,
    publicNet: { ipv4: { ip: raw.public_net.ipv4.ip } },
    created: raw.created,
  };
}

function mapAction(raw: z.infer<typeof hetznerActionSchema>): HetznerAction {
  return {
    id: raw.id,
    command: raw.command,
    status: raw.status,
    ...(raw.error != null ? { error: raw.error } : {}),
  };
}

export const createHetznerClient = (deps: HetznerClientDeps): HetznerClient => {
  const { token, baseUrl = DEFAULT_BASE_URL } = deps;
  const fetchFn = deps.fetch ?? globalThis.fetch;

  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await fetchFn(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    });

    if (res.status === 404) {
      const text = await res.text().catch(() => '');
      throw new ScanError({
        code: 'invalid_request',
        message: `Hetzner 404: ${path}`,
        cause: { status: 404, body: text },
      });
    }

    if (res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => '');
      throw new ScanError({
        code: 'invalid_request',
        message: `Hetzner ${res.status}: ${path}`,
        cause: { status: res.status, body: text },
      });
    }

    if (res.status === 422) {
      const text = await res.text().catch(() => '');
      throw new ScanError({
        code: 'invalid_request',
        message: `Hetzner 422 unprocessable: ${path}`,
        cause: { status: 422, body: text },
      });
    }

    if (res.status === 429) {
      const retryAfter = res.headers.get('Retry-After');
      throw new Error(`Hetzner rate limit: ${path}`, { cause: { status: 429, retryAfter } });
    }

    if (res.status >= 500) {
      const text = await res.text().catch(() => '');
      throw new Error(`Hetzner ${res.status}: ${path}`, {
        cause: { status: res.status, body: text },
      });
    }

    if (res.status === 204) return {};

    return res.json();
  };

  return {
    async createServer(opts: CreateServerOpts) {
      const body = {
        name: opts.name,
        server_type: opts.serverType,
        location: opts.location,
        image: String(opts.imageId),
        user_data: opts.userData,
        labels: opts.labels,
        ...(opts.sshKeyIds != null && opts.sshKeyIds.length > 0
          ? { ssh_keys: opts.sshKeyIds }
          : {}),
      };
      const raw = await request('POST', '/servers', body);
      const parsed = createServerResponseSchema.parse(raw);
      return {
        server: mapServer(parsed.server),
        action: mapAction(parsed.action),
        ...(parsed.root_password != null ? { rootPassword: parsed.root_password } : {}),
      };
    },

    async getServer(id: number) {
      const raw = await request('GET', `/servers/${id}`);
      const parsed = getServerResponseSchema.parse(raw);
      return mapServer(parsed.server);
    },

    async deleteServer(id: number) {
      const raw = await request('DELETE', `/servers/${id}`);
      const parsed = deleteServerResponseSchema.parse(raw);
      return mapAction(parsed.action);
    },

    async getActions(serverId: number, ids?: readonly number[]) {
      const query = ids != null && ids.length > 0 ? `?${ids.map((i) => `id=${i}`).join('&')}` : '';
      const raw = await request('GET', `/servers/${serverId}/actions${query}`);
      const parsed = getActionsResponseSchema.parse(raw);
      return parsed.actions.map(mapAction);
    },
  };
};
