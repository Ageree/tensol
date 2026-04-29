// Sprint 6 — static tool catalog (OQ-3 resolved). The catalog lives outside
// the engine; Sprint 8 (fake Decepticon) and Sprint 10 (validators) will
// refine it. Until then, the API loader hands this map to `buildEffectiveScope`.

import type { ToolPolicy } from '@cyberstrike/scope-engine';

const ENTRIES: ToolPolicy[] = [
  // recon
  { toolName: 'subfinder', category: 'recon', highImpact: false },
  { toolName: 'amass', category: 'recon', highImpact: false },
  { toolName: 'naabu', category: 'recon', highImpact: false },
  // web
  { toolName: 'nuclei', category: 'web', highImpact: false },
  { toolName: 'ffuf', category: 'web', highImpact: false },
  // cloud
  { toolName: 'prowler', category: 'cloud', highImpact: false },
  { toolName: 'scoutsuite', category: 'cloud', highImpact: false },
  // ad
  { toolName: 'bloodhound', category: 'ad', highImpact: true },
  // c2
  { toolName: 'sliver', category: 'c2', highImpact: true },
  // post_exploit
  { toolName: 'metasploit', category: 'post_exploit', highImpact: true },
  // credential_audit
  { toolName: 'hashcat', category: 'credential_audit', highImpact: true },
];

export const STATIC_TOOL_CATALOG: ReadonlyMap<string, ToolPolicy> = Object.freeze(
  new Map(ENTRIES.map((e) => [e.toolName, Object.freeze(e)])),
);
