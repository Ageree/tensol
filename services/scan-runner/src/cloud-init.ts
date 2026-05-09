import { ScanError } from './types.ts';

export interface CloudInitOpts {
  readonly scanId: string;
  readonly tenantId: string;
  readonly targetUrl: string;
  readonly callbackUrl: string;
  readonly callbackToken: string;
  readonly decepticonImage: string;
  readonly userAgent: string;
  readonly maxRuntimeMs: number;
}

const SHELL_SAFE = /^[A-Za-z0-9@%+=:,./-]+$/;

export const shellEscape = (value: string): string => {
  if (value.length === 0) return "''";
  if (SHELL_SAFE.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
};

export const buildCloudInit = (opts: CloudInitOpts): string => {
  const {
    scanId,
    tenantId,
    targetUrl,
    callbackUrl,
    callbackToken,
    decepticonImage,
    userAgent,
    maxRuntimeMs,
  } = opts;

  if (!scanId) throw new ScanError({ code: 'invalid_request', message: 'scanId required' });
  if (!callbackUrl)
    throw new ScanError({ code: 'invalid_request', message: 'callbackUrl required' });

  const maxRuntimeS = Math.floor(maxRuntimeMs / 1000);
  const escapedTarget = shellEscape(targetUrl);
  const escapedCallback = shellEscape(callbackUrl);
  const escapedToken = shellEscape(callbackToken);
  const escapedImage = shellEscape(decepticonImage);
  const escapedUaHeader = shellEscape(`User-Agent: ${userAgent}`);

  return `#cloud-config
package_update: true
packages:
  - docker.io
  - curl
  - jq
write_files:
  - path: /etc/tensol/scan.env
    permissions: '0600'
    content: |
      TENSOL_SCAN_ID=${scanId}
      TENSOL_TENANT_ID=${tenantId}
      VPS_SCAN_ID=${scanId}
      CALLBACK_URL=${callbackUrl}
runcmd:
  - mkdir -p /var/log/tensol
  - timeout ${maxRuntimeS}s docker run --rm
    --label tensol.scan_id=${scanId}
    -e VPS_SCAN_ID=${scanId}
    -e CALLBACK_URL=${escapedCallback}
    -e CALLBACK_TOKEN=${escapedToken}
    -e TARGET_URL=${escapedTarget}
    ${escapedImage} --target ${escapedTarget}
    > /var/log/tensol/scan.log 2>&1 || true
  - curl -sS -X POST
    -H ${shellEscape(`Authorization: Bearer ${callbackToken}`)}
    -H ${escapedUaHeader}
    -H 'Content-Type: application/json'
    --data-binary @/var/log/tensol/scan.log
    ${escapedCallback}
  - shutdown -h now
`;
};
