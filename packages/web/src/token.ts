const KEY = "lgtm-token";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Extracts the token from a `#k=<token>` fragment; null when absent or malformed. */
export function tokenFromHash(hash: string): string | null {
  const m = /^#k=([0-9A-Za-z_-]{16,256})$/.exec(hash);
  return m ? m[1]! : null;
}

export interface TokenState {
  token: string | null;
  /** True when the fragment held a token and must be stripped from the address bar. */
  stripHash: boolean;
}

/**
 * The fragment token wins and is persisted in the (per-tab) store; otherwise fall back to the stored one.
 * Storage may be unavailable (blocked, private mode); then the token only lives in memory.
 */
export function resolveToken(hash: string, store: KeyValueStore | null): TokenState {
  const fromHash = tokenFromHash(hash);
  if (fromHash) {
    try {
      store?.setItem(KEY, fromHash);
    } catch {
      /* keep in memory only */
    }
    return { token: fromHash, stripHash: true };
  }
  let stored: string | null = null;
  try {
    stored = store?.getItem(KEY) ?? null;
  } catch {
    stored = null;
  }
  return { token: stored, stripHash: false };
}

export function sessionStore(): KeyValueStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
