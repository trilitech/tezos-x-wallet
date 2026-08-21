# Changelog — @tezosx/wallet-mobile

The Tezos X wallet for iOS/Android (React Native, Expo bare). Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/). The app consumes the
shared `@tezosx/wallet-core` over the workspace; only platform adapters
(storage, secure RNG, biometrics) and the UI live here.

## [0.7.0] — 2026-08-19

### Added
- **`expo-dev-client` and an explicit `tezosx` URL scheme**, so the dev loop
  targets the development build instead of Expo Go. `npx expo start` now
  launches the real app (Expo Go cannot load the Nitro/MMKV/Keychain native
  modules at all, and Expo Go for SDK 56 is not published on the stores),
  and the dev-client launcher lets a **physical device** point at any Metro
  server by URL — previously the server address was baked into the device
  build at compile time, so every network change meant a full rebuild. The
  scheme also repairs the QR/terminal launch: with both native projects
  present, the CLI intersects their URL schemes, and Android had none.

### Security
- **Biometric unlock actually works.** iOS requires an `NSFaceIDUsageDescription`
  purpose string before an app may evaluate a biometric policy; the app never
  declared one, so `getSupportedBiometryType()` resolved null, the wallet
  concluded the device had no biometrics, and no Face ID prompt was ever shown —
  on any device. It was invisible in development because an unenrolled
  simulator returns that same null. The string is now declared, so Face ID
  unlocks the vault and gates transfer/approval confirmation as designed.
- The app no longer requests microphone or audio-recording access. Those came
  from `expo-camera`'s defaults; the camera is used only to scan WalletConnect
  QR codes, and a wallet should not ask for permissions it never exercises.

### Fixed
- **Token balances update when switching accounts.** Switching never asked for
  the new account's EVM address to be resolved, and the ERC-20 reads are
  skipped while it is unknown — so the token rows of an account whose address
  had never been resolved stayed on a dash indefinitely, with nothing to heal
  them. The switch now triggers that resolution, as the extension already did.
- Activity could be stored under the wrong account. The read used whichever
  account's session happened to be warm at that moment while labelling the
  result with the newly selected account, so one account's history could be
  persisted as another's; the read now waits for the session that actually
  belongs to the account being read.
- A failure while warming the new account's session no longer prevents the
  switch from being persisted — reopening the wallet could land back on the
  previous account.
- **Step titles are readable.** The header title of the onboarding and
  add-account flows had no colour of its own, so it rendered in the platform
  default — black on the dark background, i.e. invisible. The transaction hash
  on the send confirmation screen was invisible for the same reason.
- **The keyboard no longer hides the password field.** The unlock screen's
  scroll body had no keyboard handling and no scroll range, so the field being
  typed into sat behind the keyboard with no way to reach it. Screens that host
  a text input now use a shared scroll primitive that insets itself by the
  keyboard's measured overlap, and bottom sheets lift above it — which also
  fixes the six sheet inputs (change password, reveal secret, remove account,
  rename contact, dApp URI) that were covered the same way. A first tap on a
  button while the keyboard is up now registers instead of being swallowed by
  the dismissal.
- The lock screen offers biometric unlock as soon as the seal exists. Whether
  biometrics were available was read once at startup, so a wallet created or
  reset in the same session showed no biometric option until the app was
  relaunched — and after a reset the option lingered over a cleared seal.

### Security
- **The approval screen shows the origin's scheme.** The dApp origin was
  reduced to its bare hostname, so `http://victim.example` was
  indistinguishable from the legitimate `https://victim.example` while
  approving a connection or a transaction. Origins now render through the
  shared display rule: https keeps a clean `host`, anything else shows the
  full `scheme://host[:port]`. The Connections list follows the same rule.

### Fixed
- **Activity day sections follow the calendar.** "Today" was a sliding
  24-hour window, so yesterday-evening transactions showed under "Today".
  Sections now split at local midnight, like the extension.
- **Max keeps room for the fee.** The Max button set the full XTZ balance,
  so the transfer failed on balance_too_low at signing; it now reserves the
  same fee headroom as the extension.
- **The review and done screens show the exact amount.** They went through
  locale formatting, which rounds — a 1-mutez transfer reviewed as "0.00".
  Both now render the typed amount exactly, the same fix the extension
  shipped in 0.18.0.
- Balances share the extension's display convention (grouped thousands,
  2–6 fraction digits, truncated) on exact string math — no more float
  round-trip on large balances.

### Changed
- Internal: the local formatting module dissolved into `@tezosx/wallet-core`
  (`shortAddr`, `formatBalanceDisplay`, `timeAgo`, amount parsing, validation
  shapes, shared constants) — one implementation for both shells. The two
  relative-time formats that coexisted on the Activity screen are gone.

### Compatibility
- Requires `@tezosx/wallet-core` 0.9.0 and `@tezosx/relayer` 0.9.0.

## [0.6.0] — 2026-08-19

### Changed
- **Activity rows lead with the asset's real logo**, mirroring the
  extension: the transferred asset's brand mark (Tezos mark, Circle USDC
  logo, monogram for unknown tokens) with a direction badge in the corner —
  an ✕ on failure — inside the unchanged runtime ring. Contract calls,
  signatures and unknown items center a stroke icon from the shared set.

### Fixed
- Token balances on Home were rounded to two fraction digits, so anything
  under 0.005 displayed as "0.00". They now show up to six fraction digits,
  like the XTZ headline.
- Through `@tezosx/wallet-core` 0.8.0: transaction status no longer trusts
  TzKT answers whose operation hash doesn't match the submitted one (false
  "finalized"/"failed" reports), and zero-XTZ NAC gateway calls no longer
  render as "−0 XTZ" transfers in Activity.

### Compatibility
- Requires `@tezosx/wallet-core` 0.8.0.

## [0.5.0] — 2026-08-18

### Security
- **Auto-lock always arms after a successful unlock.** A failure in the
  post-unlock tail (network state read, WalletConnect boot) used to reject
  the unlock flow after the vault was already decrypted: the UI stayed on the
  lock screen while the keyring sat unlocked in memory, and the auto-lock
  (background + idle) never armed — decrypted key material was retained
  indefinitely. The tail is now reject-proof once the decrypt succeeds, and
  the view transitions from keyring truth.

### Fixed
- **Unlock works offline.** The password path surfaced a generic "Operation
  failed" (React Native's network failure string wasn't classified) and the
  biometric path failed in complete silence — Face ID succeeded, the vault
  decrypted, and nothing happened. Unlock now completes with no network;
  biometric failures other than user cancel are surfaced through the standard
  error card; onboarding create/import no longer strands the user offline.
- A failed balance read renders '—' — never "0 XTZ", which reported a false
  balance.
- Create flow, EVM path: Back from "Set password" landed on a screen titled
  "Private key" showing a Tezos recovery-phrase grid, and the step dots
  overflowed. Navigation is now driven by a per-kind stage list, so dots and
  stages cannot disagree.
- The seed-confirmation quiz picks proportional word positions from the
  actual phrase length (shared core helper) instead of the fixed positions
  3/7/11, which verified nothing beyond word 11 on longer phrases.
- Import validates input for real (BIP-39 mnemonic / edsk / 64-hex private
  key, matching the extension) instead of accepting anything over 8
  characters.

### Changed
- The EVM alias is read from the shared in-memory alias cache and reported as
  null until the background resolution lands; screens show a "Resolving EVM
  address…" placeholder (Receive withholds the QR rather than encoding a
  wrong address). The cache survives lock — aliases are immutable public
  mappings — and clears on wallet reset. The separate network-free boot read
  (`read-state.ts`) is gone: core `getState` now is that read, and boot gains
  real account summaries.

### Added
- **Offline continuity.** The EVM alias map persists in MMKV (resolved once
  per address, ever); balances and the first activity page are snapshotted
  with their fetch time and rendered offline under an explicit "updated X
  ago" band — "You're offline" (NetInfo) or "Can't reach the Tezos X
  network" (RPC down). Activity distinguishes "No activity yet" from "Can't
  reach the network" with a Retry; regaining connectivity triggers an
  automatic refresh and alias backfill. Send's confirm step gates on
  connectivity before the biometric prompt; the approval sheet announces
  offline while keeping Reject available.
- **A guided add-account flow**, identical decision tree to the extension:
  hero "Recommended · Next account from your seed phrase" with the runtime
  as the only remaining question (2-tap default), advanced paths behind
  "More ways to add an account", step math from the shared core view-model.
  Reaches safety parity with the extension: two acknowledgements, reveal
  overlay, discard-unbacked-key interception, duplicate detection with
  "Switch to it", real address preview on confirm, and the account cap.

### Compatibility
- Requires `@tezosx/wallet-core` 0.7.0 and `@tezosx/relayer` 0.8.0.

## [0.4.0] — 2026-08-10

### Added
- **Change password** from Settings → Security (Sheet with current/new/confirm,
  same validation as onboarding, fields scrubbed on any way out).
- **Forgot-password recovery** behind the Unlock screen's "Forgot password?"
  affordance — previously it only routed to onboarding, leaving the old vault,
  sessions, throttle state and the Keychain-sealed password in place. It now
  shows the explicit recovered / not-recovered / kept checklist (seed-derived
  accounts re-importable at the same addresses; imported edsk and EVM keys and
  labels are not recoverable from the phrase; contacts are kept), requires an
  acknowledgement, then wipes and lands on onboarding.

### Security
- **Biometric unlock follows a password change.** Changing the password
  re-seals the Keychain-held unlock secret with the new password in the same
  operation — without this the keystore would keep releasing the old one and
  biometric unlock would silently break. If the re-seal fails (enrolment
  changed, keystore refusal), the sealed secret is cleared instead, degrading
  biometrics to manual password entry rather than ever replaying a stale
  password. The recovery wipe likewise clears the sealed secret, so nothing in
  the keystore outlives the vault it opened. Both paths are covered by
  vault-actions tests.

## [0.3.0] — 2026-08-10

### Added
- **Contacts.** The wallet gains an address book: save a tz1 or 0x address
  under a name and manage the list from Settings → Contacts (add, rename,
  remove — validation runs through the core validators, so a mistyped EIP-55
  checksum is refused). In the Send flow the recipient field suggests matching
  contacts while you type, a recipient that is a contact shows its name
  instead of only a truncated address (form and review), and after sending to
  an unknown address the success screen offers to save it. Storage is a new
  `MmkvContactStore` behind the core's `ContactStore` port. Contacts are
  non-secret metadata (public addresses and labels); like sessions and tokens
  they are currently stored plaintext in MMKV and will join the tracked
  at-rest metadata encryption follow-up (Keychain-held `encryptionKey`) when
  it lands.

### Changed
- The activity rows' runtime tag colours now come from the theme (`purpleText`,
  `cyanText`, and a new `crossText` token — the midpoint of the purple→cyan
  sweep the identicon ring draws) instead of hex literals local to the
  component. No behaviour change; the Michelson/EVM tags align on the shades
  the badges already use.

### Compatibility
- Workspace dependency ranges follow the shared packages' release cut:
  `@tezosx/wallet-core` `^0.5.0` and `@tezosx/relayer` `^0.7.0`. No behaviour
  change — the app was already consuming this code over the workspace link.

## [0.2.0] — 2026-07-12

> **Versioning note.** Builds before this release carried a `1.x` version
> inherited from the Expo template, not a maturity statement — this repo
> reserves `1.0.0` for the first mainnet-ready release. The package is private
> and never published, so it is re-baselined here onto the `0.x` scale the
> other packages use: the initial end-to-end build corresponds to `0.1.0`, and
> this release (previously labelled `1.1.0`) ships as `0.2.0`.

### Security
- Security-review remediation (mobile arm):
  - **Unlock throttle** via the core `UnlockGuardStore` (`MmkvUnlockGuardStore`)
    — repeated wrong passwords arm a persisted, capped lockout.
  - **Account switch no longer re-points connected dApps.** The earlier
    "dApps follow the active account" behaviour re-wrote every WalletConnect
    session to the newly-active account and announced it to all of them — it
    disclosed an account to origins that never authorized it. Switching now
    tells connected dApps nothing (each keeps the account it connected with);
    removing an account tears down only that account's sessions.
  - **Cross-runtime resolution state persists** in MMKV (`MmkvPendingOpsStore`),
    so a Send timeline survives a lock or account switch mid-resolution.
  - **Dev logging can no longer leak on device.** The shared `devLog` now keys
    off React Native's `__DEV__` (false in release builds) rather than only
    `process.env.NODE_ENV`, which Metro/Hermes may leave undefined — a release
    build no longer risks logging signed transaction payloads.
  - **MMKV at-rest encryption (`encryptionKey`) is still deferred.** The vault
    blob itself is AES-256-GCM encrypted, but sessions/tokens remain plaintext
    in MMKV. Adding a Keychain-held key requires an async composition-root
    bootstrap plus a plaintext→encrypted migration for existing installs, and is
    tracked as its own on-device change.
- Locking the wallet (manually, on idle timeout, or on backgrounding) now also
  clears the in-memory container cache, so decrypted signing keys held by live
  signers — including Taquito's internal copy — no longer outlive the lock.
  The extension already did this in its LOCK handler; the mobile shell's
  single long-lived JS thread made the omission persistent rather than
  transient, since no service-worker death ever evicted the cache. The lock
  now also drops the warm active-container reference and the alias caches
  synchronously in the same call, mirroring the extension's LOCK handler
  exactly — previously the warm reference was released only by a scheduled
  rebuild, leaving a brief window after lock during which a caller could still
  reach the dead container. A test suite pins the contract: once `lockWallet`
  returns, no composition-level path leads back to a signer. Honest limits:
  JavaScript strings cannot be zeroized in place, so the guarantee is
  unreachability (then garbage collection) rather than erasure, and references
  held by an operation already in flight live until that operation settles.
- Screens drop secret-bearing state as soon as their flow completes: Unlock
  clears the password on success (not only on error), Create / Import / Add
  account clear the mnemonic, private key and passwords once the vault
  operation lands (and Add account also when backing out of the input step),
  and the reveal sheet scrubs its password immediately after a successful
  export, scrubs everything on any way out, and auto-closes 30 seconds after
  showing a secret. JavaScript strings cannot be overwritten, so this shortens
  how long secrets stay referenced rather than guaranteeing erasure. The
  native crypto port now also zeroizes its transient buffers (the PBKDF2
  output's native Buffer, the AES decrypt chunks) once copied.

### Added
- **Account removal.** Each row of the account switcher carries a trash
  affordance opening a password-gated confirm sheet (the vault re-verifies the
  password; the last account cannot be removed). Removing the active account
  re-scopes to the oldest remaining one and re-points connected dApps at it —
  stored sessions rebound, WalletConnect namespaces updated, `accountsChanged`
  emitted — exactly like an account switch.
- **HD accounts from the wallet seed phrase.** When the vault holds a wallet
  seed (any wallet onboarded from a mnemonic), Add account leads with two new
  default cards — "Next account from your seed phrase" for Tezos and EVM —
  that derive the next unused index (`m/44'/1729'/i'/0'` / `m/44'/60'/0'/0/i`)
  with nothing new to back up, skipping the reveal step entirely. The previous
  create cards remain as "New separate seed phrase (advanced)". Settings gains
  a "Reveal seed phrase" row (password-gated, same sheet) for the wallet-level
  phrase; the per-account reveal now always shows the concrete signing key.
  Existing vaults keep working untouched — they simply don't show the derived
  cards, since no phrase was ever blessed as the wallet seed.

### Fixed
- **The cross-runtime Send timeline reported "Included" only when the
  transfer was already final.** Tracking used to start only after the
  synthetic hash resolved to the kernel-synthesized EVM hash — and by then the
  receipt's block had usually reached the finalized tag, so the timeline sat
  on "Broadcasted" for the whole inclusion window and then lit "Included" and
  "Finalized" in the same instant. The gateway path now returns the underlying
  L1 operation hash and a dedicated tracker drives "Included" from that
  operation's inclusion on TzKT (~one L1 block after the send), handing over
  to the L2 receipt for "Finalized" once the real hash resolves. Each step now
  lights up when the thing it names actually happened.
- **The status timeline marks a reached step complete and pulses the next one**,
  so "Included" turns green on inclusion instead of only at finality (it used
  to stay purple until "Finalized" lit at the same moment).
- **ERC-20 sends from a tz1 account** now sign a real `transfer(address,uint256)`
  scaled by the token's decimals (was the raw amount as 18-decimal calldata).
- **A sub-mutez native transfer amount is rejected** instead of silently
  floored to 0.
- **The Send recipient validator is the strict core one** — `tz1abc` or a short
  `0x123456` no longer pass; only canonical addresses do.
- **The Receive QR is a real, scannable code** (`react-native-qrcode-svg`)
  instead of a decorative grid.
- **The Settings version is sourced from `package.json`** (was a hardcoded,
  stale string).
- **The Send amount field rejects invalid input** (a second decimal point, a
  letter) instead of mutating what you typed.
- **A "What you actually sign" card** appears on the Send review for a
  cross-runtime transfer — the NAC gateway target, the entrypoint
  (`call` / `call_evm`), the ERC-20 method when applicable, and the mutez debit.
- **The recovery-phrase screen notes what the seed doesn't cover** — a Tezos
  secret key or EVM private key imported separately isn't derived from the
  phrase and must be backed up on its own.

### Changed
- **Runtime naming.** No shipped string presents the two runtimes as layers
  anymore: the chain pills, address badges and Add-account badges say
  "Michelson" / "EVM", the activity tags and filters say "Michelson runtime" /
  "EVM runtime", the routing card says "Same-runtime · Michelson runtime",
  "Cross-runtime · Michelson → EVM via NAC gateway", "Same-runtime · Tezos X
  (EVM)" and "Cross-runtime · EVM → Michelson via NAC precompile", and the
  Send / Approve explainers describe "a Michelson-runtime operation" instead
  of "an L1 op".
- Vault crypto now runs natively via `react-native-quick-crypto` (OpenSSL /
  BoringSSL over Nitro/JSI), replacing the pure-JS `@noble` CryptoPort for the
  mobile vault. Unlocking a vault runs a 600k-iteration PBKDF2 to decrypt it; on
  Hermes' pure-JS crypto that ground the JS thread for seconds — an unavoidable
  stall in JS, since deriving the key *is* the unlock. Native crypto runs the
  same PBKDF2 in OpenSSL and brings unlock into the sub-second range. The vault
  envelope is unchanged — PBKDF2-HMAC-SHA256 at 600k, AES-256-GCM,
  ciphertext‖16-byte-tag, no AAD — and stays byte-for-byte identical to the
  extension's Web Crypto vault: `react-native-quick-crypto` is a `node:crypto`
  drop-in, and `node:crypto` is already proven byte-identical to `@noble` / Web
  Crypto at 600k by the cross-impl recipe test (`quick-crypto-port-byte-compat`).
  Randomness now comes from the native OpenSSL CSPRNG. The `@noble` port stays in
  the tree as a fallback; Nitro (the runtime quick-crypto needs) was already
  present via `react-native-mmkv`, so no new native runtime is introduced.

  This adds a native dependency, so it needs a dev build (Nitro/JSI cannot run in
  Expo Go). After pulling the branch:
  ```
  npx expo install react-native-quick-crypto react-native-quick-base64 expo-build-properties
  npx expo prebuild --clean
  npx expo run:ios      # or run:android
  ```
  Manual on-device test (the native module cannot load under Vitest, so the
  byte-compat guarantee is completed on-device):
  1. Create/import a wallet, lock, then unlock — confirm unlock is now fast
     (sub-second) and balances load.
  2. Cross-device round-trip at the production 600k factor: seal a vault on
     mobile and confirm the Chrome extension opens it with the same password,
     and vice versa (the shared vault envelope must stay portable).
  3. Enter a wrong password — confirm unlock is rejected (native GCM tag mismatch
     fails closed).

### Fixed
- Connected dApps now follow an account switch. Switching accounts re-points
  every live WalletConnect session — its approved namespace accounts, and the
  per-origin stored session that `eth_accounts` answers from — at the newly
  active account, and emits `accountsChanged` so the dApp updates too.
  Previously the switch told the dApp nothing: it kept displaying (and
  addressing) the account approved at connect time, while the Approve sheet and
  the signature underneath used the newly active one.
- The total-balance unit rendered the ꜩ ligature as text, but the on-device font
  has no glyph for that codepoint (U+A729) so it showed as a tofu box next to the
  amount. It now renders the `TezosGlyph` SVG mark — font-independent, the same
  mark the asset rows use — so the ꜩ displays correctly.

### Added
- Instant account switching + corrected iconography. Switching accounts no
  longer stalls the UI for seconds. The stall was a full 600k-PBKDF2 vault
  re-encrypt on every switch — the keyring persisted the (non-secret) active
  pointer by re-sealing the whole vault, which on Hermes' pure-JS crypto took
  seconds. The keyring now flips the active pointer in memory (a synchronous,
  crypto-free swap that keeps a subsequent send bound to the right account) and
  the switch re-scopes the UI immediately from the target account's summary (its
  EVM alias is already resolved there, so no network round-trip and no key
  derivation on the tap — the per-account signing key is re-derived lazily, a
  negligible cost, and cached). The vault re-seal that persists the active
  pointer no longer runs on the tap; it is flushed off the interaction path in
  the background — a PBKDF2 re-encrypt that is cheap now the crypto port is
  native — so the selected account still survives a lock while the switch stays
  instant.
  Redrew the icons that were rendering as incomplete glyphs: settings (a real
  gear, was a bare circle), lock (a full padlock, was just the shackle), link (a
  proper chain — used by Connected sites and the dApps tab) and info (an "i" in a
  circle, was just the "i").
- Reconciliation cleanup + tests (final step). Removed the mock data layer
  (`src/mocks`) now that every screen runs on the live composition — no screen
  imports fixtures anymore. Added a Vitest suite (node env, `test` / `test:watch`
  scripts) covering the pure view-models: the `ActivityItem` → row mapping
  (including the amount-scaled-by-decimals conversion that a units bug slipped
  through earlier) and the `ViewAccount` adapter over `AccountSummary` /
  `VaultStateUnlocked`.
- Real dApp surface behind the design (fifth reconciliation step). The Approve
  sheet and Connections screen run on the live WalletConnect transport + the core
  approval queue instead of mocks. Scanning a dApp's WalletConnect QR with the
  camera — or pasting its `wc:` link — on Connections pairs over the relay; the
  incoming proposal (and any `eth_sendTransaction`)
  routes through the shared core dispatch, which suspends on the Approve sheet —
  now driven by the real pending request (observed via `approvalUi`, resolved off
  the ApprovalQueue), showing the actual origin, the pinned account, and for a
  cross-runtime transaction both the dApp's EVM intent and the Michelson gateway
  call the tz1 actually signs. Approving is gated behind the same per-signature
  biometric confirm the Send flow uses (fail-closed; a no-op on password-only
  devices), then resolves the request so the dApp gets its answer; rejecting or
  dismissing the sheet answers the dApp with a rejection. Connections lists the
  live per-origin sessions and keeps them fresh as they come and go; revoking one
  tears down both the WalletConnect session and the stored per-origin entry.
  WalletConnect boots on unlock and restores previously-approved sessions. A
  request the runtime can't satisfy — an EVM message signature (`personal_sign`
  / typed data), which a tz1 account has no key for — is rejected promptly (4200)
  instead of surfacing an approval that would fail. Connecting asks how to pair —
  scan the dApp's WalletConnect QR (camera, via `expo-camera`) or paste its link.

  Manual test — pairing with the playground (`playground/`): set
  `NEXT_PUBLIC_WC_PROJECT_ID` in `playground/.env.local` and run `npm run dev`
  there. On the phone (dev build, `EXPO_PUBLIC_WC_PROJECT_ID` set, tz1 funded
  with a couple of tez), unlock first — WalletConnect boots on unlock (Metro
  logs `[wc] WalletKit initialised`) — then Connections → scan the playground's
  QR (or paste the copied `wc:` link) and approve. Drive the Counter panel and
  a transfer from the browser; each `eth_sendTransaction` raises the Approve
  sheet. The hash the dApp receives from a tz1 account is a synthetic NAC hash
  the public RPC never indexes — verify by re-reading state (counter value,
  balances, ~15-40 s), not by receipt lookup.
- Real Send flow (fourth reconciliation step). The review's Confirm & send now
  calls the core `sendTransfer` through the active account's warm container
  instead of fabricating a hash: a tz1 → tz1 transfer returns the L1 op hash; a
  tz1 → 0x cross-runtime transfer returns a synthetic NAC hash that the screen
  then resolves to the real EVM hash by polling `resolveTx` (2s, up to 60s,
  falling back to the intermediate hash if the kernel mapping hasn't
  materialised); an EVM-account send returns the real hash directly. Signing is
  gated behind a per-signature biometric confirm (Face ID / Touch ID; a no-op on
  password-only devices, fails closed otherwise). The done screen's
  StatusTimeline is driven by the real `trackTx` (TzKT for L1 inclusion /
  finality, the Tezlink EVM RPC for L2), replacing the cosmetic timers; a failed
  or unavailable status surfaces an ErrorCard, and the hash line links out to
  tzkt / blockscout. The human amount is converted to hex wei and the screen's
  asset selection mapped to the core Asset union at the seam; the resolve and
  track pollers stop on unmount. The status timeline now marks its final
  "Finalized" step complete on finality (it previously stayed on the pulsing
  active step, as the renderer had no state beyond finalized), and long detail
  values (the cross-runtime routing line) and large amounts wrap instead of
  overflowing their rows.
- Account and token management, wired to the vault (third reconciliation step).
  Add Account now creates a real account in the unlocked vault — a fresh 24-word
  Tezos mnemonic or a fresh EVM key (the phrase the user reveals and backs up is
  exactly the one persisted, never a divergent keyring-minted one), or an
  imported mnemonic / edsk / 0x key, each validated before submit — then makes it
  active so Home re-scopes to it. Add Token reads a contract's symbol / name /
  decimals straight from chain (a non-persisting peek) to preview before
  committing; a contract that doesn't answer `decimals()` offers a "Try anyway"
  path that registers it at 18 decimals, and duplicate / cap / invalid-address
  failures surface through `formatError`. Manage-tokens removes a registered
  ERC-20 (the built-in USDC seed stays protected). Each mutation warms the active
  account's container and refreshes the affected reads. Reveal-secret was already
  live per-account; renaming an account is the one remaining account operation,
  deferred until it has a design surface.
- Live balances, tokens and activity behind the design (second reconciliation
  step). Home, Tokens, Send and Activity now read the active account off a
  per-account data effect (`use-account-data`) instead of fixtures: the L1 XTZ
  balance from TzKT (or, for an EVM account, its balance from the Tezlink RPC),
  each registered ERC-20's balance on the account's EVM alias, the token
  registry, and the merged TzKT + Blockscout activity feed. Each is surfaced as
  loading / value / error — a spinner while a read is in flight, an `ErrorCard`
  (through `formatError`) when one fails. Activity items map through a pure
  `activity-vm` into the row shape the list renders; the stale band now reflects
  the feed's real staleness rather than always showing; and the header Refresh
  re-runs the reads. Switching accounts warms that account's container and
  re-scopes every read, and locking drops the container and clears the slices.
- Real vault lifecycle behind the design UI (first reconciliation step). The
  WalletContext is now the app's composition root over the live keyring: a
  network-free boot Gate resolves onboarding / locked / unlocked; Create
  generates a real BIP-39 mnemonic (or EVM key) and persists it; Import brings in
  a mnemonic / edsk / 0x key; Unlock is biometric-first (Face ID / Touch ID
  releases the sealed password) with a password fallback; lock + auto-lock evict
  the secret; Settings reveals the real secret via exportSecret. Errors surface
  through formatError. Accounts render through a ViewAccount adapter over the core
  AccountSummary / accountCardVM (identicons seed on the address). dApp sessions
  are still a shim — wired in a later step.
- Full in-app design pass — the extension's UI recreated natively. A React Native
  design system (the stroke icon set via `react-native-svg` + ~30 pure `ui/tx`
  components) and every screen: Welcome, Create, Import, Unlock, Home, Send,
  Receive, Activity, Connections, Approve, Settings, AccountSwitcher, AddAccount,
  AddToken, Tokens — behind a tab + modal-stack shell with sheets and toasts. The
  theme is realigned to the extension's exact `--tx-*` tokens, and the XTZ / USDC
  / Tezos X brand logos are the same assets the extension ships (copied into
  `src/assets/logos`). It is driven by mock data through a single `WalletContext`
  seam, so reconnecting the live composition (keyring / balances / WalletConnect)
  is a data-layer change. This replaces the earlier WalletConnect-wired screens,
  which remain in git history and whose modules (`composition`/`transport`/
  `adapters`) stay in the tree for that reconnection. `theme.ts` is realigned to
  the design's exact `--tx-*` palette, spacing, radii and type scale (the mobile
  palette had drifted).
- WalletConnect: connect an external dApp. Paste a dApp's `wc:` URI on Home to
  pair (Reown WalletKit over the relay); the incoming session proposal is routed
  through the shared core `dispatch` exactly as the extension routes a content-
  script request — minted requestId, the peer's url as the verified origin, an
  `eth_requestAccounts` envelope — which raises an in-app Approve modal. On
  approval the core resolves the account's EVM alias and writes the per-origin
  session, and the WC session is approved declaring `eip155:128064` (Tezos X EVM,
  previewnet) with that alias; `eth_accounts` is answered from the session over
  the same dispatch. Pairing is by pasted URI (no camera); the dApp must be open
  while pairing (no background reconnect yet).
- WalletConnect signing: a connected dApp can request `eth_sendTransaction`. For
  a tz1 account this routes through the NAC gateway (cross-runtime L1 → L2) over
  the same core dispatch; the Approve modal shows the dApp's EVM intent (to /
  amount) alongside what actually gets signed (the Michelson gateway call and the
  mutez debited), and the approval is gated behind a per-signature biometric
  confirmation (Face ID / Touch ID via the keystore). `personal_sign` is not
  offered on a tz1 account — the runtime can't produce one — so it is omitted
  from the session methods rather than surfaced and rejected.
- A single-chain approval strategy for WalletConnect: the wallet offers
  `eip155:128064` (its only chain) directly when a dApp doesn't request it,
  rather than reconciling to nothing; a mainnet-only dApp with hard requirements
  still declines on its side.
- A Connections screen (reachable from Home) listing the live WalletConnect
  sessions — dApp name, url, and the account exposed to each — with per-session
  disconnect from the wallet side. Revoking tears down the WC session (notifying
  the dApp) and, via a reconcile that runs whenever the session set changes,
  clears the stored session that gates `eth_accounts`. The same reconcile drops
  sessions a dApp revoked while the app was closed. WalletKit restores
  previously-approved sessions from its own storage on boot, so a dApp connected
  before the app closed reconnects when the wallet reopens.
- The mobile composition now builds the full `SwDeps` (container cache, approval
  queue with a mobile `ApprovalPresenter`, provider-event broadcast over WC), so
  the dApp surface reuses the core routing rather than a parallel implementation.
  `react-native-compat` is imported first in the entry; `@walletconnect/core` and
  `@walletconnect/types`/`utils` are pinned to 2.23.9 (matching WalletKit) and
  scoped to this package so the relayer's Beacon chain keeps its own copy.
- Import → unlock → balances, on-device. Import a BIP-39 mnemonic: derive the
  tz1 identity, encrypt the vault locally (PBKDF2 600k + AES-GCM via the @noble
  crypto port, randomness from `react-native-get-random-values`), persist the
  encrypted blob to MMKV, and seed the default tokens. Unlock by biometrics or
  password. Home reads real balances from previewnet — L1 XTZ (TzKT) plus ERC-20
  tokens on the EVM alias for a Tezos account.
- Two-layer storage: the encrypted vault blob, dApp sessions and the token
  registry live in MMKV (`react-native-mmkv`); the unlock password is sealed in
  the OS keystore (`react-native-keychain`) behind biometrics, bound to the
  device (`WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`, no iCloud sync) and invalidated
  by the OS when the biometric enrolment changes (`BIOMETRY_CURRENT_SET`), with
  password fallback.
- Auto-lock: the decrypted secret is evicted when the app backgrounds and after
  a foreground inactivity timeout — a mobile concern the extension didn't need
  (it relied on service-worker death).
- Platform adapters implementing the core ports: MMKV vault/session/token
  stores, a no-op notification port, the @noble crypto port, and a Keychain
  unlock-secret store. No `buildContainer` yet — the read-only milestone needs
  no signer/provider.
