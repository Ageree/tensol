/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Telegram-bot relay URL — POST target for /contact form. Optional. */
  readonly VITE_CONTACT_ENDPOINT?: string;
  /** Telegram bot @handle (without @) used for fallback `t.me/<handle>?start=` deep-link when endpoint unreachable. */
  readonly VITE_CONTACT_TELEGRAM_HANDLE?: string;
  /** Mailto address used as final fallback for the /contact form. */
  readonly VITE_CONTACT_MAILTO?: string;
  /** Clerk publishable key for Vite builds. */
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
