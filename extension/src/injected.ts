import { RelayerProvider } from '../../src/provider.js';
import type { EIP1193Provider, ProviderConnectInfo } from '../../src/types.js';
import type { SessionUpdateMessage } from './messages.js';

declare global {
  interface Window {
    ethereum?: EIP1193Provider & {
      isMetaMask?: boolean;
      isTezosXRelayer?: boolean;
    };
  }
}

// Icône SVG minimaliste pour EIP-6963 (remplace le PNG base64 de l'IIFE)
const PROVIDER_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E" +
  "%3Crect width='100' height='100' rx='18' fill='%232563eb'/%3E" +
  "%3Ctext x='50' y='72' font-size='62' text-anchor='middle' fill='white' font-family='Arial%2C sans-serif'%3ET%3C/text%3E" +
  "%3C/svg%3E";

const PROVIDER_INFO = {
  uuid: '6cfb5e8b-2b9a-4d9f-b8e1-1a2b3c4d5e6f',
  name: 'Tezos X Relayer',
  rdns: 'com.tezosx.relayer',
  icon: PROVIDER_ICON,
} as const;

// ── Session tracking ──────────────────────────────────────────────────────────
//
// On suit la session active localement pour pouvoir l'envoyer au content script
// (et donc au background pour le popup) à chaque changement.

interface TrackedSession {
  tz1Address: string;
  evmAlias:   string;
  chainId:    string;
}

let trackedSession: TrackedSession | null = null;

function postSessionUpdate(session: TrackedSession | null): void {
  const msg: SessionUpdateMessage = {
    type:    'TEZOSX_SESSION_UPDATE',
    session: session,
    origin:  window.location.origin,
  };
  window.postMessage(msg, window.location.origin || '*');
}

// ── Injection ─────────────────────────────────────────────────────────────────

function inject(): void {
  if (typeof window === 'undefined') return;

  const provider = new RelayerProvider();

  // Poser window.ethereum — tente de le verrouiller contre les surcharges
  try {
    Object.defineProperty(window, 'ethereum', {
      value:        provider,
      writable:     false,
      configurable: false,
    });
  } catch {
    // Déjà non-configurable (autre extension présente en premier)
    window.ethereum = provider;
  }

  // Annonce EIP-6963 : Multiple Injected Provider Discovery
  function announceProvider(): void {
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({ info: PROVIDER_INFO, provider }),
      }),
    );
  }
  announceProvider();
  window.addEventListener('eip6963:requestProvider', announceProvider);

  // Annonce legacy (wagmi v1, ethers.js)
  window.dispatchEvent(new CustomEvent('ethereum#initialized'));

  // ── Suivi de session pour le popup ─────────────────────────────────────────
  //
  // accountsChanged arrive avec [evmAlias] à la connexion, [] à la déconnexion.
  // connect arrive avec { chainId } juste après la connexion.

  provider.on('accountsChanged', (accounts: string[]) => {
    if (accounts.length === 0) {
      trackedSession = null;
      postSessionUpdate(null);
      return;
    }

    // Mise à jour partielle : on a l'alias EVM mais pas encore chainId ni tz1
    trackedSession = {
      evmAlias:   accounts[0],
      chainId:    trackedSession?.chainId ?? '',
      tz1Address: trackedSession?.tz1Address ?? '',
    };

    // Compléter avec tz1Address et chainId via des appels non-bloquants
    void Promise.all([
      provider.request({ method: 'tez_getAccounts' }),
      provider.request({ method: 'eth_chainId' }),
    ]).then(([tz1Accounts, chainId]) => {
      if (trackedSession == null) return;
      trackedSession.tz1Address = Array.isArray(tz1Accounts) ? String(tz1Accounts[0] ?? '') : '';
      trackedSession.chainId    = String(chainId ?? '');
      postSessionUpdate(trackedSession);
    }).catch(() => {
      // Envoyer ce qu'on a même si les appels échouent
      postSessionUpdate(trackedSession);
    });
  });

  provider.on('connect', (info: ProviderConnectInfo) => {
    if (trackedSession != null) {
      trackedSession.chainId = info.chainId;
      postSessionUpdate(trackedSession);
    }
  });

  provider.on('disconnect', () => {
    trackedSession = null;
    postSessionUpdate(null);
  });

  console.info('[TezosX Relayer] window.ethereum injected (extension) ✓');
}

inject();
