import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Animated, KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { easeOut } from "@/ui/motion";
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
  const progress = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(open);
  const [sheetHeight, setSheetHeight] = useState(windowHeight);

  useEffect(() => {
    if (open) setMounted(true);
    Animated.timing(progress, {
      toValue: open ? 1 : 0,
      duration: reduceMotion ? 0 : durations.sheet,
      easing: easeOut,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !open) setMounted(false);
    });
  }, [open, reduceMotion, progress]);

  return (
    <Modal transparent visible={mounted} animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior="padding" style={styles.sheetRoot}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim, opacity: progress }]}>
          <Pressable accessibilityLabel="Fermer" style={StyleSheet.absoluteFill} onPress={onClose} />
        </Animated.View>
        <Animated.View
          accessibilityViewIsModal
          onLayout={(event) => setSheetHeight(event.nativeEvent.layout.height)}
          style={[
            styles.sheet,
            {
              backgroundColor: colors.sheetBg,
              paddingBottom: insets.bottom + 16,
              transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [sheetHeight, 0] }) }],
            },
          ]}
        >
          <View style={[styles.grabber, { backgroundColor: colors.controlBorder }]} />
          <Text variant="sheetTitle" accessibilityRole="header">
            {title}
          </Text>
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
  const { colors, reduceMotion } = useTheme();
  const progress = useRef(new Animated.Value(0)).current;
  const [shown, setShown] = useState(message);

  useEffect(() => {
    if (message !== null) setShown(message);
    Animated.timing(progress, {
      toValue: message === null ? 0 : 1,
      duration: reduceMotion ? 0 : durations.state,
      easing: easeOut,
      useNativeDriver: true,
    }).start();
  }, [message, reduceMotion, progress]);

  return (
    <Animated.View
      accessibilityLiveRegion="polite"
      pointerEvents={message === null ? "none" : "auto"}
      style={[
        styles.snackbar,
        {
          bottom,
          backgroundColor: colors.snackbarBg,
          opacity: progress,
          transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
        },
      ]}
    >
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
  sheetContext: { marginTop: 4, marginBottom: 12 },
  snackbar: {
    position: "absolute",
    left: 12,
    right: 12,
    minHeight: 52,
    paddingVertical: 4,
    paddingRight: 4,
    paddingLeft: 16,
    borderRadius: radii.panel,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  snackbarMessage: { flex: 1, paddingVertical: 8, lineHeight: 20 },
  snackbarAction: { height: 48, paddingHorizontal: 14, borderRadius: radii.control, justifyContent: "center" },
  snackbarActionLabel: { fontFamily: fonts.text700, textDecorationLine: "underline" },
});
