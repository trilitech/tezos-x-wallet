# TezosX Relayer — Extension navigateur

Extension Chrome/Brave (Manifest V3) qui injecte automatiquement `window.ethereum` sur toutes les pages, en routant les transactions vers Temple Wallet via le gateway CRAC de Tezos X.

Contrairement à la version IIFE (script injecté manuellement), l'extension est active dès le chargement de la page, sans aucune manipulation côté dApp.

## Prérequis

- **Temple Wallet** installé dans le navigateur
- Réseau **Tezos X Testnet** configuré dans Temple :
  - Nom : `Tezos X Testnet`
  - RPC URL : `https://demo.txpark.nomadic-labs.com/rpc/tezlink`

## Installation (mode développeur)

### Chrome / Brave

1. Ouvrir `chrome://extensions` (ou `brave://extensions`)
2. Activer le **mode développeur** (coin supérieur droit)
3. Cliquer **Charger l'extension non empaquetée**
4. Sélectionner ce dossier (`extension/`)

> **Brave uniquement** : pour éviter un conflit avec Brave Wallet, aller dans
> `brave://settings/web3` → *Wallet par défaut* → sélectionner **Aucun** ou **Extensions**.

### Firefox

Firefox supporte Manifest V3 depuis Firefox 109. La procédure est identique via `about:debugging` → *Ce Firefox* → *Charger un module complémentaire temporaire* → sélectionner `manifest.json`.

## Build

```bash
# Depuis la racine du projet tezosx-relayer/
npm install
npm run build:ext          # produit extension/dist/
```

Après modification des sources, relancer le build puis cliquer **⟳ Actualiser**
dans la page de gestion des extensions du navigateur.

## Architecture

```
extension/
├── manifest.json          Manifest V3
├── popup.html             Interface du popup (sites connectés)
├── src/
│   ├── messages.ts        Types partagés entre les contextes
│   ├── injected.ts        window.ethereum + EIP-6963 (monde MAIN)
│   ├── content.ts         Injection du script + pont page → background
│   ├── background.ts      Service worker : stockage des sessions
│   └── popup.ts           Affichage et déconnexion des sites
└── dist/                  Bundles compilés (généré par build:ext)
```

### Flux de communication

```
Page (window.ethereum)
  │  postMessage  TEZOSX_SESSION_UPDATE
  ▼
content.ts  (monde isolé)
  │  chrome.runtime.sendMessage
  ▼
background.ts  (service worker)
  │  chrome.storage.local
  ▼
popup.ts  (interface utilisateur)
```

La logique métier (Beacon SDK, appels RPC, construction Micheline) s'exécute
entièrement dans le script injecté — dans le même contexte JavaScript que la page.
Cela évite de porter le Beacon SDK dans le service worker (incompatibilité localStorage).

## Utilisation depuis une dApp

L'API est identique à celle de la version IIFE — aucune modification côté dApp.

```javascript
// Connexion
const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });

// Envoi de transaction
const txHash = await window.ethereum.request({
  method: 'eth_sendTransaction',
  params: [{ to: '0x...', value: '0x0', data: '0x...' }],
});

// Adresse Tezos associée (méthode custom)
const [tz1] = await window.ethereum.request({ method: 'tez_getAccounts' });
```

L'extension annonce également le provider via **EIP-6963**, ce qui la rend
compatible avec wagmi v2, RainbowKit et ConnectKit sans configuration supplémentaire.

## Réseau de test

| Paramètre    | Valeur                                          |
|--------------|-------------------------------------------------|
| Nom          | Tezos X Testnet                                 |
| Chain ID     | `0x1f094` (127124)                              |
| RPC EVM      | `https://demo.txpark.nomadic-labs.com/rpc`      |
| RPC L1       | `https://demo.txpark.nomadic-labs.com/rpc/tezlink` |
| Contrat CRAC | `KT18oDJJKXMKhfE1bSuAPGp92pYcwVDiqsPw`         |
