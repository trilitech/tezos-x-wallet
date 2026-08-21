/**
 * Send — the transfer flow, a three-stage local state machine:
 *   form   → pick asset (Sheet), enter recipient (RoutingCard reflects the route),
 *            enter amount (Max / available), validate.
 *   review → From→To lane with runtime pills, amount / routing / network lines,
 *            an insufficient-balance warning, and a routing explainer.
 *   done   → real StatusTimeline (broadcasting → included → finalized): trackTx
 *            for same-runtime sends, trackCrossRuntimeTx for the gateway path
 *            (the L1 op drives 'included' while the synthetic hash resolves to
 *            the kernel-synthesized EVM hash), the sent amount + recipient, and
 *            a tappable explorer link.
 * Cross-runtime is inferred from source kind × destination runtime; the routing
 * copy comes verbatim from the design's routingLabel.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { trackTx, trackCrossRuntimeTx } from '@tezosx/wallet-core/shared/tx-status';
import { startPoller } from '@tezosx/wallet-core/shared/poller';
import type { TxStatus } from '@tezosx/wallet-core/domain/tx-status';
import type { ResolveTxResult } from '@tezosx/wallet-core/use-cases/resolve-tx';
import { formatError, type FormattedError } from '@tezosx/wallet-core/domain/error';
import { XTZ_L1_ASSET, XTZ_L2_ASSET, erc20AssetFromToken, type Asset } from '@tezosx/wallet-core/domain/asset';
import { contactFor, matchContacts, shouldOfferSaveContact } from '@tezosx/wallet-core/view-models/contacts-vm';
import {
  TEZOS_EXPLORER,
  EVM_EXPLORER,
  MAX_LABEL_LENGTH,
  TX_RESOLVE_POLL_MS,
  TX_RESOLVE_TIMEOUT_MS,
  MAX_FEE_RESERVE_MUTEZ,
} from '@tezosx/wallet-core/shared/constants';
import { NAC_CONTRACT } from '@tezosx/relayer/constants';
import { colors, font, fontSize, radius, space } from '../theme';
import { detectRuntime, AMOUNT_RE } from '@tezosx/wallet-core/domain/validation';
import { formatBalanceDisplay, mutezToXtz, shortAddr } from '@tezosx/wallet-core/shared/format';
import { parseTokenAmount, xtzToMutez, normalizeDecimalInput } from '@tezosx/wallet-core/shared/amounts';
import { Icon } from '../ui/icon';
import { AssetMark } from '../ui/tx/AssetMark';
import { Btn } from '../ui/tx/Btn';
import { Burst } from '../ui/tx/Burst';
import { ChainPill } from '../ui/tx/ChainPill';
import { ErrorCard } from '../ui/tx/ErrorCard';
import { ErrorInline } from '../ui/tx/ErrorInline';
import { Line } from '../ui/tx/Line';
import { RoutingCard, routingLabel } from '../ui/tx/RoutingCard';
import { Sheet } from '../ui/tx/Sheet';
import { Spinner } from '../ui/tx/Spinner';
import { StatusTimeline, type TimelineStage } from '../ui/tx/StatusTimeline';
import { TopBar } from '../ui/tx/TopBar';
import { useWallet } from '../wallet/context';

type SendAsset = { kind: 'xtz' | 'token'; symbol: string; address?: string };
type Stage = 'form' | 'review' | 'done';
interface DoneInfo {
  amount: string;
  symbol: string;
  to: string;
  runtime: 'l1' | 'l2';
  sign: string;
  hash: string;
  pending: boolean;     // cross-runtime synthetic hash still resolving
  unresolved: boolean;  // resolution timed out — showing the intermediate hash
}


export function Send(_props: { params?: Record<string, unknown> } = {}): React.JSX.Element {
  const ctx = useWallet();
  const acc = ctx.activeAccount;
  const isEvm = acc.kind === 'evm';
  const bal = ctx.balances.data;
  const tokens = ctx.tokens.data ?? [];

  const assets = useMemo<SendAsset[]>(
    () => [
      { kind: 'xtz', symbol: 'XTZ' },
      ...tokens.map((t): SendAsset => ({ kind: 'token', symbol: t.symbol, address: t.address })),
    ],
    [tokens],
  );

  const [stage, setStage] = useState<Stage>('form');
  const [asset, setAsset] = useState<SendAsset>(assets[0]);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [assetOpen, setAssetOpen] = useState(false);
  const [done, setDone] = useState<DoneInfo | null>(null);
  const [txStatus, setTxStatus] = useState<TxStatus | null>(null);
  const [pendingResolve, setPendingResolve] = useState<{ syntheticHash: string } | null>(null);
  const [crossTrack, setCrossTrack] = useState<{ l1OpHash: string | null } | null>(null);
  // The resolved kernel hash, read by the cross-runtime tracker on each poll
  // tick — a ref, so the running tracker sees it without being restarted.
  const realHashRef = useRef<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<FormattedError | null>(null);
  const [toFocused, setToFocused] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<FormattedError | null>(null);
  const [saveHidden, setSaveHidden] = useState(false);

  const dest = detectRuntime(to);
  const toContact = contactFor(to, ctx.contacts);
  const suggestions = useMemo(() => matchContacts(to, ctx.contacts), [to, ctx.contacts]);
  const available =
    asset.kind === 'xtz' ? bal?.xtz ?? '0' : bal?.tokens[(asset.address ?? '').toLowerCase()] ?? '0';
  const insufficient = parseFloat(amount || '0') > parseFloat(available);
  const valid =
    dest != null &&
    AMOUNT_RE.test(amount) &&
    Number(amount) > 0 &&
    !insufficient &&
    !(asset.kind === 'token' && dest === 'l1');
  const isCross = acc.kind === 'tezos' ? dest === 'l2' : dest === 'l1';
  const predictedRuntime: 'l1' | 'l2' =
    acc.kind === 'tezos' && asset.kind === 'xtz' && dest === 'l1' ? 'l1' : 'l2';
  const fromAddr = isEvm ? acc.address : acc.tz1;

  const back = (): void => {
    if (stage === 'form') ctx.nav.back();
    else if (stage === 'review') setStage('form');
  };

  // Map the screen's asset selection to the core Asset union sendTransfer needs.
  const toCoreAsset = (): Asset => {
    if (asset.kind === 'xtz') return isEvm ? XTZ_L2_ASSET : XTZ_L1_ASSET;
    const t = tokens.find((x) => x.address.toLowerCase() === (asset.address ?? '').toLowerCase());
    return t != null ? erc20AssetFromToken(t) : isEvm ? XTZ_L2_ASSET : XTZ_L1_ASSET;
  };

  const submit = (): void => {
    if (submitting) return;
    setErr(null);
    setTxStatus(null);
    setCrossTrack(null);
    realHashRef.current = null;
    setDone({ amount, symbol: asset.symbol, to, runtime: predictedRuntime, sign: '−', hash: '', pending: false, unresolved: false });
    setStage('done');
    setSubmitting(true);
    void (async () => {
      try {
        const coreAsset = toCoreAsset();
        const amountHex = parseTokenAmount(amount, coreAsset.kind === 'xtz' ? 18 : coreAsset.decimals);
        const result = await ctx.sendTransfer({ to, amount: amountHex, asset: coreAsset });
        if (result.runtime === 'l1') {
          setDone((d) => (d != null ? { ...d, hash: result.hash, runtime: 'l1', pending: false } : d));
        } else {
          const fromGateway = acc.kind === 'tezos' && dest === 'l2';
          setDone((d) => (d != null ? { ...d, hash: result.hash, runtime: 'l2', pending: fromGateway } : d));
          if (fromGateway) {
            setPendingResolve({ syntheticHash: result.hash });
            setCrossTrack({ l1OpHash: result.l1OpHash ?? null });
          }
        }
      } catch (e) {
        setErr(formatError(e));
        setDone(null);
        setStage('review');
      } finally {
        setSubmitting(false);
      }
    })();
  };

  // Post-send save offer: name the destination and add it to the address book.
  const saveContact = (dest_: string): void => {
    if (saveBusy || saveName.trim() === '') return;
    setSaveBusy(true);
    setSaveErr(null);
    void (async () => {
      try {
        await ctx.addContact(dest_, saveName);
        setSaveHidden(true);
        ctx.toast('Contact saved');
      } catch (e) {
        setSaveErr(formatError(e));
      } finally {
        setSaveBusy(false);
      }
    })();
  };

  // Cross-runtime (tz1 → 0x): poll the synthetic NAC hash to the real EVM hash,
  // until resolved or timed out (then keep the intermediate hash, flagged).
  useEffect(() => {
    if (pendingResolve == null) return;
    const poller = startPoller<ResolveTxResult>({
      fetch: () => ctx.resolveTx(pendingResolve.syntheticHash),
      onUpdate: (r) => {
        if (r.resolved) {
          realHashRef.current = r.hash;
          setDone((d) => (d != null ? { ...d, hash: r.hash, pending: false, unresolved: false } : d));
          setPendingResolve(null);
        }
      },
      isDone: (r) => r.resolved,
      intervalMs: TX_RESOLVE_POLL_MS,
      timeoutMs: TX_RESOLVE_TIMEOUT_MS,
      onTimeout: () => {
        setDone((d) => (d != null ? { ...d, pending: false, unresolved: true } : d));
        setPendingResolve(null);
      },
    });
    return () => poller.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingResolve]);

  // Same-runtime sends return a real hash immediately — track it directly.
  // The gateway path is handled by the cross-runtime tracker below.
  useEffect(() => {
    if (stage !== 'done' || done == null || done.hash === '' || crossTrack != null) return;
    if (done.pending || done.unresolved) return;
    const handle = trackTx({ hash: done.hash, runtime: done.runtime, onUpdate: setTxStatus });
    return () => handle.stop();
  }, [stage, done, crossTrack]);

  // Cross-runtime: track from broadcast time. The L1 operation's inclusion
  // drives 'included' while the kernel hash is still resolving; once resolved
  // (via realHashRef) the L2 receipt concludes the timeline.
  useEffect(() => {
    if (stage !== 'done' || crossTrack == null) return;
    const handle = trackCrossRuntimeTx({
      l1OpHash:    crossTrack.l1OpHash,
      getRealHash: () => realHashRef.current,
      onUpdate:    setTxStatus,
    });
    return () => handle.stop();
  }, [stage, crossTrack]);

  if (stage === 'done' && done != null) {
    const status: TxStatus = txStatus ?? { stage: 'broadcasting' };
    const finalized = status.stage === 'finalized';
    const failed = status.stage === 'failed' || status.stage === 'unavailable';
    const tlStage: TimelineStage =
      status.stage === 'included' ? 'included' : status.stage === 'finalized' ? 'finalized' : 'broadcasting';
    const explorerUrl = done.runtime === 'l1' ? `${TEZOS_EXPLORER}/${done.hash}` : `${EVM_EXPLORER}/tx/${done.hash}`;
    const explorerName = done.runtime === 'l1' ? 'tzkt' : 'blockscout';

    return (
      <View style={styles.screen}>
        <TopBar />
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.doneScroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.statusHero}>
            {failed ? (
              <View style={styles.failIco}>
                <Icon name="alert" size={30} color={colors.danger} />
              </View>
            ) : finalized ? (
              <Burst />
            ) : (
              <Spinner accent={done.runtime === 'l2' ? 'cyan' : 'purple'} />
            )}
            <View style={styles.heroText}>
              <Text style={styles.sAmt} numberOfLines={1} adjustsFontSizeToFit>
                {done.sign}
                {normalizeDecimalInput(done.amount)} {done.symbol}
              </Text>
              <Text style={styles.sTo} numberOfLines={1}>
                to <Text style={styles.mono}>{shortAddr(done.to, 6)}</Text>
              </Text>
            </View>
          </View>

          {failed ? (
            <View style={styles.failWrap}>
              <ErrorCard
                title={status.stage === 'failed' ? 'Transaction failed' : 'Status unavailable'}
                detail={
                  status.stage === 'failed'
                    ? `The transfer was rejected on-chain (${status.reason}).`
                    : "The RPC didn't reply in time. Your transfer was broadcast — check the explorer to see if it landed."
                }
              />
            </View>
          ) : (
            <StatusTimeline stage={tlStage} runtime={done.runtime} />
          )}

          {!failed && done.hash !== '' && (
            <View style={styles.doneCard}>
              <Line
                label={done.runtime === 'l1' ? 'Operation hash' : done.unresolved ? 'Intermediate hash' : 'Transaction hash'}
                value={<Text style={styles.mono}>{shortAddr(done.hash, 6)}</Text>}
              />
              <View style={styles.divider} />
              <Pressable onPress={() => void Linking.openURL(explorerUrl)}>
                <Line
                  label="Explorer"
                  value={
                    <View style={styles.explorerVal}>
                      <Text style={styles.explorerText}>{explorerName}</Text>
                      <Icon name="external-link" size={13} color={colors.fgMuted} />
                    </View>
                  }
                />
              </Pressable>
            </View>
          )}

          {done.unresolved && (
            <Text style={styles.unresolvedNote}>
              The EVM transaction hasn't been indexed yet. The transfer was broadcast on the Michelson runtime — the final hash resolves shortly.
            </Text>
          )}

          {!failed && !saveHidden && shouldOfferSaveContact(done.to, ctx.contacts) && (
            <View style={styles.saveContact}>
              <Text style={styles.saveContactTitle}>Save as contact</Text>
              <View style={styles.saveContactRow}>
                <TextInput
                  style={styles.saveContactInput}
                  value={saveName}
                  onChangeText={(v) => { setSaveName(v); setSaveErr(null); }}
                  placeholder="Name"
                  placeholderTextColor={colors.fgSubtle}
                  maxLength={MAX_LABEL_LENGTH}
                  autoCorrect={false}
                />
                <Btn variant="outline" size="sm" loading={saveBusy} disabled={saveName.trim() === ''} onPress={() => saveContact(done.to)}>
                  Save
                </Btn>
              </View>
              {saveErr != null && <ErrorInline title={saveErr.title} detail={saveErr.detail} />}
            </View>
          )}
        </ScrollView>
        <View style={styles.actionBar}>
          {failed ? (
            <Btn variant="outline" full onPress={() => void Linking.openURL(explorerUrl)}>
              {`View on ${explorerName}`}
            </Btn>
          ) : (
            <Btn
              variant={finalized ? 'accent' : 'outline'}
              full
              onPress={() => {
                ctx.refreshData();
                ctx.nav.reset('home');
              }}
            >
              Done
            </Btn>
          )}
        </View>
      </View>
    );
  }

  if (stage === 'review') {
    const fromChain: 'l1' | 'l2' = isEvm ? 'l2' : 'l1';
    const destChain: 'l1' | 'l2' = dest === 'l2' ? 'l2' : 'l1';
    const reviewCopy = isCross
      ? isEvm
        ? 'Your 0x signs an EVM transaction that calls the NAC precompile. The kernel forwards the value to the receiving tz1 atomically.'
        : 'Your tz1 signs a Michelson-runtime op routed to the EVM runtime through the NAC gateway. The receiving 0x address is credited atomically.'
      : 'Make sure the recipient is correct — transfers can’t be reversed.';
    const r = routingLabel(acc.kind, dest);

    return (
      <View style={styles.screen}>
        <TopBar title="Review transfer" onBack={back} />
        <ScrollView style={styles.scroll} contentContainerStyle={styles.reviewScroll} showsVerticalScrollIndicator={false}>
          <View style={styles.lane}>
            <View style={styles.laneSide}>
              <Text style={styles.laneK}>From</Text>
              <Text style={styles.laneV} numberOfLines={1}>
                {shortAddr(fromAddr, 6)}
              </Text>
              <ChainPill chain={fromChain} />
            </View>
            <View style={[styles.laneArrow, isCross && styles.laneArrowCross]}>
              <Icon name="arrow-right" size={15} color={isCross ? '#FFFFFF' : colors.fgSubtle} />
            </View>
            <View style={styles.laneSide}>
              <Text style={styles.laneK}>To</Text>
              {toContact != null && (
                <Text style={styles.laneName} numberOfLines={1}>
                  {toContact.label}
                </Text>
              )}
              <Text style={styles.laneV} numberOfLines={1}>
                {shortAddr(to, 6)}
              </Text>
              <ChainPill chain={destChain} />
            </View>
          </View>

          <View style={styles.card}>
            <Line label="Amount" value={`${normalizeDecimalInput(amount)} ${asset.symbol}`} />
            <View style={styles.divider} />
            <Line label="Routing" value={r.cross ? `${r.title} · ${r.sub}` : r.title} />
            <View style={styles.divider} />
            <Line label="Network" value="Tezos X Previewnet" />
          </View>

          {!isEvm && isCross && (
            <>
              <Text style={[styles.kicker, styles.crossKicker]}>What you actually sign</Text>
              <View style={styles.card}>
                <Line label="Michelson target" value={shortAddr(NAC_CONTRACT, 6)} />
                <View style={styles.divider} />
                <Line label="Entrypoint" value={asset.kind === 'xtz' ? 'call' : 'call_evm'} />
                {asset.kind === 'token' && (
                  <>
                    <View style={styles.divider} />
                    <Line label="Method" value="transfer(address,uint256)" />
                  </>
                )}
                <View style={styles.divider} />
                <Line
                  label="Debit (mutez)"
                  value={asset.kind === 'xtz' ? xtzToMutez(amount).toString() : '0'}
                />
              </View>
            </>
          )}

          {insufficient && (
            <View style={styles.warnBanner}>
              <View style={styles.warnIco}>
                <Icon name="alert" size={18} color={colors.danger} />
              </View>
              <View style={styles.warnBody}>
                <Text style={styles.warnTitle}>Insufficient balance</Text>
                <Text style={styles.warnDetail}>
                  You’re sending more {asset.symbol} than this account holds ({formatBalanceDisplay(available)}{' '}
                  available).
                </Text>
              </View>
            </View>
          )}

          {err != null && (
            <View style={styles.reviewErr}>
              <ErrorCard title={err.title} detail={err.detail} />
            </View>
          )}

          <View style={styles.explainer}>
            <Icon name="info" size={15} color={colors.fgSubtle} />
            <Text style={styles.explainerText}>{reviewCopy}</Text>
          </View>
        </ScrollView>

        {!ctx.online && (
          <View style={styles.offlineNote}>
            <Icon name="info" size={15} color={colors.warning} />
            <Text style={styles.offlineNoteText}>You're offline — sending needs the network.</Text>
          </View>
        )}
        <View style={styles.actionBar}>
          <Btn variant="outline" onPress={back}>
            Cancel
          </Btn>
          {/* Fail fast while offline: the broadcast can only fail, so the CTA is
              disabled before the biometric prompt ever fires. */}
          <Btn variant="accent" full loading={submitting} disabled={insufficient || !ctx.online} onPress={submit}>
            Confirm &amp; send
          </Btn>
        </View>
      </View>
    );
  }

  // form
  return (
    <View style={styles.screen}>
      <TopBar title="Send" onBack={back} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.formScroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.kicker, styles.kickerFirst]}>Asset</Text>
        <Pressable
          style={({ pressed }) => [styles.assetPicker, pressed && styles.assetPickerPressed]}
          onPress={() => setAssetOpen(true)}
        >
          <AssetMark symbol={asset.symbol} kind={asset.kind} size="sm" />
          <View style={styles.assetPickerBody}>
            <Text style={styles.assetPickerName}>{asset.symbol}</Text>
            <Text style={styles.assetPickerSub}>
              {asset.kind === 'xtz' ? 'Native asset' : 'ERC-20 · EVM runtime'}
            </Text>
          </View>
          <Icon name="chevron-down" size={18} color={colors.fgMuted} />
        </Pressable>

        <Text style={[styles.kicker, styles.kickerRecipient]}>Recipient</Text>
        <TextInput
          style={styles.input}
          value={to}
          onChangeText={setTo}
          onFocus={() => setToFocused(true)}
          onBlur={() => setToFocused(false)}
          placeholder={isEvm ? '0x… or tz1…' : 'tz1… or 0x…'}
          placeholderTextColor={colors.fgSubtle}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {toContact != null && (
          <View style={styles.contactHint}>
            <Text style={styles.contactHintLabel} numberOfLines={1}>
              {toContact.label}
            </Text>
            <Text style={styles.contactHintAddr} numberOfLines={1}>
              {shortAddr(toContact.address, 8)}
            </Text>
          </View>
        )}
        {toFocused && toContact == null && suggestions.length > 0 && (
          <View style={styles.suggestions}>
            {suggestions.map((c) => (
              <Pressable
                key={c.address}
                style={({ pressed }) => [styles.suggestRow, pressed && styles.suggestRowPressed]}
                onPress={() => setTo(c.address)}
              >
                <Text style={styles.suggestLabel} numberOfLines={1}>
                  {c.label}
                </Text>
                <Text style={styles.suggestAddr} numberOfLines={1}>
                  {shortAddr(c.address, 6)}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
        <RoutingCard sourceKind={acc.kind} dest={dest} />

        <Text style={[styles.kicker, styles.kickerAmount]}>Amount</Text>
        <View style={styles.amountCard}>
          <TextInput
            style={styles.amountInput}
            inputMode="decimal"
            value={amount}
            placeholder="0"
            placeholderTextColor={colors.fgSubtle}
            onChangeText={(v) => { if (v === '' || /^\d*\.?\d*$/.test(v)) setAmount(v); }}
            textAlign="center"
          />
          <View style={styles.avail}>
            <View style={styles.availTxt}>
              <Text style={[styles.availLbl, insufficient && styles.availLow]}>Available</Text>
              <Text style={[styles.availSep, insufficient && styles.availLow]}>·</Text>
              <Text style={[styles.availNum, insufficient && styles.availLow]}>
                {formatBalanceDisplay(available)} {asset.symbol}
              </Text>
            </View>
            <Pressable
              style={({ pressed }) => [styles.maxPill, pressed && styles.maxPillPressed]}
              onPress={() => {
                // Keep room for the transfer's own fee, or Max fails on
                // balance_too_low at signing.
                if (asset.kind !== 'xtz') { setAmount(available); return; }
                const total  = xtzToMutez(available);
                const usable = total > MAX_FEE_RESERVE_MUTEZ ? total - MAX_FEE_RESERVE_MUTEZ : 0n;
                setAmount(mutezToXtz(usable.toString()));
              }}
            >
              <Text style={styles.maxPillText}>Max</Text>
            </Pressable>
          </View>
        </View>

        {asset.kind === 'token' && dest === 'l1' && (
          <ErrorInline
            title="ERC-20 tokens live on the EVM runtime"
            detail="Pick a 0x recipient — Michelson-runtime destinations aren’t valid for this asset."
          />
        )}
      </ScrollView>

      <View style={styles.actionBar}>
        <Btn variant="accent" full disabled={!valid} onPress={() => setStage('review')}>
          Review
        </Btn>
      </View>

      {assetOpen && (
        <Sheet title="Select asset" onClose={() => setAssetOpen(false)}>
          <View style={styles.sheetBody}>
            {assets.map((a) => (
              <Pressable
                key={a.symbol}
                style={({ pressed }) => [styles.assetRow, pressed && styles.assetRowPressed]}
                onPress={() => {
                  setAsset(a);
                  setAssetOpen(false);
                }}
              >
                <AssetMark symbol={a.symbol} kind={a.kind} />
                <View style={styles.assetRowBody}>
                  <Text style={styles.assetRowName}>{a.symbol}</Text>
                  <Text style={styles.assetRowSub}>
                    {a.kind === 'xtz' ? 'Native asset' : 'ERC-20 · EVM runtime'}
                  </Text>
                </View>
                {a.symbol === asset.symbol && <Icon name="check" size={20} color={colors.purple} />}
              </Pressable>
            ))}
            <Pressable
              style={({ pressed }) => [styles.linkRow, pressed && styles.assetRowPressed]}
              onPress={() => {
                setAssetOpen(false);
                ctx.nav.push('addToken');
              }}
            >
              <View style={styles.linkRowIco}>
                <Icon name="plus" size={18} color={colors.fgMuted} />
              </View>
              <Text style={styles.linkRowTitle}>Add token</Text>
            </Pressable>
          </View>
        </Sheet>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, minHeight: 0, backgroundColor: colors.bg },
  scroll: { flex: 1, minHeight: 0 },
  // Line renders a non-string value raw, so this style stands alone and must
  // carry its own colour — nothing above it to inherit from.
  mono: { fontFamily: font.mono, letterSpacing: -0.1, color: colors.fg },

  formScroll: { paddingTop: 6, paddingHorizontal: 16, paddingBottom: 16 },
  reviewScroll: { padding: 16 },
  doneScroll: { paddingHorizontal: space[5], paddingBottom: 16, alignItems: 'center' },

  kicker: {
    fontSize: 11,
    letterSpacing: 0.99,
    textTransform: 'uppercase',
    color: colors.fgSubtle,
    fontWeight: '600',
  },
  kickerFirst: { paddingTop: 10, paddingBottom: 8 },
  kickerRecipient: { paddingTop: 18, paddingBottom: 8 },
  kickerAmount: { paddingTop: 20, paddingBottom: 8 },
  crossKicker: { marginTop: space[4], marginBottom: 6 },

  assetPicker: {
    backgroundColor: colors.surface2,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
  },
  assetPickerPressed: { backgroundColor: colors.surface3 },
  assetPickerBody: { flex: 1 },
  assetPickerName: { fontSize: fontSize.md, fontWeight: '500', color: colors.fg },
  assetPickerSub: { fontSize: fontSize.sm, color: colors.fgMuted, marginTop: 1 },

  input: {
    width: '100%',
    backgroundColor: colors.surface2,
    borderWidth: 1.5,
    borderColor: 'transparent',
    borderRadius: radius.md,
    color: colors.fg,
    fontSize: fontSize.sm,
    height: 52,
    paddingHorizontal: 16,
    letterSpacing: -0.1,
    fontFamily: font.mono,
  },

  contactHint: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 4,
  },
  contactHintLabel: { fontSize: fontSize.sm, color: colors.fgMuted, fontWeight: '500', flexShrink: 1 },
  contactHintAddr: { fontSize: fontSize.xs, color: colors.fgSubtle, fontFamily: font.mono },
  suggestions: {
    marginTop: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  suggestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  suggestRowPressed: { backgroundColor: colors.surface2 },
  suggestLabel: { fontSize: fontSize.sm, fontWeight: '500', color: colors.fg, flexShrink: 1 },
  suggestAddr: { fontSize: fontSize.xs, color: colors.fgMuted, fontFamily: font.mono },

  amountCard: { backgroundColor: colors.surface2, borderRadius: radius.md, padding: 18 },
  amountInput: {
    width: '100%',
    color: colors.fg,
    fontSize: fontSize['5xl'],
    fontWeight: '600',
    letterSpacing: -1.56,
    padding: 0,
    fontVariant: ['tabular-nums'],
  },
  avail: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    height: 28,
  },
  availTxt: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  availLbl: { fontSize: fontSize.sm, color: colors.fgSubtle },
  availSep: { fontSize: fontSize.sm, color: colors.fgSubtle },
  availNum: { fontSize: fontSize.sm, color: colors.fgMuted, fontFamily: font.mono, fontVariant: ['tabular-nums'] },
  availLow: { color: colors.danger },
  maxPill: {
    height: 28,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: colors.surface3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  maxPillPressed: { opacity: 0.85 },
  maxPillText: {
    color: colors.fgMuted,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.66,
    textTransform: 'uppercase',
  },

  // review
  lane: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  laneSide: {
    flex: 1,
    backgroundColor: colors.surface2,
    borderRadius: radius.md,
    padding: 13,
    gap: 6,
    minWidth: 0,
  },
  laneK: { fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.63, color: colors.fgSubtle },
  laneName: { fontSize: fontSize.sm, fontWeight: '600', color: colors.fg },
  laneV: { fontSize: fontSize.sm, color: colors.fg, letterSpacing: -0.1, fontFamily: font.mono },
  laneArrow: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  laneArrowCross: { backgroundColor: colors.purple },

  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
  },
  divider: { height: 1, backgroundColor: colors.border },

  warnBanner: {
    marginTop: 14,
    flexDirection: 'row',
    gap: 12,
    padding: 14,
    backgroundColor: colors.dangerBg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(255,93,93,0.18)',
  },
  warnIco: { width: 20, alignItems: 'center' },
  warnBody: { flex: 1 },
  warnTitle: { fontSize: fontSize.sm, fontWeight: '600', color: colors.danger },
  warnDetail: { fontSize: fontSize.xs, color: colors.fgMuted, lineHeight: 18, marginTop: 3 },

  explainer: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    paddingVertical: 14,
    paddingHorizontal: 4,
  },
  explainerText: { flex: 1, fontSize: fontSize.xs, color: colors.fgSubtle, lineHeight: 18 },

  // done
  statusHero: { alignItems: 'center', gap: 16, paddingTop: 28, paddingBottom: 12 },
  heroText: { alignItems: 'center' },
  sAmt: {
    fontSize: fontSize['2xl'],
    fontWeight: '600',
    letterSpacing: -0.48,
    color: colors.fg,
    fontVariant: ['tabular-nums'],
  },
  sTo: { fontSize: fontSize.sm, color: colors.fgMuted, marginTop: 4 },
  doneCard: {
    width: '100%',
    marginTop: 12,
    backgroundColor: colors.surface2,
    borderRadius: radius.lg,
  },
  failIco: {
    width: 84,
    height: 84,
    borderRadius: 42,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.dangerBg,
    borderWidth: 2,
    borderColor: 'rgba(255,93,93,0.4)',
  },
  failWrap: { width: '100%', marginTop: 4 },
  explorerVal: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  explorerText: { fontSize: fontSize.md, color: colors.fg },
  unresolvedNote: {
    fontSize: fontSize.xs,
    color: colors.fgSubtle,
    marginTop: 12,
    lineHeight: 18,
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  saveContact: {
    width: '100%',
    marginTop: 12,
    backgroundColor: colors.surface2,
    borderRadius: radius.lg,
    padding: 14,
  },
  saveContactTitle: { fontSize: fontSize.sm, fontWeight: '600', color: colors.fgMuted, marginBottom: 10 },
  saveContactRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  saveContactInput: {
    flex: 1,
    minWidth: 0,
    backgroundColor: colors.surface3,
    borderWidth: 1.5,
    borderColor: 'transparent',
    borderRadius: radius.sm,
    color: colors.fg,
    fontSize: fontSize.sm,
    height: 38,
    paddingHorizontal: 12,
  },
  reviewErr: { marginTop: 14 },

  actionBar: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12 + 30,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
    flexDirection: 'row',
    gap: 10,
  },

  // Same amber band pattern as the Activity/Home stale bands.
  offlineNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
    paddingHorizontal: 16,
    backgroundColor: 'rgba(255,184,76,0.07)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,184,76,0.18)',
  },
  offlineNoteText: { flex: 1, fontSize: fontSize.xs, color: colors.fgMuted },

  // asset sheet
  sheetBody: { paddingBottom: 8 },
  assetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 13,
    paddingHorizontal: 4,
    borderRadius: radius.md,
  },
  assetRowPressed: { backgroundColor: colors.surface2 },
  assetRowBody: { flex: 1, minWidth: 0 },
  assetRowName: { fontSize: fontSize.md, fontWeight: '500', color: colors.fg },
  assetRowSub: { fontSize: fontSize.sm, color: colors.fgMuted, marginTop: 1 },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 13,
    paddingHorizontal: 4,
    borderRadius: radius.md,
  },
  linkRowIco: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkRowTitle: { fontSize: fontSize.md, fontWeight: '500', color: colors.fg },
});
