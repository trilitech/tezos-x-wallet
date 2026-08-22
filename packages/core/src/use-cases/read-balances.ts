/**
 * readBalances: the one account-scoped balance read, shared by both shells.
 *
 * Every result carries the `accountId` it was read for. That is the whole
 * point: a read is bounded by a network deadline, so the account on screen can
 * change while one is in flight, and the caller's only job becomes
 *
 *   if (result.accountId !== accountOnScreen) return;
 *
 * — a structural guard instead of a remembered one. Both shells previously
 * hand-rolled this read in their UI and neither carried the identity, which is
 * how a switch could leave the previous account's balance on screen.
 *
 * Read-through: `cachedBalances` serves the persisted snapshot for an instant
 * paint, then `readBalances` reconciles it live and writes the fresh values
 * back as the next offline fallback. On failure it returns the snapshot again,
 * flagged, so the UI can label last-known values with their age rather than
 * showing a false zero.
 *
 * Amounts are base units (mutez / wei / token units) as strings — formatting
 * is the caller's business. `xtz` is the exception: the native unit differs per
 * runtime (6 vs 18 decimals), so it is normalised here to one decimal string.
 */

import type { AccountId } from '../domain/account';
import type { RegisteredToken } from '../domain/token';
import type { SnapshotStore, BalancesSnapshotData } from '../ports/snapshot-store';
import { mutezToXtz, weiToXtz } from '../shared/format';

export interface ReadBalancesReq {
  accountId: AccountId;
  /** Which runtime holds the native balance — decides the unit conversion. */
  kind:      'tezos' | 'evm';
  /** Holder of the native balance: the tz1 on Michelson, the 0x on EVM. */
  nativeAddress: string;
  /**
   * Holder of the ERC-20 balances: a Tezos account's kernel alias, or the
   * account's own 0x. null while an alias is still resolving — the ERC-20 reads
   * are then skipped rather than issued against a wrong holder.
   */
  erc20Holder: string | null;
  tokens:      RegisteredToken[];
}

export interface ReadBalancesDeps {
  snapshotStore: SnapshotStore;
  /** Native balance in base units (mutez on Michelson, wei on EVM). */
  fetchNative: (address: string) => Promise<bigint>;
  /** ERC-20 balance in the token's own base units. */
  fetchErc20:  (token: string, holder: string) => Promise<bigint>;
  now?: () => number;
}

export interface BalancesRead {
  /** The account these values belong to. Compare before rendering. */
  accountId: AccountId;
  /** Native balance as a decimal string; null when it has never been read. */
  xtz:   string | null;
  /** ERC-20 base-unit amounts keyed by lowercased token address. */
  erc20: Record<string, string>;
  /** When the values were fetched live; null when never. */
  fetchedAt: number | null;
  /** true when these are persisted values because the live read failed. */
  fromSnapshot: boolean;
  /** The live-read failure, when there was one. */
  error: unknown;
}

/**
 * A base-unit amount must parse as an integer. A value that does not is a
 * snapshot written by an older build that persisted display strings; treat it
 * as absent so the next live read replaces it, rather than letting a formatter
 * throw on it.
 */
function isBaseUnits(raw: string): boolean {
  try {
    BigInt(raw);
    return true;
  } catch {
    return false;
  }
}

function sanitizeErc20(erc20: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [addr, raw] of Object.entries(erc20)) {
    if (isBaseUnits(raw)) out[addr] = raw;
  }
  return out;
}

/** The persisted last-known balances, for the instant paint before a live read. */
export async function cachedBalances(
  accountId: AccountId,
  deps: Pick<ReadBalancesDeps, 'snapshotStore'>,
): Promise<BalancesRead | null> {
  const snap = await deps.snapshotStore.loadBalances(accountId).catch(() => null);
  if (snap == null) return null;
  return {
    accountId,
    xtz:          snap.data.xtz,
    erc20:        sanitizeErc20(snap.data.erc20),
    fetchedAt:    snap.fetchedAt,
    fromSnapshot: true,
    error:        null,
  };
}

export async function readBalances(
  req:  ReadBalancesReq,
  deps: ReadBalancesDeps,
): Promise<BalancesRead> {
  const now = deps.now ?? Date.now;
  const { accountId, erc20Holder, tokens } = req;

  // The ERC-20 legs are independent of the native one and of each other: a
  // token whose read fails is omitted, never recorded as zero — a zero would
  // be indistinguishable from an empty wallet.
  const erc20Reads = erc20Holder == null ? [] : tokens.map(async (t) => {
    const raw = await deps.fetchErc20(t.address, erc20Holder);
    return [t.address.toLowerCase(), raw.toString()] as const;
  });

  const [nativeRes, ...erc20Res] = await Promise.allSettled([
    deps.fetchNative(req.nativeAddress),
    ...erc20Reads,
  ]);

  const erc20: Record<string, string> = {};
  for (const r of erc20Res) {
    if (r.status === 'fulfilled') erc20[r.value[0]] = r.value[1];
  }

  if (nativeRes.status === 'fulfilled') {
    const raw = nativeRes.value.toString();
    const xtz = req.kind === 'tezos' ? mutezToXtz(raw) : weiToXtz('0x' + nativeRes.value.toString(16));
    const fetchedAt = now();
    // Merge over the previous snapshot rather than replacing it: a run with an
    // unresolved alias read no ERC-20 at all, and overwriting a complete
    // snapshot with half a read would lose the cached token values.
    const prev = await deps.snapshotStore.loadBalances(accountId).catch(() => null);
    const merged: BalancesSnapshotData = {
      xtz,
      erc20: { ...sanitizeErc20(prev?.data.erc20 ?? {}), ...erc20 },
    };
    void deps.snapshotStore.saveBalances(accountId, { data: merged, fetchedAt })
      .catch(() => { /* best-effort persistence */ });
    return { accountId, xtz, erc20: merged.erc20, fetchedAt, fromSnapshot: false, error: null };
  }

  // The native read is what decides success: without it there is no balance to
  // show, so fall back to the snapshot (labelled by its age) when one exists.
  const snap = await deps.snapshotStore.loadBalances(accountId).catch(() => null);
  if (snap != null && snap.data.xtz != null) {
    return {
      accountId,
      xtz:          snap.data.xtz,
      erc20:        { ...sanitizeErc20(snap.data.erc20), ...erc20 },
      fetchedAt:    snap.fetchedAt,
      fromSnapshot: true,
      error:        nativeRes.reason,
    };
  }

  return { accountId, xtz: null, erc20, fetchedAt: null, fromSnapshot: false, error: nativeRes.reason };
}
