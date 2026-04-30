import { z } from 'zod';

export const CredentialSchema = z.object({
  username: z.string(),
  password: z.string(),
});

export type Credential = z.infer<typeof CredentialSchema>;
