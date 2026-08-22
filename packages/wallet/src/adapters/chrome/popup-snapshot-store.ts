/**
 * popup-snapshot-store: the popup's handle on the persisted balances snapshot.
 *
 * The popup fetches balances itself (Home/Send read RPCs directly), so its
 * offline read-through needs the snapshot without a service-worker round-trip.
 * That is safe here because snapshots are plain shared chrome.storage.local
 * data — public chain reads stamped with a fetch time, no secrets, no session
 * state — and chrome.storage is directly available to extension pages. This
 * module wraps the very same ChromeSnapshotStore the service worker wires into
 * core (same keys, same shapes), keeping one source of truth for the scheme;
 * pages import this adapter, never chrome.* (see CLAUDE.md §15).
 *
 * Reads and writes are best-effort: a storage failure degrades to "no cache",
 * never to a thrown error in the UI path.
 */

import type {
  BalancesSnapshotData,
  SnapshotEntry,
} from '@tezosx/wallet-core/ports/snapshot-store';
import type { AccountId } from '@tezosx/wallet-core/domain/account';
import { ChromeSnapshotStore } from './chrome-snapshot-store';

/** The store itself, for core use-cases that take the SnapshotStore port
 *  (readBalances read-through + write-back). The helpers below stay for the
 *  call sites that only need one entry. */
export const popupSnapshotStore = new ChromeSnapshotStore();

const store = popupSnapshotStore;

export async function loadBalancesSnapshot(
  accountId: AccountId,
): Promise<SnapshotEntry<BalancesSnapshotData> | null> {
  return store.loadBalances(accountId).catch(() => null);
}

export async function saveBalancesSnapshot(
  accountId: AccountId,
  entry: SnapshotEntry<BalancesSnapshotData>,
): Promise<void> {
  await store.saveBalances(accountId, entry).catch(() => { /* best-effort persistence */ });
}
