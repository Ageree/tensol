export type AuthMethod = 'dns_txt' | 'file_upload' | 'whois_email';

export interface ChallengeArtifact {
  readonly token: string;
  readonly instructions: {
    readonly kind: AuthMethod;
    readonly txtRecord?: { readonly name: string; readonly value: string };
    readonly file?: { readonly url: string; readonly body: string };
    readonly email?: { readonly recipient: string };
  };
}

export interface VerifierResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly observed?: unknown;
}
