import type { SessionUpdateMessage, BackgroundRequest } from './messages.js';

// ── 1. Injection du relayer dans le monde MAIN de la page ─────────────────────
//
// On injecte injected.js via un <script> tag afin qu'il s'exécute dans le
// contexte JavaScript de la page (même window que le dApp), ce qui est
// nécessaire pour poser window.ethereum.

const script = document.createElement('script');
script.src = chrome.runtime.getURL('dist/injected.js');
(document.head ?? document.documentElement).prepend(script);
script.addEventListener('load', () => script.remove(), { once: true });

// ── 2. Pont page → background (notifications de session) ─────────────────────
//
// On écoute uniquement les messages de type TEZOSX_SESSION_UPDATE émis par
// injected.ts. On ne relaie PAS d'appels RPC : la logique métier s'exécute
// entièrement dans le script injecté.

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
