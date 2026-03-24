import * as esbuild from 'esbuild';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path to the shared relayer polyfill (parent src/ directory)
const cryptoPolyfill = path.join(__dirname, '..', 'src', 'polyfills', 'crypto.js');

// FakeBuffer — required by Beacon SDK in page context (no Node.js Buffer available)
const fakeBufferBanner = `if (typeof globalThis.Buffer === 'undefined') {
  class FakeBuffer extends Uint8Array {
    toString(encoding) {
      if (encoding === 'hex') return Array.from(this).map(b => b.toString(16).padStart(2,'0')).join('');
      return new TextDecoder().decode(this);
    }
    static from(data, encoding) {
      if (typeof data === 'string') {
        if (encoding === 'hex') {
          const b = new FakeBuffer(data.length / 2);
          for (let i = 0; i < b.length; i++) b[i] = parseInt(data.slice(i*2, i*2+2), 16);
          return b;
        }
        return new FakeBuffer(new TextEncoder().encode(data));
      }
      return new FakeBuffer(data);
    }
    static isBuffer(o) { return o instanceof FakeBuffer; }
    static alloc(size) { return new FakeBuffer(size); }
    static concat(list) {
      const total = list.reduce((s, b) => s + b.length, 0);
      const out = new FakeBuffer(total);
      let offset = 0;
      for (const b of list) { out.set(b, offset); offset += b.length; }
      return out;
    }
  }
  globalThis.Buffer = FakeBuffer;
}`;

// Plugin esbuild : stub les sous-packages @walletconnect/* qui ne sont pas
// installés. Le transport WalletConnect du Beacon SDK n'est jamais utilisé
// dans ce projet (on utilise le transport postmessage vers Temple Wallet).
// Les imports sont remplacés par des modules vides pour ne pas casser le build.
const walletConnectStub = {
  name: 'stub-walletconnect',
  setup(build) {
    build.onResolve({ filter: /^@walletconnect\// }, (args) => ({
      path: args.path,
      namespace: 'walletconnect-stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'walletconnect-stub' }, () => ({
      contents: `
        const _noop = () => undefined;
        export default new Proxy({}, { get: (_, k) => k.startsWith('__') ? undefined : _noop });
        export const getSdkError     = _noop;
        export const parseUri        = _noop;
        export const isNode          = () => false;
        export const isReactNative   = () => false;
        export class IEvents { on(){} off(){} once(){} emit(){} }
        export class IStore  {}
        export class ICore   {}
      `,
      loader: 'js',
    }));
  },
};

const sharedConfig = {
  bundle: true,
  platform: 'browser',
  target: ['es2020'],
  minify: false,
  sourcemap: true,
  outdir: 'dist',
};

await Promise.all([

  // injected.js — runs in page MAIN world; needs same polyfills as the IIFE build
  esbuild.build({
    ...sharedConfig,
    entryPoints: ['src/injected.ts'],
    format: 'iife',
    plugins: [walletConnectStub],
    alias: {
      events:  'eventemitter3',
      crypto:  cryptoPolyfill,
    },
    define: {
      global:                  'globalThis',
      'process.env.NODE_ENV':  '"production"',
      Buffer:                  'globalThis.Buffer',
    },
    banner: { js: fakeBufferBanner },
  }),

  // content.js — isolated world; pas de polyfills nécessaires
  esbuild.build({
    ...sharedConfig,
    entryPoints: ['src/content.ts'],
    format: 'iife',
  }),

  // background.js — service worker; ES module natif, Web Crypto disponible
  esbuild.build({
    ...sharedConfig,
    entryPoints: ['src/background.ts'],
    format: 'esm',
  }),

  // popup.js — page popup de l'extension
  esbuild.build({
    ...sharedConfig,
    entryPoints: ['src/popup.ts'],
    format: 'iife',
  }),

]);

console.log('Build complete → extension/dist/');
