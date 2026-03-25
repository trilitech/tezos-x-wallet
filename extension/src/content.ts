import type { SessionUpdateMessage, BackgroundRequest } from './messages.js';

// ── Pont page → background (notifications de session) ────────────────────────
//
// injected.ts est désormais déclaré world:"MAIN" dans le manifest : le
// navigateur l'injecte lui-même de façon synchrone, avant tout script de la
// page. Ce content script (world:"ISOLATED") se charge uniquement de relayer
// les changements de session vers le background pour affichage dans le popup.

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;

  const msg = event.data as Partial<SessionUpdateMessage>;
  if (msg?.type !== 'TEZOSX_SESSION_UPDATE') return;

  const req: BackgroundRequest = msg.session !== null
    ? {
        type:    'SESSION_UPDATE',
        session: { ...msg.session, origin: msg.origin, connectedAt: Date.now() },
        origin:  msg.origin,
      }
    : { type: 'SESSION_UPDATE', session: null, origin: msg.origin };

  chrome.runtime.sendMessage(req).catch(() => {
    // Le background peut ne pas être encore prêt (ex: premier chargement).
    // On ignore silencieusement.
  });
});
