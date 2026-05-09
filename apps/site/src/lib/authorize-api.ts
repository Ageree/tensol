export type AuthMethod = 'dns_txt' | 'file_upload' | 'whois_email';

export interface ChallengeData {
  id: string;
  method: AuthMethod;
  status: 'pending' | 'verified';
  expiresAt: string;
  instructions: {
    kind: AuthMethod;
    txtRecord?: { name: string; value: string };
    file?: { url: string; body: string };
    email?: { recipient: string };
  };
  alreadyVerified?: boolean;
}

export interface AuthStatusData {
  authorizedTargetVerified: boolean;
  attempts: {
    id: string;
    method: string;
    status: string;
    expiresAt: string;
    verifiedAt: string | null;
    attemptCount: number;
    lastError: string | null;
    createdAt: string;
  }[];
}

export interface ApiResponse<T> {
  data?: T;
  error?: string;
}

const parseEnvelope = async <T>(res: Response): Promise<ApiResponse<T>> => {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { error: 'parse_error' };
  }
  if (!res.ok) {
    const err = (body as Record<string, unknown>)?.error;
    const reason = (body as Record<string, unknown>)?.reason;
    return { error: String(reason ?? err ?? res.status) };
  }
  return { data: body as T };
};

export const startAuth = (
  targetId: string,
  method: AuthMethod,
): Promise<ApiResponse<ChallengeData>> =>
  fetch(`/api/v1/targets/${targetId}/authorize/start`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method }),
  }).then((r) => parseEnvelope<ChallengeData>(r));

export const verifyAuth = (
  targetId: string,
  method: AuthMethod,
): Promise<ApiResponse<{ status: string; reason?: string }>> =>
  fetch(`/api/v1/targets/${targetId}/authorize/verify`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method }),
  }).then((r) => parseEnvelope<{ status: string; reason?: string }>(r));

export const getAuthStatus = (targetId: string): Promise<ApiResponse<AuthStatusData>> =>
  fetch(`/api/v1/targets/${targetId}/authorize/status`, {
    credentials: 'include',
  }).then((r) => parseEnvelope<AuthStatusData>(r));

export const copyToClipboard = async (
  text: string,
  onCopied: () => void,
  onReset: () => void,
): Promise<void> => {
  await navigator.clipboard.writeText(text);
  onCopied();
  setTimeout(onReset, 1500);
};

export const pollOnce = async (
  getStatus: (id: string) => Promise<ApiResponse<AuthStatusData>>,
  targetId: string,
  dispatch: (action: { type: 'verifySuccess' }) => void,
): Promise<void> => {
  const res = await getStatus(targetId);
  if (res.data?.authorizedTargetVerified) {
    dispatch({ type: 'verifySuccess' });
  }
};
