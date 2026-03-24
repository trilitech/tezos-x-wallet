// ── Types partagés entre injected.ts, content.ts, background.ts et popup.ts ──

/**
 * Session active pour un site connecté.
 * Stockée dans chrome.storage.local, indexée par origin.
 */
export interface StoredSession {
  tz1Address: string;
  evmAlias:   string;
  chainId:    string;
  origin:     string;
  connectedAt: number;  // timestamp ms
}

// ── Page (injected) → Content script ─────────────────────────────────────────

/**
 * Notification de changement de session émise par injected.ts via postMessage.
 * Interceptée par content.ts et transmise au background.
 */
export interface SessionUpdateMessage {
  type:    'TEZOSX_SESSION_UPDATE';
  session: Omit<StoredSession, 'origin' | 'connectedAt'> | null;
  origin:  string;
}

// ── Content script → Background (et Popup → Background) ──────────────────────

export type BackgroundRequest =
  | { type: 'SESSION_UPDATE'; session: StoredSession | null; origin: string }
  | { type: 'GET_SESSIONS' }
  | { type: 'DISCONNECT'; origin: string };

// ── Background → Popup ────────────────────────────────────────────────────────

export type BackgroundResponse =
  | { type: 'SESSIONS'; sessions: StoredSession[] }
  | { type: 'OK' };
