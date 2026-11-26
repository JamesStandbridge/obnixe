import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { CodedError } from "expo";
import { archiveFileName, archiveMimeType, exportableSessions, localDateOf } from "@obnixe/core";
import { db, environment } from "@/data/database";
import { periodStart, writeExportArchive } from "@/features/activityFiles/exportArchive";
import type { BulkExportFormat, ExportPeriod } from "@/features/activityFiles/exportArchive";
import { useExportPrivacy } from "@/features/activityFiles/exportPrivacy";
import { createStreamedFile } from "@/features/data/files";
import type { StreamedFile } from "@/features/data/files";
import { SwitchRow } from "@/features/data/parts";
import { useDatabaseVersion } from "@/features/data/useDatabaseVersion";
import { deviceTimeZone } from "@/format/dates";
import { plural } from "@/format/labels";
import { formatInteger } from "@/format/numbers";
import { PrimaryButton } from "@/ui/Button";
import { Segmented } from "@/ui/Controls";
import { Sheet } from "@/ui/Overlays";
import { useSnackbar } from "@/ui/SnackbarHost";
import { Text } from "@/ui/Text";

interface ExportArchiveSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

const formatOptions: readonly { readonly value: BulkExportFormat; readonly label: string }[] = [
  { value: "gpx", label: "GPX" },
  { value: "fit", label: "FIT" },
];

const periodOptions: readonly { readonly value: ExportPeriod; readonly label: string }[] = [
  { value: "all", label: "Tout" },
  { value: "year", label: "Cette année" },
  { value: "twelveMonths", label: "12 mois" },
  { value: "thirtyDays", label: "30 jours" },
];

const watchedTables = ["session", "recording"] as const;

/** « Exporter les activités » (`IO-005`): every activity with a track of the period, in one ZIP of GPX or FIT files. */
export function ExportArchiveSheet({ open, onClose }: ExportArchiveSheetProps) {
  const notify = useSnackbar();
  const privacy = useExportPrivacy();
  const version = useDatabaseVersion(watchedTables);
  const [format, setFormat] = useState<BulkExportFormat>("gpx");
  const [period, setPeriod] = useState<ExportPeriod>("all");
  const [includeFullTrack, setIncludeFullTrack] = useState<boolean | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const today = localDateOf(environment.now(), deviceTimeZone());
  const rows = useMemo(() => (open ? exportableSessions(db(), periodStart(period, today)) : []), [open, period, today, version]);
  if (privacy === null) return null;
  const fullTrack = !privacy.masks || (includeFullTrack ?? privacy.includeFullTrack);

  const close = (): void => {
    if (done !== null) return;
    setIncludeFullTrack(null);
    onClose();
  };

  const exportAll = async (): Promise<void> => {
    setDone(0);
    let file: StreamedFile | null = null;
    try {
      file = createStreamedFile(archiveFileName(today), archiveMimeType);
      const result = await writeExportArchive(rows, format, fullTrack, file, setDone);
      if (result.exported === 0) {
        file.discard();
        notify({ text: "Aucune trace lisible" });
        return;
      }
      setIncludeFullTrack(null);
      onClose();
      await file.share();
      if (result.skipped > 0) notify({ text: plural(result.skipped, "trace illisible ignorée", "traces illisibles ignorées") });
    } catch (error) {
      file?.discard();
      if (error instanceof CodedError) notify({ text: "Export impossible" });
      else throw error;
    } finally {
      setDone(null);
    }
  };

  return (
    <Sheet open={open} title="Exporter les activités" context="Une archive ZIP, un fichier par activité avec une trace" onClose={close}>
      <View style={styles.body}>
        <Segmented options={formatOptions} value={format} onChange={setFormat} />
        <Segmented options={periodOptions} value={period} onChange={setPeriod} />
        <Text variant="small" tone="secondary">
          {rows.length === 0 ? "Aucune activité avec une trace sur cette période." : plural(rows.length, "activité exportée", "activités exportées")}
        </Text>
        {privacy.masks ? (
          <SwitchRow title="Inclure la trace complète" detail={privacy.detail} value={fullTrack} onChange={setIncludeFullTrack} disabled={done !== null} />
        ) : (
          <Text variant="small" tone="secondary">
            Aucune zone de confidentialité : les traces sont exportées en entier.
          </Text>
        )}
        <PrimaryButton
          label={done === null ? "Partager l'archive" : `Préparation ${formatInteger(done)} sur ${formatInteger(rows.length)}`}
          disabled={done !== null || rows.length === 0}
          onPress={() => void exportAll()}
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: 16, paddingTop: 8 },
});
