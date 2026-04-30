import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ConfigError, DecryptionError } from './errors.ts';

export interface EncryptedBlob {
  readonly iv: Buffer;
  readonly ciphertext: Buffer;
  readonly authTag: Buffer;
}

export const parseKek = (hexEnvVar: string | undefined): Buffer => {
  if (!hexEnvVar) {
    throw new ConfigError('CREDENTIAL_KEK is not set');
  }
  if (hexEnvVar.length !== 64) {
    throw new ConfigError('CREDENTIAL_KEK must be a 64-character hex string (32 bytes)');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hexEnvVar)) {
    throw new ConfigError('CREDENTIAL_KEK must contain only hex characters');
  }
  return Buffer.from(hexEnvVar, 'hex');
};

export const encryptCredential = (plaintext: string, kek: Buffer): EncryptedBlob => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { iv, ciphertext: encrypted, authTag };
};

export const decryptCredential = (blob: EncryptedBlob, kek: Buffer): string => {
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek, blob.iv);
    decipher.setAuthTag(blob.authTag);
    return decipher.update(blob.ciphertext) + decipher.final('utf8');
  } catch {
    throw new DecryptionError('AES-256-GCM decryption failed: authentication tag mismatch');
  }
};
