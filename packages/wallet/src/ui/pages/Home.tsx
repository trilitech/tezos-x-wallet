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
import { formatBalanceDisplay, mutezToXtz, timeAgo, weiToXtz } from '@tezosx/wallet-core/shared/format';
import { sendPopupRequest } from '@/shared/messaging';
import { loadBalancesSnapshot, saveBalancesSnapshot } from '@/adapters/chrome/popup-snapshot-store';
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
    const xtzAddress = state.kind === 'tezos' ? state.tz1     : state.address;
    const evmAddress = state.kind === 'tezos' ? state.evmAlias : state.address;

    const xtzFetch = state.kind === 'tezos'
      ? fetchL1XtzBalance(xtzAddress).then(mutezToXtz)
      : fetchXtzBalance(xtzAddress).then(weiToXtz);

    const tokens = await sendPopupRequest<RegisteredToken[]>({ type: 'LIST_REGISTERED_TOKENS' }).catch(() => [] as RegisteredToken[]);
    if (!mine()) return;
    setCustomTokens(tokens);

    // The EVM alias of a tz1 account may still be resolving (first unlock, or
    // offline). Skip the EVM-side ERC-20 reads until it lands — the rows show
    // a dash — and let the effect below re-run when a state re-poll delivers it.
    const tokenFetches = evmAddress == null ? [] : tokens.map((t) =>
      fetchErc20Balance(t.address, evmAddress).then((hex) => [t.address.toLowerCase(), hex] as const),
    );

    const [xtzRes, ...tokenRes] = await Promise.allSettled([
      xtzFetch,
      ...tokenFetches,
    ]);

    const liveBalances: Record<string, string> = {};
    for (const r of tokenRes) {
      if (r.status === 'fulfilled') liveBalances[r.value[0]] = r.value[1];
    }

    if (xtzRes.status === 'fulfilled') {
      if (mine()) {
        setXtz(xtzRes.value);
        setTokenBalances(liveBalances);
        setCachedAt(null);
        setBandDismissed(false);
      }
      // The write-back stays unconditional: it is keyed by the account this
      // read belongs to, so persisting it is correct even once superseded.
      // Write-back: merge the fetched ERC-20 values over the previous
      // snapshot's map so a run with a still-null alias (ERC-20 reads skipped)
      // doesn't erase the cached values.
      const prev = await loadBalancesSnapshot(accountId);
      void saveBalancesSnapshot(accountId, {
        data:      { xtz: xtzRes.value, erc20: { ...(prev?.data.erc20 ?? {}), ...liveBalances } },
        fetchedAt: Date.now(),
      });
      return;
    }

    console.error('[Home] XTZ fetch failed', xtzRes.reason);

    // Live read failed: fall back to the persisted snapshot when one exists —
    // last-known values labeled with their age beat a dash.
    const snap = await loadBalancesSnapshot(accountId);
    if (!mine()) return;
    if (snap != null && snap.data.xtz != null) {
      setXtz(snap.data.xtz);
      setTokenBalances({ ...snap.data.erc20, ...liveBalances });
      setCachedAt(snap.fetchedAt);
      return;
    }

    setXtz('—');
    setTokenBalances(liveBalances);
    setCachedAt(null);
    const e = formatError(xtzRes.reason);
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
        const snap = await loadBalancesSnapshot(activeAccountId);
        if (cancelled) return;
        if (snap != null) {
          if (snap.data.xtz != null) setXtz(snap.data.xtz);
          setTokenBalances(snap.data.erc20);
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
