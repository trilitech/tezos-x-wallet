/**
 * KeyboardScroll — the scroll body for any screen that hosts a TextInput.
 *
 * On iOS the native scroll view measures its own bottom edge against the
 * keyboard frame in window coordinates, insets itself by the real overlap and
 * scrolls the focused field into view on the keyboard's own animation curve. It
 * measures rather than assumes, so nothing has to be guessed about the height
 * of the experimental banner, the TopBar, a sticky action bar or the safe-area
 * insets — which is why this is preferred here over KeyboardAvoidingView, whose
 * padding is computed from a parent-relative layout frame and therefore needs a
 * per-surface vertical offset.
 *
 * On Android the prop is inert; keyboard avoidance comes from the window resize
 * declared in the manifest.
 *
 * `keyboardShouldPersistTaps="handled"` is part of the primitive because the
 * default ("never") makes the keyboard dismissal swallow the first press on any
 * control rendered inside the scroll body.
 */

import { ScrollView, type ScrollViewProps } from 'react-native';

export function KeyboardScroll(props: ScrollViewProps): React.JSX.Element {
  return (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      {...props}
    />
  );
}
