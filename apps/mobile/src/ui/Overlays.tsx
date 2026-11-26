import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { easeOut, springs, useSpringTo } from "@/ui/motion";
import { Slash } from "@/ui/Shapes";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { durations, fonts, layout, radii } from "@/ui/tokens";

interface SheetProps {
  readonly open: boolean;
  readonly title: string;
  readonly context?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

export function Sheet({ open, title, context, onClose, children }: SheetProps) {
  const { colors, reduceMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const progress = useSharedValue(0);
  const [mounted, setMounted] = useState(open);
  const [sheetHeight, setSheetHeight] = useState(windowHeight);

  useEffect(() => {
    if (open) setMounted(true);
    const settle = (finished: boolean | undefined): void => {
      "worklet";
      if (finished === true && !open) scheduleOnRN(setMounted, false);
    };
    if (reduceMotion) progress.value = withTiming(open ? 1 : 0, { duration: 0 }, settle);
    else if (open) progress.value = withSpring(1, springs.settle, settle);
    else progress.value = withTiming(0, { duration: durations.sheet * 0.8, easing: easeOut }, settle);
  }, [open, reduceMotion, progress]);

  const scrimStyle = useAnimatedStyle(() => ({ opacity: Math.min(1, progress.value) }));
  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - progress.value) * sheetHeight }] }));

  return (
    <Modal transparent visible={mounted} animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior="padding" style={styles.sheetRoot}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }, scrimStyle]}>
          <Pressable accessibilityLabel="Fermer" style={StyleSheet.absoluteFill} onPress={onClose} />
        </Animated.View>
        <Animated.View
          accessibilityViewIsModal
          onLayout={(event) => setSheetHeight(event.nativeEvent.layout.height)}
          style={[styles.sheet, { backgroundColor: colors.sheetBg, paddingBottom: insets.bottom + 16 }, sheetStyle]}
        >
          <View style={[styles.grabber, { backgroundColor: colors.controlBorder }]} />
          <View style={styles.sheetHead}>
            <Slash color={colors.mark} width={11} height={16} />
            <Text variant="sheetTitle" accessibilityRole="header" style={styles.sheetTitle}>
              {title}
            </Text>
          </View>
          {context === undefined ? null : (
            <Text variant="small" tone="secondary" style={styles.sheetContext}>
              {context}
            </Text>
          )}
          <ScrollView bounces={false} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

interface SnackbarProps {
  readonly message: string | null;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly bottom: number;
}

export function Snackbar({ message, actionLabel, onAction, bottom }: SnackbarProps) {
  const { colors } = useTheme();
  const progress = useSpringTo(message === null ? 0 : 1);
  const [shown, setShown] = useState(message);

  useEffect(() => {
    if (message !== null) setShown(message);
  }, [message]);

  const style = useAnimatedStyle(() => ({
    opacity: Math.min(1, progress.value),
    transform: [{ translateY: (1 - progress.value) * 16 }, { scale: 0.96 + 0.04 * progress.value }],
  }));

  return (
    <Animated.View
      accessibilityLiveRegion="polite"
      pointerEvents={message === null ? "none" : "auto"}
      style={[styles.snackbar, { bottom, backgroundColor: colors.snackbarBg }, style]}
    >
      <View style={[styles.snackbarMark, { backgroundColor: colors.brand }]} />
      <Text variant="label" style={[styles.snackbarMessage, { color: colors.snackbarInk }]}>
        {shown}
      </Text>
      {actionLabel === undefined || onAction === undefined ? null : (
        <Pressable accessibilityRole="button" onPress={onAction} style={styles.snackbarAction}>
          <Text variant="label" style={[styles.snackbarActionLabel, { color: colors.snackbarInk }]}>
            {actionLabel}
          </Text>
        </Pressable>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheetRoot: { flex: 1, justifyContent: "flex-end" },
  sheet: {
    maxHeight: "88%",
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    paddingTop: 10,
    paddingHorizontal: layout.gutter,
  },
  grabber: { width: 40, height: 4, borderRadius: 2, alignSelf: "center", marginBottom: 16 },
  sheetHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  sheetTitle: { flexShrink: 1 },
  sheetContext: { marginTop: 4, marginBottom: 12 },
  snackbar: {
    position: "absolute",
    left: 12,
    right: 12,
    minHeight: 52,
    paddingVertical: 4,
    paddingRight: 4,
    paddingLeft: 18,
    borderRadius: radii.panel,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    overflow: "hidden",
  },
  snackbarMark: { position: "absolute", left: 0, top: 0, bottom: 0, width: 5 },
  snackbarMessage: { flex: 1, paddingVertical: 8, lineHeight: 20 },
  snackbarAction: { height: 48, paddingHorizontal: 14, borderRadius: radii.control, justifyContent: "center" },
  snackbarActionLabel: { fontFamily: fonts.text700, textDecorationLine: "underline" },
});
