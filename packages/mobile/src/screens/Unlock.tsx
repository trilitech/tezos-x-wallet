/**
 * Unlock — the returning-user password screen (mirrors the design's
 * UnlockScreen). Brand mark + "Welcome back", a single password field, and a
 * forgot-password link opening the reset-and-re-import recovery sheet (the
 * password is unrecoverable by design, so recovery wipes the vault and walks
 * back through onboarding). Biometric-first (the sealed password is released
 * by Face ID / Touch ID), with a password fallback; errors surface through
 * formatError.
 */

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { formatError, isAuthError, type FormattedError } from '@tezosx/wallet-core/domain/error';
import { colors, fontSize, radius, space } from '../theme';
import { useWallet } from '../wallet/context';
import { Btn } from '../ui/tx/Btn';
import { Check } from '../ui/tx/Check';
import { ErrorCard } from '../ui/tx/ErrorCard';
import { ErrorInline } from '../ui/tx/ErrorInline';
import { KeyboardScroll } from '../ui/tx/KeyboardScroll';
import { Sheet } from '../ui/tx/Sheet';
import { Icon } from '../ui/icon';
import { LogoMark } from '../ui/tx/LogoMark';

export function Unlock(): React.JSX.Element {
  const ctx = useWallet();
  const [pwd, setPwd] = useState('');
  const [err, setErr] = useState<FormattedError | null>(null);
  const [busy, setBusy] = useState(false);
  const [recover, setRecover] = useState(false);

  // Prompt biometrics on mount when a sealed secret is available. A user
  // cancel (or unusable hardware) surfaces as `false` — the Keychain adapter
  // returns null instead of rejecting there — and stays silent: password entry
  // is the fallback. A real rejection (unlock throttle, corrupted vault) must
  // be shown, not swallowed.
  useEffect(() => {
    if (ctx.biometricsAvailable) {
      void ctx.unlockBiometric().catch((e: unknown) => setErr(formatError(e)));
    }
  }, [ctx.biometricsAvailable]);

  const submit = (): void => {
    if (!pwd || busy) return;
    setErr(null);
    setBusy(true);
    void (async () => {
      try {
        await ctx.unlock(pwd);
        // Drop the reference now rather than at fiber GC — a JS string can't
        // be overwritten, but nothing should keep pointing at it either.
        setPwd('');
      } catch (e) {
        setErr(formatError(e));
        // Clear the field only when the password itself was refused. On a
        // network/internal failure wiping the typing would read as "wrong
        // password" and cost the user a re-type for nothing.
        if (isAuthError(e)) setPwd('');
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <View style={styles.screen}>
      <KeyboardScroll contentContainerStyle={styles.scroll}>
        <View style={styles.hero}>
          <LogoMark size={56} />
          <View style={styles.pitch}>
            <Text style={styles.title}>Welcome back</Text>
            <Text style={styles.sub}>Enter your password to unlock.</Text>
          </View>
        </View>

        <View style={styles.form}>
          <TextInput
            style={styles.input}
            secureTextEntry
            autoFocus
            value={pwd}
            placeholder="Password"
            placeholderTextColor={colors.fgSubtle}
            autoCapitalize="none"
            onChangeText={(v) => {
              setPwd(v);
              setErr(null);
            }}
            onSubmitEditing={submit}
            returnKeyType="go"
          />
          {err != null && <ErrorInline title={err.title} detail={err.detail} />}
          <Btn variant="accent" full loading={busy} disabled={!pwd} onPress={submit}>
            Unlock
          </Btn>
          {ctx.biometricsAvailable && (
            <Btn
              variant="ghost"
              full
              disabled={busy}
              // Cancel resolves false (silent — password entry remains); a real
              // rejection is shown like a failed password unlock would be.
              onPress={() => {
                setErr(null);
                void ctx.unlockBiometric().catch((e: unknown) => setErr(formatError(e)));
              }}
            >
              <Icon name="lock" size={15} color={colors.fgMuted} />
              <Text style={styles.bioText}>Use biometrics</Text>
            </Btn>
          )}
        </View>

        <Pressable onPress={() => setRecover(true)} style={styles.forgot}>
          <Text style={styles.forgotText}>Forgot password? Reset wallet and re-import</Text>
        </Pressable>
      </KeyboardScroll>

      {recover && <RecoverySheet onClose={() => setRecover(false)} />}
    </View>
  );
}

/**
 * The forgot-password recovery sheet. The password is unrecoverable by design,
 * so the only way forward is wiping the vault and re-importing from the seed
 * phrase — the sheet is explicit about what that recovers, what it does not,
 * and what is kept, and requires an acknowledgement before the danger button
 * arms. On success the provider drops to onboarding (Welcome → Import).
 */
function RecoverySheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const ctx = useWallet();
  const [acked, setAcked] = useState(false);
  const [err, setErr] = useState<FormattedError | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (): void => {
    if (!acked || busy) return;
    setErr(null);
    setBusy(true);
    void (async () => {
      try {
        await ctx.resetWallet();
        // The provider now shows onboarding; this whole screen unmounts.
      } catch (e) {
        setErr(formatError(e));
        setBusy(false);
      }
    })();
  };

  return (
    <Sheet title="Reset wallet" onClose={onClose}>
      <View style={styles.recoverBody}>
        <Text style={styles.recoverIntro}>
          Your password cannot be recovered. To regain access, erase the wallet on this device and
          re-import it with your seed phrase.
        </Text>

        <RecoverGroup icon="check" tone="success" label="Recovered">
          Accounts derived from your seed phrase — re-importing the phrase restores them at the same
          addresses.
        </RecoverGroup>
        <RecoverGroup icon="x" tone="danger" label="Not recovered">
          Accounts imported from a raw private key (Tezos edsk or EVM 0x key) and your account
          labels — re-import those keys separately.
        </RecoverGroup>
        <RecoverGroup icon="list" tone="muted" label="Kept">
          Your contacts stay on this device.
        </RecoverGroup>

        <View style={styles.recoverAck}>
          <Check checked={acked} onToggle={setAcked}>
            I understand the wallet on this device will be erased and my seed phrase is the only way
            to restore my accounts.
          </Check>
        </View>

        {err != null && <ErrorCard title={err.title} detail={err.detail} />}

        <Btn variant="danger" full loading={busy} disabled={!acked} onPress={submit} style={styles.recoverBtn}>
          Reset wallet & re-import
        </Btn>
      </View>
    </Sheet>
  );
}

const GROUP_TONES = {
  success: colors.success,
  danger:  colors.danger,
  muted:   colors.fgMuted,
} as const;

function RecoverGroup({
  icon,
  tone,
  label,
  children,
}: {
  icon: 'check' | 'x' | 'list';
  tone: keyof typeof GROUP_TONES;
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.recoverGroup}>
      <View style={styles.recoverHead}>
        <Icon name={icon} size={14} color={GROUP_TONES[tone]} strokeWidth={2.4} />
        <Text style={[styles.recoverLabel, { color: GROUP_TONES[tone] }]}>{label}</Text>
      </View>
      <Text style={styles.recoverText}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scroll: { flexGrow: 1, paddingHorizontal: 28, paddingTop: 44, paddingBottom: space[6] },
  hero: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 18 },
  pitch: { alignItems: 'center' },
  title: { fontSize: fontSize['2xl'], fontWeight: '600', letterSpacing: -0.36, color: colors.fg },
  sub: { fontSize: fontSize.md, color: colors.fgMuted, marginTop: space[2] },
  form: { gap: space[3] },
  input: {
    backgroundColor: colors.surface2,
    borderWidth: 1.5,
    borderColor: 'transparent',
    borderRadius: radius.md,
    color: colors.fg,
    fontSize: fontSize.md,
    height: 52,
    paddingHorizontal: 16,
  },
  bioText: { color: colors.fgMuted, fontSize: fontSize.md, fontWeight: '600' },
  forgot: { marginTop: space[4], alignItems: 'center' },
  forgotText: { color: colors.fgMuted, fontSize: fontSize.sm },

  recoverBody: { paddingHorizontal: 4, paddingTop: 4, paddingBottom: 16 },
  recoverIntro: { fontSize: fontSize.sm, color: colors.fgMuted, lineHeight: 20, marginBottom: space[4] },
  recoverGroup: { marginBottom: space[3] },
  recoverHead: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 3 },
  recoverLabel: { fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', fontWeight: '600' },
  recoverText: { fontSize: fontSize.sm, color: colors.fg, lineHeight: 20 },
  recoverAck: { marginTop: space[2], paddingVertical: space[2] },
  recoverBtn: { marginTop: space[3] },
});
