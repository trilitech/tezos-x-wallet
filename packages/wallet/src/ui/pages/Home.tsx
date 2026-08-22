import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { VaultState, AccountSummary } from '@tezosx/wallet-core/shared/messages';
import type { AccountId } from '@tezosx/wallet-core/domain/account';
import {
  fetchL1XtzBalance,
  fetchXtzBalance,
  fetchErc20Balance,
} from '@tezosx/wallet-core/adapters/tezos/tezos-balance-fetcher';
import { FAUCET_URL } from '@tezosx/wallet-core/shared/constants';
import { formatBalanceDisplay, timeAgo } from '@tezosx/wallet-core/shared/format';
import { cachedBalances, readBalances } from '@tezosx/wallet-core/use-cases/read-balances';
import { sendPopupRequest } from '@/shared/messaging';
import { popupSnapshotStore } from '@/adapters/chrome/popup-snapshot-store';
import { unreachableTitle, useOnline } from '../hooks/use-online';
import { ActivityStaleBand } from '../tx/ActivityStaleBand';
import { formatError } from '@tezosx/wallet-core/domain/error';
import { AccountHeader } from '../tx/AccountHeader';
import { LogoMark } from '../tx/LogoMark';
import { AccountSwitcher } from '../tx/AccountSwitcher';
import { RenameModal } from '../tx/RenameModal';
import { RemoveAccountModal } from '../tx/RemoveAccountModal';
import { IconBtn } from '../tx/Button';
import { Icon } from '../tx/Icon';
import { AssetRow } from '../tx/AssetRow';
import { assetRowVM } from '../view-models/asset-row-vm';
import { XTZ_L1_ASSET, XTZ_L2_ASSET, erc20AssetFromToken } from '@tezosx/wallet-core/domain/asset';
import type { RegisteredToken } from '@tezosx/wallet-core/domain/token';
import { TopBar } from '../tx/TopBar';
import { BottomTabs } from '../tx/BottomTabs';
import { Badge } from '../tx/Badge';
import { errorToast } from '../tx/Toast';

export function Home({ state, onChanged }: { state: VaultState; onChanged: () => void }) {
  const navigate = useNavigate();
  const [xtz, setXtz]                   = useState<string | null>(null);
  const [balanceHidden, setBalanceHidden] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<AccountSummary | null>(null);
  const [removeTarget, setRemoveTarget] = useState<AccountSummary | null>(null);
  const [customTokens, setCustomTokens] = useState<RegisteredToken[]>([]);
  /** Map<lowercased token address, formatted balance string>. Empty when not yet loaded. */
  const [tokenBalances, setTokenBalances] = useState<Record<string, string>>({});
  /** Non-null when the shown balances come from the persisted snapshot (live
   *  fetch failed): the snapshot's fetch time, rendered in the offline band. */
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [bandDismissed, setBandDismissed] = useState(false);
  // Which account already got its instant cached paint — reset per account so
  // an alias-landing re-run of the effect doesn't repaint stale values.
  const paintedForRef = useRef<AccountId | null>(null);
  // Monotonic token for the balance reads. Each read takes one and only the
  // newest may write: a read is bounded by the 15 s RPC deadline, so without
  // this the account the user just left repaints its own balance — or its
  // cached snapshot, amber band included — over the account now on screen.
  const runIdRef = useRef(0);

  const refresh = async () => {
    if (state.status !== 'unlocked') return;
    const accountId  = state.accountId;
    // A retry / reconnect closure captured before a switch belongs to the
    // account that was active then; it must not even issue the reads.
    if (paintedForRef.current !== accountId) return;
    const run  = ++runIdRef.current;
    const mine = (): boolean => runIdRef.current === run;

    const tokens = await sendPopupRequest<RegisteredToken[]>({ type: 'LIST_REGISTERED_TOKENS' }).catch(() => [] as RegisteredToken[]);
    if (!mine()) return;
    setCustomTokens(tokens);

    // The read itself — unit conversion, per-token failure handling, the
    // snapshot fallback and the write-back — is the shared core use-case, so
    // the mobile app behaves identically. The alias of a tz1 may still be
    // resolving: the use-case then skips the ERC-20 reads (the rows show a
    // dash) and the effect below re-runs when a state re-poll delivers it.
    const read = await readBalances({
      accountId,
      kind:          state.kind,
      nativeAddress: state.kind === 'tezos' ? state.tz1 : state.address,
      erc20Holder:   state.kind === 'tezos' ? state.evmAlias : state.address,
      tokens,
    }, {
      snapshotStore: popupSnapshotStore,
      fetchNative: async (addr) => BigInt(state.kind === 'tezos'
        ? await fetchL1XtzBalance(addr)
        : await fetchXtzBalance(addr)),
      fetchErc20:  async (t, h) => BigInt(await fetchErc20Balance(t, h)),
    });
    if (!mine()) return;

    if (read.error == null) {
      setXtz(read.xtz);
      setTokenBalances(read.erc20);
      setCachedAt(null);
      setBandDismissed(false);
      return;
    }

    console.error('[Home] XTZ fetch failed', read.error);

    // Live read failed: the use-case already fell back to the persisted
    // snapshot when one exists — last-known values labeled with their age
    // beat a dash.
    if (read.xtz != null) {
      setXtz(read.xtz);
      setTokenBalances(read.erc20);
      setCachedAt(read.fetchedAt);
      return;
    }

    setXtz('—');
    setTokenBalances(read.erc20);
    setCachedAt(null);
    const e = formatError(read.error);
    errorToast({
      message:   e.title,
      secondary: e.code === 'rpc-unreachable' ? '· network'
               : e.code === 'rpc-timeout'     ? '· timeout'
               : undefined,
      retry:     () => void refresh(),
    });
  };

  const activeKind = state.status === 'unlocked' ? state.kind : null;
  // The alias term makes the balances re-fetch when the background backfill
  // resolves it (null → 0x…) and the Gate's re-poll delivers the new state.
  const activeEvmAlias  = state.status === 'unlocked' && state.kind === 'tezos' ? state.evmAlias : null;
  const activeAccountId = state.status === 'unlocked' ? state.accountId : null;
  useEffect(() => {
    if (state.status !== 'unlocked' || activeAccountId == null) return;
    let cancelled = false;
    void (async () => {
      // First render for this account: paint the last persisted balances
      // instantly, then reconcile with the live fetch (which either replaces
      // them fresh or flags them as cached via the offline band).
      if (paintedForRef.current !== activeAccountId) {
        paintedForRef.current = activeAccountId;
        setXtz(null);
        setTokenBalances({});
        setCachedAt(null);
        setBandDismissed(false);
        const cached = await cachedBalances(activeAccountId, { snapshotStore: popupSnapshotStore });
        if (cancelled) return;
        if (cached != null) {
          if (cached.xtz != null) setXtz(cached.xtz);
          setTokenBalances(cached.erc20);
        }
      }
      if (!cancelled) await refresh();
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, activeKind, activeEvmAlias, activeAccountId]);

  // Reconnect: the 'online' event only fires on a genuine transition, so this
  // is the "we're back" refetch (the Gate refreshes state in parallel, which
  // kicks the SW-side alias backfill).
  const online = useOnline(() => { void refresh(); });

  const lock = async () => {
    await sendPopupRequest({ type: 'LOCK' });
    onChanged();
  };

  if (state.status !== 'unlocked') return null;

  const sortedAccounts = state.accounts.slice().sort((a, b) => a.createdAt - b.createdAt);
  const switchable     = sortedAccounts.length >= 2;
  const activeIdx      = sortedAccounts.findIndex((a) => a.id === state.accountId);
  const activeSummary  = activeIdx >= 0 ? sortedAccounts[activeIdx] : undefined;
  const activeLabel    = activeSummary?.label?.trim()
    || (activeSummary != null ? `Account ${activeIdx + 1}` : 'Account');

  // '—' is the failed-fetch sentinel: formatBalanceDisplay passes it through
  // untouched, so it never becomes a false "0.00" balance. null = still loading.
  const xtzDisplay = xtz == null ? '—' : formatBalanceDisplay(xtz);
  const isEvm      = state.kind === 'evm';

  const setActive = async (id: AccountId) => {
    setSwitcherOpen(false);
    if (id === state.accountId) return;
    try {
      await sendPopupRequest({ type: 'SET_ACTIVE_ACCOUNT', accountId: id });
      onChanged();
    } catch (e) {
      errorToast({ message: formatError(e).title });
    }
  };

  const saveRename = async (label: string) => {
    if (renameTarget == null) return;
    await sendPopupRequest({ type: 'RENAME_ACCOUNT', accountId: renameTarget.id, label });
    onChanged();
  };

  const confirmRemove = async (password: string) => {
    if (removeTarget == null) return;
    await sendPopupRequest({ type: 'REMOVE_ACCOUNT', accountId: removeTarget.id, password });
    onChanged();
  };

  return (
    <div className="tx-page">
      <TopBar
        left={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <LogoMark size={18} />
            <span style={{ fontSize: 13, fontWeight: 500 }}>Tezos X</span>
            <Badge variant="testnet">Testnet</Badge>
          </div>
        }
        title=""
        right={
          <>
            <IconBtn label="Refresh" size="sm" onClick={() => void refresh()}>
              <Icon name="refresh" size={16} />
            </IconBtn>
            <IconBtn label="Lock" size="sm" onClick={lock}>
              <Icon name="lock" size={16} />
            </IconBtn>
            <IconBtn label="Settings" size="sm" onClick={() => navigate('/settings')}>
              <Icon name="settings" size={16} />
            </IconBtn>
          </>
        }
      />

      {cachedAt != null && !bandDismissed && (
        <ActivityStaleBand
          title={unreachableTitle(online)}
          detail={`updated ${timeAgo(cachedAt)}`}
          onDismiss={() => setBandDismissed(true)}
        />
      )}

      <div className="tx-page-scroll">
        <div style={{ position: 'relative' }}>
          <AccountHeader
            state={state}
            displayLabel={activeLabel}
            onSwitcherOpen={switchable ? () => setSwitcherOpen(true) : undefined}
            onAddAccount={!switchable ? () => navigate('/accounts/add') : undefined}
          />

          {switcherOpen && (
            <AccountSwitcher
              state={state}
              onClose={() => setSwitcherOpen(false)}
              onSetActive={(id) => void setActive(id)}
              onRename={(id) => {
                setRenameTarget(sortedAccounts.find((a) => a.id === id) ?? null);
                setSwitcherOpen(false);
              }}
              onRemove={(id) => {
                setRemoveTarget(sortedAccounts.find((a) => a.id === id) ?? null);
                setSwitcherOpen(false);
              }}
              onAdd={() => {
                setSwitcherOpen(false);
                navigate('/accounts/add');
              }}
            />
          )}
        </div>

        <div className="tx-home-balance">
          <div className="kicker">Balance</div>
          <div className="num">
            <span>{balanceHidden ? '••••••' : xtzDisplay}</span>
            <span className="unit">XTZ</span>
          </div>
          <button
            type="button"
            className="hide-toggle"
            onClick={() => setBalanceHidden((h) => !h)}
            aria-label={balanceHidden ? 'Show balance' : 'Hide balance'}
          >
            <Icon name={balanceHidden ? 'eye-off' : 'eye'} size={11} />
            {balanceHidden ? 'Show' : 'Hide'}
          </button>
        </div>

        <div className="tx-home-actions">
          <button type="button" onClick={() => navigate('/send')}>
            <span className="ico"><Icon name="arrow-up-right" size={14} /></span>
            Send
          </button>
          <button type="button" onClick={() => navigate('/receive')}>
            <span className="ico"><Icon name="arrow-down-left" size={14} /></span>
            Receive
          </button>
        </div>

        <button
          type="button"
          className="tx-home-faucet"
          onClick={() => window.open(FAUCET_URL, '_blank', 'noopener,noreferrer')}
        >
          <span className="ico"><Icon name="info" size={11} /></span>
          Need test XTZ? Faucet
          <Icon name="external-link" size={10} />
        </button>

        <div className="tx-home-assets-head">
          <span className="kicker">Assets</span>
        </div>

        <AssetRow
          vm={assetRowVM(isEvm ? XTZ_L2_ASSET : XTZ_L1_ASSET, null)}
          displayBalance={balanceHidden ? '••••' : xtzDisplay}
        />

        {customTokens.map((t) => {
          const asset  = erc20AssetFromToken(t);
          const rawHex = tokenBalances[t.address.toLowerCase()];
          return (
            <AssetRow
              key={t.address}
              vm={assetRowVM(asset, rawHex ?? null)}
              displayBalance={balanceHidden ? '••••' : (rawHex != null ? assetRowVM(asset, rawHex).balanceFormatted : '—')}
            />
          );
        })}

        <button
          type="button"
          className="tx-home-add-token"
          onClick={() => navigate('/tokens/add')}
        >
          <Icon name="plus" size={13} />
          <span>Add token</span>
        </button>

        <div style={{ height: 24 }} />
      </div>

      <BottomTabs />

      {renameTarget != null && (
        <RenameModal
          accountId={renameTarget.id}
          initialLabel={renameTarget.label ?? ''}
          onClose={() => setRenameTarget(null)}
          onSaved={saveRename}
        />
      )}

      {removeTarget != null && (
        <RemoveAccountModal
          account={removeTarget}
          isLast={state.accounts.length === 1}
          onClose={() => setRemoveTarget(null)}
          onConfirmed={confirmRemove}
        />
      )}
    </div>
  );
}
