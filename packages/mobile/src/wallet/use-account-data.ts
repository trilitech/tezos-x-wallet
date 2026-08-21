/**
 * use-account-data — the per-account read effect behind the WalletContext seam.
 * For the active unlocked account it fetches balances (L1 XTZ or EVM XTZ + each
 * registered ERC-20), the token registry, and the merged activity feed, exposing
 * each as an AsyncData<T> (data / loading / error / stale) the screens render
 * directly. Keyed on the active account (+ a refresh nonce): switching accounts
 * or locking cancels the in-flight fetch and re-scopes; all network I/O stays
 * below the seam in the core adapters, never in the screens.
 *
 * Reads are read-through against the persisted snapshot store: the last-known
 * values render immediately (stamped with their age via `stale`) while the live
 * fetch revalidates. A live success replaces them and writes the snapshot back;
 * a live failure keeps them — cached data labeled with its age instead of a
 * false zero. With no snapshot, a failure surfaces exactly as before (error,
 * no data — the screens' '—').
 */

import { useEffect, useRef, useState } from 'react';
import type { VaultStateUnlocked } from '@tezosx/wallet-core/shared/messages';
import type { RegisteredToken } from '@tezosx/wallet-core/domain/token';
import type { ActivityPage } from '@tezosx/wallet-core/domain/activity';
import type { BalancesSnapshotData, SnapshotEntry } from '@tezosx/wallet-core/ports/snapshot-store';
import { formatError, type FormattedError } from '@tezosx/wallet-core/domain/error';
import { mutezToXtz, weiToXtz, formatTokenAmount } from '@tezosx/wallet-core/shared/format';
import {
  fetchL1XtzBalance,
  fetchXtzBalance,
  fetchErc20Balance,
} from '@tezosx/wallet-core/adapters/tezos/tezos-balance-fetcher';
import { listRegisteredTokens } from '@tezosx/wallet-core/use-cases/list-registered-tokens';
import { listActivity } from '@tezosx/wallet-core/use-cases/list-activity';
import { tokenStore, deps, snapshotStore } from '../composition/wiring';
import { toActivityRowVM, type ActivityRowVM } from './activity-vm';

/**
 * data + stale is the honesty contract: `stale` is non-null exactly when
 * `data` came from the persisted snapshot rather than a live read, carrying
 * the epoch ms it was fetched so the UI can label it ("updated 3m ago"). A
 * live success clears it. `data` + `error` + `stale` together mean "the live
 * read failed, this is the last-known value"; `error` without `stale` is the
 * plain no-cache failure the screens already render.
 */
export interface AsyncData<T> {
  data: T | null;
  loading: boolean;
  error: FormattedError | null;
  stale: { fetchedAt: number } | null;
}

/** Displayed native balance (already decimal) + per-token decimal balances keyed by lowercased address. */
export interface BalancesView {
  xtz: string;
  tokens: Record<string, string>;
}

export interface ActivityView {
  items: ActivityRowVM[];
  staleness: ActivityPage['staleness'];
  /** Epoch ms of the data's origin: now for live reads, the snapshot's
   *  timestamp for a 'cached-only' page. */
  fetchedAt?: number;
}

export interface AccountData {
  balances: AsyncData<BalancesView>;
  tokens: AsyncData<RegisteredToken[]>;
  activity: AsyncData<ActivityView>;
}

const IDLE = { data: null, loading: false, error: null, stale: null } as const;

/** Map a persisted balances snapshot to the view shape. null when the
 *  snapshot never held a native balance — there is nothing honest to show. */
export function balancesSnapshotToView(
  snap: SnapshotEntry<BalancesSnapshotData> | null,
): BalancesView | null {
  if (snap == null || snap.data.xtz == null) return null;
  return { xtz: snap.data.xtz, tokens: snap.data.erc20 };
}

export function useAccountData(active: VaultStateUnlocked | null, nonce: number): AccountData {
  const [balances, setBalances] = useState<AsyncData<BalancesView>>(IDLE);
  const [tokens, setTokens] = useState<AsyncData<RegisteredToken[]>>(IDLE);
  const [activity, setActivity] = useState<AsyncData<ActivityView>>(IDLE);
  // Which account the currently-held data belongs to: a switch must drop it
  // (another account's numbers are never an acceptable placeholder), while a
  // refresh of the same account keeps it visible under the loading flag.
  const dataOwnerRef = useRef<string | null>(null);

  useEffect(() => {
    if (active == null) {
      dataOwnerRef.current = null;
      setBalances(IDLE);
      setTokens(IDLE);
      setActivity(IDLE);
      return;
    }

    let live = true;
    const accountId = active.accountId;
    const keepPrev = dataOwnerRef.current === accountId;
    dataOwnerRef.current = accountId;
    // The EVM-side balance holder: a tz1's kernel alias, or the 0x itself.
    // null while the alias is still resolving — ERC-20 reads are skipped (not
    // fetched with a bogus holder) and re-run when the alias lands (see deps).
    const holder: string | null = active.kind === 'tezos' ? active.evmAlias : active.address;

    // Read-through: kick both snapshot loads before anything network-bound.
    const balancesSnapP = snapshotStore.loadBalances(accountId).catch(() => null);
    const activitySnapP = snapshotStore.loadActivity(accountId).catch(() => null);

    setBalances((s) => ({ data: keepPrev ? s.data : null, loading: true, error: null, stale: keepPrev ? s.stale : null }));
    setTokens((s) => ({ data: keepPrev ? s.data : null, loading: true, error: null, stale: null }));

    // Tokens + balances: the registry is fetched first so we know which ERC-20
    // balances to read; a failing token balance falls back to '0' without
    // failing the whole read (the native balance still resolves).
    void (async () => {
      const snap = await balancesSnapP;
      const snapView = balancesSnapshotToView(snap);
      // Surface the cached values immediately, stamped with their age, while
      // the live read runs — but never over data already on screen.
      if (live && snapView != null && snap != null) {
        setBalances((s) => (s.data == null ? { data: snapView, loading: true, error: null, stale: { fetchedAt: snap.fetchedAt } } : s));
      }
      try {
        const list = await listRegisteredTokens({ accountId }, { tokenStore });
        if (!live) return;
        setTokens({ data: list, loading: false, error: null, stale: null });

        const rawXtz = active.kind === 'tezos'
          ? await fetchL1XtzBalance(active.tz1)
          : await fetchXtzBalance(active.address);
        const xtz = active.kind === 'tezos' ? mutezToXtz(rawXtz) : weiToXtz(rawXtz);

        const tokenBalances: Record<string, string> = {};
        if (holder != null) {
          await Promise.all(list.map(async (t) => {
            try {
              tokenBalances[t.address.toLowerCase()] = formatTokenAmount(
                await fetchErc20Balance(t.address, holder),
                t.decimals,
              );
            } catch {
              tokenBalances[t.address.toLowerCase()] = '0';
            }
          }));
        }
        if (!live) return;
        setBalances({ data: { xtz, tokens: tokenBalances }, loading: false, error: null, stale: null });
        // Write-back: this fresh read becomes the offline fallback. Skipped
        // while the alias is unresolved and tokens are registered — the ERC-20
        // half was never read, and overwriting a complete snapshot with half a
        // read would lose data.
        if (holder != null || list.length === 0) {
          void snapshotStore.saveBalances(accountId, { data: { xtz, erc20: tokenBalances }, fetchedAt: Date.now() })
            .catch(() => { /* best-effort persistence */ });
        }
      } catch (e) {
        if (!live) return;
        const fe = formatError(e);
        setTokens((s) => ({ data: s.data, loading: false, error: fe, stale: null }));
        // Failure keeps the last-known values (labeled by `stale`) when a
        // snapshot exists; without one this is the plain no-data failure.
        setBalances(snapView != null && snap != null
          ? { data: snapView, loading: false, error: fe, stale: { fetchedAt: snap.fetchedAt } }
          : { data: null, loading: false, error: fe, stale: null });
      }
    })();

    // Activity needs the warm container for the active account. The rebuild
    // runs concurrently with this effect, so the slot can still hold the
    // PREVIOUS account's container — reading through it while stamping the
    // result with this account's id would persist one account's feed under
    // another's snapshot key. Anything but a container that belongs to this
    // account counts as "not ready yet" and leaves the snapshot on screen.
    setActivity((s) => ({ data: keepPrev ? s.data : null, loading: true, error: null, stale: keepPrev ? s.stale : null }));
    void (async () => {
      const snap = await activitySnapP;
      const snapView: ActivityView | null = snap != null && snap.data.length > 0
        ? { items: snap.data.map(toActivityRowVM), staleness: 'cached-only', fetchedAt: snap.fetchedAt }
        : null;
      if (live && snapView != null && snap != null) {
        setActivity((s) => (s.data == null ? { data: snapView, loading: true, error: null, stale: { fetchedAt: snap.fetchedAt } } : s));
      }

      const container = deps.state.container;
      if (container == null || container.signer.account.id !== accountId) {
        if (!live) return;
        setActivity((s) => (s.data != null
          ? { ...s, loading: false }
          : { data: { items: [], staleness: 'fresh' }, loading: false, error: null, stale: null }));
        return;
      }

      try {
        const page = await listActivity({}, {
          container,
          evmAlias:      active.kind === 'tezos' ? active.evmAlias : active.address,
          snapshotStore,
          accountId,
        });
        if (!live) return;
        // The use-case persists fresh first pages and serves the snapshot
        // itself when every live source fails ('cached-only' + fetchedAt) —
        // `stale` mirrors that so the screens have one signal for cached data.
        const cachedOnly = page.staleness === 'cached-only';
        setActivity({
          data: { items: page.items.map(toActivityRowVM), staleness: page.staleness, fetchedAt: page.fetchedAt },
          loading: false,
          error: null,
          stale: cachedOnly && page.fetchedAt != null && page.items.length > 0 ? { fetchedAt: page.fetchedAt } : null,
        });
      } catch (e) {
        if (!live) return;
        setActivity(snapView != null && snap != null
          ? { data: snapView, loading: false, error: formatError(e), stale: { fetchedAt: snap.fetchedAt } }
          : { data: null, loading: false, error: formatError(e), stale: null });
      }
    })();

    return () => { live = false; };
    // Addresses are invariant for a given (accountId, kind) except the EVM
    // alias, which flips exactly once from null to its resolved value — that
    // flip must re-run the reads so the skipped ERC-20 balances load. Beyond
    // it, re-scope only on account switch or an explicit refresh, not on every
    // getState identity churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.accountId, active?.kind, active?.kind === 'tezos' ? active.evmAlias : null, nonce]);

  return { balances, tokens, activity };
}
