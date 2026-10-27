import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { deleteAsideCopy, listAsideCopies, shareAsideCopy, shareSeparately, sweepExports } from "@/features/data/asideCopies";
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

interface SeparateShare {
  readonly copy: AsideCopy;
  readonly fileCount: number;
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
  const [separate, setSeparate] = useState<SeparateShare | null>(null);

  useEffect(() => {
    if (open) sweepExports();
  }, [open]);

  const close = (): void => {
    setConfirming(null);
    setSeparate(null);
    onClose();
  };

  const run = (copy: AsideCopy, task: () => Promise<void>): void => {
    setSharing(copy.name);
    task()
      .catch((error: unknown) => ErrorUtils.getGlobalHandler()(error, false))
      .finally(() => {
        aside.refresh();
        setSharing(null);
      });
  };

  const share = (copy: AsideCopy): void =>
    run(copy, async () => {
      const outcome = await shareAsideCopy(copy);
      if (outcome.kind === "separate") setSeparate({ copy, fileCount: outcome.fileCount });
    });

  if (separate !== null) {
    return (
      <Sheet open={open} title={`${separate.fileCount} fichiers à garder ensemble`} context="Cette copie ne peut pas être réunie en un seul fichier. Partage-les ensemble vers le même dossier, sans les renommer." onClose={close}>
        <View style={styles.confirm}>
          <MenuItem
            label={`Partager les ${separate.fileCount} fichiers`}
            detail="Un partage par fichier"
            onPress={() => {
              setSeparate(null);
              run(separate.copy, () => shareSeparately(separate.copy));
            }}
          />
          <MenuItem label="Retour" onPress={() => setSeparate(null)} />
        </View>
      </Sheet>
    );
  }

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
