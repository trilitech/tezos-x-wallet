import type {
  BackgroundRequest,
  BackgroundResponse,
  StoredSession,
} from './messages.js';

const STORAGE_KEY = 'tezosx_sessions';

// ── État en mémoire ───────────────────────────────────────────────────────────
//
// Le service worker peut être tué par Chrome à tout moment.
// On maintient un cache en mémoire chargé depuis chrome.storage.local
// au démarrage, et on persiste à chaque modification.

const sessions = new Map<string, StoredSession>();

// Chargement initial depuis le stockage persistant
chrome.storage.local.get(STORAGE_KEY).then((data) => {
  const stored = data[STORAGE_KEY] as Record<string, StoredSession> | undefined;
  if (stored == null) return;
  for (const [origin, session] of Object.entries(stored)) {
    sessions.set(origin, session);
  }
});

function persist(): void {
  const obj: Record<string, StoredSession> = {};
  for (const [origin, session] of sessions) obj[origin] = session;
  chrome.storage.local.set({ [STORAGE_KEY]: obj });
}

// ── Handler des messages ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    msg: BackgroundRequest,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (r: BackgroundResponse) => void,
  ): boolean => {

    switch (msg.type) {

      case 'SESSION_UPDATE':
        if (msg.session === null) {
          sessions.delete(msg.origin);
        } else {
          sessions.set(msg.origin, msg.session);
        }
        persist();
        return false;

      case 'GET_SESSIONS':
        sendResponse({ type: 'SESSIONS', sessions: Array.from(sessions.values()) });
        return false;

      case 'DISCONNECT':
        sessions.delete(msg.origin);
        persist();
        sendResponse({ type: 'OK' });
        return false;

      default:
        return false;
    }
  },
);
