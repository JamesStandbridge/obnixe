import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { desc, eq, isNull } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { CodedError } from "expo";
import { daysBetween, localDateOf } from "@obnixe/core";
import { backup, photo } from "@obnixe/schema";
import type { Backup, EpochMs } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { deviceTimeZone } from "@/format/dates";
import { exportBackup } from "@/features/data/backup";
import { NoticeMark, SwitchRow } from "@/features/data/parts";
import { PrimaryButton, SheetButton } from "@/ui/Button";
import { Panel, TextField } from "@/ui/Inputs";
import { Sheet } from "@/ui/Overlays";
import { useSnackbar } from "@/ui/SnackbarHost";
import { Text } from "@/ui/Text";
import { fonts } from "@/ui/tokens";

const staleAfterDays = 7;
const minimumPassphrase = 8;

interface BackupStatus {
  readonly label: string;
  readonly stale: boolean;
}

function backupStatus(last: Backup | undefined, hasPhotos: boolean, now: EpochMs): BackupStatus {
  if (last === undefined) return { label: "Jamais sauvegardé", stale: true };
  const suffix = hasPhotos && !last.includesPhotos ? " · sans photos" : "";
  const timeZone = deviceTimeZone();
  const days = daysBetween(localDateOf(last.createdAt, timeZone), localDateOf(now, timeZone));
  if (now - last.createdAt < 120_000) return { label: `Sauvegardée à l'instant${suffix}`, stale: false };
  if (days === 0) return { label: `Sauvegardée aujourd'hui${suffix}`, stale: false };
  if (days === 1) return { label: `Sauvegardée hier${suffix}`, stale: false };
  return { label: `Sauvegarde il y a ${days} jours${suffix}`, stale: days >= staleAfterDays };
}

export function BackupPanel() {
  const notify = useSnackbar();
  const { data: exports } = useLiveQuery(db().select().from(backup).where(eq(backup.kind, "export")).orderBy(desc(backup.createdAt)).limit(1));
  const { data: photos } = useLiveQuery(db().select({ id: photo.id }).from(photo).where(isNull(photo.deletedAt)).limit(1));
  const last = exports[0];
  const [includePhotos, setIncludePhotos] = useState(last?.includesPhotos ?? false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const status = backupStatus(last, photos.length > 0, environment.now());

  return (
    <Panel style={styles.panel}>
      <View style={styles.header} accessibilityRole="summary">
        {status.stale ? <NoticeMark /> : null}
        <Text variant="bodyStrong" style={styles.status}>
          {status.label}
        </Text>
      </View>
      {status.stale ? (
        <Text variant="small" tone="secondary" style={styles.warning}>
          Sans sauvegarde, perdre le téléphone efface tout.
        </Text>
      ) : null}
      <SwitchRow title="Inclure les photos" detail="chiffrées par ta phrase de passe" value={includePhotos} onChange={setIncludePhotos} />
      <PrimaryButton label="Exporter une sauvegarde" compact onPress={() => setSheetOpen(true)} style={styles.export} />
      <PassphraseSheet
        open={sheetOpen}
        includePhotos={includePhotos}
        onClose={() => setSheetOpen(false)}
        onExported={(fileName) => {
          setSheetOpen(false);
          notify({ text: `${fileName} exporté`, aboveTabBar: false });
        }}
      />
    </Panel>
  );
}

interface PassphraseSheetProps {
  readonly open: boolean;
  readonly includePhotos: boolean;
  readonly onClose: () => void;
  readonly onExported: (fileName: string) => void;
}

function PassphraseSheet({ open, includePhotos, onClose, onExported }: PassphraseSheetProps) {
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const tooShort = passphrase.length < minimumPassphrase;
  const mismatch = confirmation.length > 0 && confirmation !== passphrase;
  const working = progress !== null;

  const close = (): void => {
    if (working) return;
    setPassphrase("");
    setConfirmation("");
    setFailure(null);
    onClose();
  };

  const run = async (): Promise<void> => {
    setFailure(null);
    setProgress(0);
    try {
      const result = await exportBackup({ passphrase, includePhotos, onProgress: setProgress });
      setPassphrase("");
      setConfirmation("");
      onExported(result.fileName);
    } catch (error) {
      if (!(error instanceof CodedError)) throw error;
      setFailure("Export impossible, réessaie");
    } finally {
      setProgress(null);
    }
  };

  const hint = failure ?? (mismatch ? "Les deux ne correspondent pas" : tooShort ? `${minimumPassphrase} caractères minimum` : "Sans elle, le fichier ne se rouvre pas");

  return (
    <Sheet open={open} title="Phrase de passe" context="Elle chiffre la sauvegarde. Note-la ailleurs que sur ce téléphone." onClose={close}>
      <View style={styles.fields}>
        <TextField
          value={passphrase}
          onChangeText={setPassphrase}
          placeholder="Phrase de passe"
          accessibilityLabel="Phrase de passe"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="newPassword"
          editable={!working}
        />
        <TextField
          value={confirmation}
          onChangeText={setConfirmation}
          placeholder="Encore une fois"
          accessibilityLabel="Confirmer la phrase de passe"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="newPassword"
          editable={!working}
        />
        <Text variant="small" tone="secondary" accessibilityLiveRegion="polite">
          {hint}
        </Text>
      </View>
      <SheetButton
        label={working ? `Chiffrement ${Math.round((progress ?? 0) * 100)} %` : "Chiffrer et exporter"}
        disabled={working || tooShort || confirmation !== passphrase}
        onPress={() => void run()}
        style={styles.sheetAction}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  panel: { marginTop: 18, paddingVertical: 16, gap: 6 },
  header: { flexDirection: "row", alignItems: "center", gap: 8 },
  status: { fontFamily: fonts.text700, flex: 1 },
  warning: { fontSize: 14, lineHeight: 20 },
  export: { marginTop: 10 },
  fields: { gap: 10, marginTop: 4 },
  sheetAction: { marginTop: 14 },
});
