import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import { deleteAsideCopy, listAsideCopies, shareAsideCopy } from "@/features/data/asideCopies";
import type { AsideCopy } from "@/features/data/asideCopies";
import { fileSize, longDateTime } from "@/features/data/format";
import { capitalize } from "@/format/labels";
import { LinkButton } from "@/ui/Button";
import { MenuItem } from "@/ui/Inputs";
import { Sheet } from "@/ui/Overlays";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";

export interface AsideCopies {
  readonly copies: readonly AsideCopy[];
  readonly refresh: () => void;
}

export function useAsideCopies(): AsideCopies {
  const [copies, setCopies] = useState<readonly AsideCopy[]>(listAsideCopies);
  const refresh = useCallback(() => setCopies(listAsideCopies()), []);
  return { copies, refresh };
}

interface AsideSheetProps {
  readonly open: boolean;
  readonly aside: AsideCopies;
  readonly onClose: () => void;
}

export function AsideSheet({ open, aside, onClose }: AsideSheetProps) {
  const { colors } = useTheme();
  const [confirming, setConfirming] = useState<AsideCopy | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);

  const close = (): void => {
    setConfirming(null);
    onClose();
  };

  const share = (copy: AsideCopy): void => {
    setSharing(copy.name);
    shareAsideCopy(copy)
      .catch((error: unknown) => ErrorUtils.getGlobalHandler()(error, false))
      .finally(() => {
        aside.refresh();
        setSharing(null);
      });
  };

  if (confirming !== null) {
    return (
      <Sheet open={open} title="Supprimer cette copie ?" context={`Mise de côté le ${longDateTime(confirming.setAsideAt)} · ${fileSize(confirming.bytes)}. Elle ne pourra pas être récupérée.`} onClose={close}>
        <View style={styles.confirm}>
          <MenuItem
            label="Supprimer la copie"
            destructive
            onPress={() => {
              deleteAsideCopy(confirming);
              aside.refresh();
              if (aside.copies.length <= 1) onClose();
              setConfirming(null);
            }}
          />
          <MenuItem label="Garder" onPress={() => setConfirming(null)} />
        </View>
      </Sheet>
    );
  }

  return (
    <Sheet open={open} title="Copies mises de côté" context="Bases illisibles mises de côté au démarrage" onClose={close}>
      {aside.copies.length === 0 ? (
        <Text tone="secondary" style={styles.empty}>
          Aucune copie
        </Text>
      ) : null}
      <View>
        {aside.copies.map((copy) => (
          <View key={copy.name} style={[styles.row, { borderTopColor: colors.line }]}>
            <View style={styles.main}>
              <Text variant="bodyStrong" numberOfLines={1}>
                {capitalize(longDateTime(copy.setAsideAt))}
              </Text>
              <Text variant="small" tone="secondary">
                {copy.raw ? `${fileSize(copy.bytes)} · copie brute` : fileSize(copy.bytes)}
              </Text>
            </View>
            <LinkButton label={sharing === copy.name ? "Partage…" : "Partager"} disabled={sharing !== null} onPress={() => share(copy)} />
            <LinkButton label="Supprimer" disabled={sharing !== null} onPress={() => setConfirming(copy)} />
          </View>
        ))}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  empty: { marginTop: 8, marginBottom: 8 },
  confirm: { marginTop: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 60, paddingVertical: 8, borderTopWidth: 1 },
  main: { flex: 1, gap: 2 },
});
