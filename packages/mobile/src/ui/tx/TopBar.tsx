/**
 * TopBar — the screen header (mirrors mobile.css .topbar). Optional back chevron,
 * a leading slot, then either a centered title, a left-aligned title, or a
 * spacer; trailing action slot on the right. Fixed 54px height with a hairline
 * bottom border.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fontSize } from '../../theme';
import { Icon } from '../icon';

export function TopBar({
  title,
  onBack,
  left,
  right,
  center,
}: {
  title?: string;
  onBack?: () => void;
  left?: React.ReactNode;
  right?: React.ReactNode;
  center?: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.bar}>
      {onBack != null && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={onBack}
          style={({ pressed }) => [styles.back, pressed && styles.backPressed]}
        >
          <Icon name="chevron-left" size={24} color={colors.fg} />
        </Pressable>
      )}
      {left}
      {center != null ? (
        <View style={styles.center}>
          {typeof center === 'string' ? <Text style={styles.centerText}>{center}</Text> : center}
        </View>
      ) : title != null ? (
        <Text style={[styles.title, { marginLeft: onBack != null ? 2 : 4 }]}>{title}</Text>
      ) : (
        <View style={styles.grow} />
      )}
      {center == null && <View style={styles.grow} />}
      {right != null && <View style={styles.actions}>{right}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: 54,
    paddingLeft: 12,
    paddingRight: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  back: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    marginLeft: -4,
  },
  backPressed: { backgroundColor: colors.surface2 },
  title: { fontSize: fontSize.lg, fontWeight: '600', letterSpacing: -0.17, color: colors.fg },
  center: { flex: 1, alignItems: 'center' },
  centerText: { fontSize: fontSize.lg, fontWeight: '600', letterSpacing: -0.17, color: colors.fg },
  grow: { flex: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
});
