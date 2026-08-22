import { describe, expect, it, vi } from 'vitest';
import { readBalances, cachedBalances, type ReadBalancesDeps } from '../read-balances';
import type { AccountId } from '../../domain/account';
import type { RegisteredToken } from '../../domain/token';
import type { SnapshotEntry, BalancesSnapshotData, SnapshotStore } from '../../ports/snapshot-store';

const A = 'acct-a' as AccountId;
const B = 'acct-b' as AccountId;
const USDC = '0xD77420F73B4612a7A99DBA8c2AFd30a1886b0344';

const token = (address: string, decimals = 6): RegisteredToken => ({
  address, symbol: 'USDC', name: 'USD Coin', decimals, addedAt: 0,
});

/** In-memory SnapshotStore; only the balances half matters here. */
function fakeStore(seed: Partial<Record<string, SnapshotEntry<BalancesSnapshotData>>> = {}) {
  const balances = new Map<string, SnapshotEntry<BalancesSnapshotData>>(Object.entries(seed) as never);
  const store: SnapshotStore = {
    loadBalances: async (id) => balances.get(id) ?? null,
    saveBalances: async (id, entry) => { balances.set(id, entry); },
    loadActivity: async () => null,
    saveActivity: async () => {},
    clearAccount: async () => {},
    clear:        async () => {},
  };
  return { store, balances };
}

function deps(over: Partial<ReadBalancesDeps> = {}): ReadBalancesDeps {
  const { store } = fakeStore();
  return {
    snapshotStore: store,
    fetchNative:   async () => 1_500_000n,
    fetchErc20:    async () => 2_500_000n,
    now:           () => 1_000,
    ...over,
  };
}

const tezosReq = {
  accountId: A, kind: 'tezos' as const,
  nativeAddress: 'tz1abc', erc20Holder: '0xholder', tokens: [token(USDC)],
};

describe('readBalances — every result carries the account it belongs to', () => {
  it('stamps the accountId so a caller can drop a superseded read', async () => {
    const out = await readBalances(tezosReq, deps());
    expect(out.accountId).toBe(A);
  });

  it('converts the native amount per runtime (mutez vs wei)', async () => {
    const tez = await readBalances(tezosReq, deps({ fetchNative: async () => 1_500_000n }));
    expect(tez.xtz).toBe('1.5');

    const evm = await readBalances(
      { ...tezosReq, kind: 'evm', nativeAddress: '0xself' },
      deps({ fetchNative: async () => 15n * 10n ** 17n }),
    );
    expect(evm.xtz).toBe('1.5');
  });

  it('returns ERC-20 amounts in base units, keyed lowercase', async () => {
    const out = await readBalances(tezosReq, deps());
    expect(out.erc20).toEqual({ [USDC.toLowerCase()]: '2500000' });
  });
});

describe('readBalances — honest failure handling', () => {
  it('omits a token whose read failed instead of recording a false zero', async () => {
    const out = await readBalances(tezosReq, deps({ fetchErc20: async () => { throw new Error('rpc down'); } }));
    expect(out.erc20).toEqual({});
    expect(out.xtz).toBe('1.5');   // the native read still stands on its own
  });

  it('falls back to the snapshot when the native read fails, flagged and dated', async () => {
    const { store } = fakeStore({
      [A]: { data: { xtz: '9.75', erc20: { [USDC.toLowerCase()]: '1000000' } }, fetchedAt: 500 },
    });
    const out = await readBalances(tezosReq, deps({
      snapshotStore: store,
      fetchNative:   async () => { throw new Error('offline'); },
    }));
    expect(out.xtz).toBe('9.75');
    expect(out.fromSnapshot).toBe(true);
    expect(out.fetchedAt).toBe(500);
    expect(out.error).toBeInstanceOf(Error);
  });

  it('reports no balance rather than zero when the read fails with no snapshot', async () => {
    const out = await readBalances(tezosReq, deps({ fetchNative: async () => { throw new Error('offline'); } }));
    expect(out.xtz).toBeNull();
    expect(out.fromSnapshot).toBe(false);
  });
});

describe('readBalances — write-back', () => {
  it('persists the fresh read as the next offline fallback', async () => {
    const { store, balances } = fakeStore();
    await readBalances(tezosReq, deps({ snapshotStore: store }));
    expect(balances.get(A)).toEqual({
      data: { xtz: '1.5', erc20: { [USDC.toLowerCase()]: '2500000' } },
      fetchedAt: 1_000,
    });
  });

  it('merges over the previous snapshot so an unresolved alias cannot erase cached tokens', async () => {
    const { store, balances } = fakeStore({
      [A]: { data: { xtz: '1', erc20: { [USDC.toLowerCase()]: '7000000' } }, fetchedAt: 500 },
    });
    // Alias still resolving: no ERC-20 read happens at all.
    const out = await readBalances(
      { ...tezosReq, erc20Holder: null },
      deps({ snapshotStore: store }),
    );
    expect(out.erc20).toEqual({ [USDC.toLowerCase()]: '7000000' });
    expect(balances.get(A)?.data.erc20).toEqual({ [USDC.toLowerCase()]: '7000000' });
  });

  it('never reads ERC-20 with an unresolved holder', async () => {
    const fetchErc20 = vi.fn();
    await readBalances({ ...tezosReq, erc20Holder: null }, deps({ fetchErc20 }));
    expect(fetchErc20).not.toHaveBeenCalled();
  });

  it('writes under the account it read, not another', async () => {
    const { store, balances } = fakeStore();
    await readBalances({ ...tezosReq, accountId: B }, deps({ snapshotStore: store }));
    expect(balances.has(B)).toBe(true);
    expect(balances.has(A)).toBe(false);
  });
});

describe('cachedBalances / legacy snapshots', () => {
  it('serves the persisted values flagged as cached', async () => {
    const { store } = fakeStore({
      [A]: { data: { xtz: '3.25', erc20: { [USDC.toLowerCase()]: '1000000' } }, fetchedAt: 42 },
    });
    const out = await cachedBalances(A, { snapshotStore: store });
    expect(out).toMatchObject({ accountId: A, xtz: '3.25', fetchedAt: 42, fromSnapshot: true });
  });

  it('returns null when the account has no snapshot', async () => {
    const { store } = fakeStore();
    expect(await cachedBalances(A, { snapshotStore: store })).toBeNull();
  });

  it('discards a token amount an older build persisted as a display string', async () => {
    // '1.5' is not base units; keeping it would make a formatter throw.
    const { store } = fakeStore({
      [A]: { data: { xtz: '1.5', erc20: { [USDC.toLowerCase()]: '1.5' } }, fetchedAt: 42 },
    });
    const out = await cachedBalances(A, { snapshotStore: store });
    expect(out?.erc20).toEqual({});
    expect(out?.xtz).toBe('1.5');   // the native value is a display string by contract
  });
});
