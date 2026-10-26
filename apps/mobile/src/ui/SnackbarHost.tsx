import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Snackbar } from "@/ui/Overlays";
import { layout } from "@/ui/tokens";

export interface SnackbarAction {
  readonly label: string;
  readonly run: () => void;
}

export interface SnackbarMessage {
  readonly text: string;
  readonly action?: SnackbarAction;
  readonly aboveTabBar?: boolean;
  readonly extraOffset?: number;
}

type Notify = (message: SnackbarMessage) => void;

const SnackbarContext = createContext<Notify>(() => undefined);

const visibleMs = 5000;
const visibleWithActionMs = 8000;

interface SnackbarHostProps {
  readonly children: ReactNode;
}

export function SnackbarHost({ children }: SnackbarHostProps) {
  const insets = useSafeAreaInsets();
  const [message, setMessage] = useState<SnackbarMessage | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback<Notify>((next) => {
    if (timer.current !== null) clearTimeout(timer.current);
    setMessage(next);
    timer.current = setTimeout(() => setMessage(null), next.action === undefined ? visibleMs : visibleWithActionMs);
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const action = message?.action;
  const bottom = insets.bottom + 8 + (message?.aboveTabBar === false ? 0 : layout.tabbarHeight) + (message?.extraOffset ?? 0);
  const value = useMemo(() => notify, [notify]);

  return (
    <SnackbarContext.Provider value={value}>
      <View style={styles.root}>
        {children}
        <Snackbar
          message={message?.text ?? null}
          bottom={bottom}
          {...(action === undefined
            ? {}
            : {
                actionLabel: action.label,
                onAction: () => {
                  setMessage(null);
                  action.run();
                },
              })}
        />
      </View>
    </SnackbarContext.Provider>
  );
}

export function useSnackbar(): Notify {
  return useContext(SnackbarContext);
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
