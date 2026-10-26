import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { daysBetween, localDateOf, replacedSnapshots, restoreBlocker, restoreMutation, trashItems, trashRetentionMs } from "@obnixe/core";
import type { RestoreBlocker, TrashItem } from "@obnixe/core";
import { sports, zones } from "@obnixe/schema";
import type { Backup, EpochMs, MassUnit } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { write } from "@/data/write";
import { restoreReplaced } from "@/features/data/backup";
import { deviceTimeZone, shortDate } from "@/format/dates";
import { useDatabaseVersion } from "@/features/data/useDatabaseVersion";
import { LinkButton } from "@/ui/Button";
import { Choices } from "@/ui/Inputs";
import { Sheet } from "@/ui/Overlays";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";

const trashTables = ["session", "weigh_in", "measurement", "photo", "check_in", "pain_report", "backup"] as const;

export interface TrashContents {
  readonly items: readonly TrashItem[];
  readonly replaced: readonly Backup[];
}

export function useTrash(): TrashContents {
  useDatabaseVersion(trashTables);
  return { items: trashItems(db()), replaced: replacedSnapshots(db()) };
}

function massLabel(grams: number, unit: MassUnit): string {
  const value = unit === "kg" ? grams / 1000 : grams / 453.59237;
  return `${value.toFixed(1).replace(".", ",")} ${unit}`;
}

function itemTitle(item: TrashItem, unit: MassUnit): string {
  switch (item.table) {
    case "session":
      return `${item.row.title ?? sports[item.row.sport].label} · ${shortDate(item.row.localDate)}`;
    case "weigh_in":
      return `Pesée ${massLabel(item.row.grams, unit)} · ${shortDate(item.row.localDate)}`;
    case "measurement":
      return `Mensuration · ${shortDate(item.row.localDate)}`;
    case "photo":
      return `Photo · ${shortDate(item.row.localDate)}`;
    case "check_in":
      return `Forme du jour · ${shortDate(item.row.localDate)}`;
    case "pain_report":
      return `${zones[item.row.zone].label} · ${shortDate(item.row.localDate)}`;
    default: {
      const unreachable: never = item;
      throw new Error(`Unhandled trash item ${JSON.stringify(unreachable)}`);
    }
  }
}

function blockerLabel(blocker: RestoreBlocker): string {
  switch (blocker) {
    case "day_taken":
      return "ce jour a déjà une valeur";
    case "session_open":
      return "une séance est en cours";
    case "zone_taken":
      return "zone déjà notée ce jour-là";
    default: {
      const unreachable: never = blocker;
      return unreachable;
    }
  }
}

function remaining(expiresAt: number, now: EpochMs): string {
  const timeZone = deviceTimeZone();
  const days = Math.max(0, daysBetween(localDateOf(now, timeZone), localDateOf(expiresAt as EpochMs, timeZone)));
  return days <= 1 ? "effacé demain" : `encore ${days} jours`;
}

interface TrashSheetProps {
  readonly open: boolean;
  readonly massUnit: MassUnit;
  readonly onClose: () => void;
}

export function TrashSheet({ open, massUnit, onClose }: TrashSheetProps) {
  const { colors } = useTheme();
  const { items, replaced } = useTrash();
  const [confirming, setConfirming] = useState<Backup | null>(null);
  const [restoring, setRestoring] = useState(false);
  const now = environment.now();
  const empty = items.length === 0 && replaced.length === 0;

  const close = (): void => {
    if (restoring) return;
    setConfirming(null);
    onClose();
  };

  const restoreSnapshot = async (row: Backup): Promise<void> => {
    setRestoring(true);
    try {
      await restoreReplaced(row);
    } finally {
      setRestoring(false);
      setConfirming(null);
    }
  };

  if (confirming !== null) {
    return (
      <Sheet open={open} title="Revenir aux données remplacées ?" context="Les données actuelles passent à leur tour dans la corbeille, 30 jours" onClose={close}>
        <Choices
          items={[
            { value: "restore", label: restoring ? "Restauration…" : "Revenir à ces données", primary: true },
            { value: "keep", label: "Garder les données actuelles" },
          ]}
          onChoose={(choice: "restore" | "keep") => {
            if (restoring) return;
            if (choice === "restore") void restoreSnapshot(confirming);
            else setConfirming(null);
          }}
        />
      </Sheet>
    );
  }

  return (
    <Sheet open={open} title="Corbeille" context="Effacé pour de bon après 30 jours" onClose={close}>
      {empty ? (
        <Text tone="secondary" style={styles.empty}>
          Rien dans la corbeille
        </Text>
      ) : null}
      <View>
        {replaced.map((row) => (
          <View key={row.id} style={[styles.row, { borderTopColor: colors.line }]}>
            <View style={styles.main}>
              <Text variant="bodyStrong">Données remplacées · {shortDate(localDateOf(row.createdAt, deviceTimeZone()))}</Text>
              <Text variant="small" tone="secondary">
                avant un import · {remaining(row.createdAt + trashRetentionMs, now)}
              </Text>
            </View>
            <LinkButton label="Restaurer" onPress={() => setConfirming(row)} />
          </View>
        ))}
        {items.map((item) => {
          const blocker = restoreBlocker(db(), item);
          return (
            <View key={`${item.table}:${item.row.id}`} style={[styles.row, { borderTopColor: colors.line }]}>
              <View style={styles.main}>
                <Text variant="bodyStrong" numberOfLines={1}>
                  {itemTitle(item, massUnit)}
                </Text>
                <Text variant="small" tone="secondary">
                  {blocker === null ? remaining(item.expiresAt, now) : blockerLabel(blocker)}
                </Text>
              </View>
              <LinkButton label="Restaurer" disabled={blocker !== null} onPress={() => write(`Restauration : ${itemTitle(item, massUnit)}`, [restoreMutation(item)])} />
            </View>
          );
        })}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  empty: { marginTop: 8, marginBottom: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 60, paddingVertical: 8, borderTopWidth: 1 },
  main: { flex: 1, gap: 2 },
});
