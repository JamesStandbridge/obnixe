import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { CodedError } from "expo";
import { ZodError } from "zod";
import {
  CorruptedBackupError,
  DependentRowsError,
  NewerBackupError,
  NotABackupError,
  RevertConflictError,
  UnresolvedReferenceError,
  WrongPassphraseError,
  localDataSummary,
  mergeSummary,
  summarizeSnapshot,
} from "@obnixe/core";
import type { Snapshot, SnapshotSummary } from "@obnixe/core";
import { db } from "@/data/database";
import { undo } from "@/data/write";
import { importBackup, inspectBackup, unlockBackup } from "@/features/data/backup";
import type { ChosenBackup, ImportMode, ImportOutcome } from "@/features/data/backup";
import { pickBackupFile } from "@/features/data/files";
import { dayMonth, fileSize, longDateTime, plural } from "@/features/data/format";
import { useFirstLaunch } from "@/features/data/launch";
import { BackButton, BottomPanel, NoticeMark } from "@/features/data/parts";
import { PrimaryButton } from "@/ui/Button";
import { Segmented } from "@/ui/Controls";
import { TextField } from "@/ui/Inputs";
import { AppBar, Row, Screen, Section } from "@/ui/Layout";
import { useSnackbar } from "@/ui/SnackbarHost";
import type { SnackbarMessage } from "@/ui/SnackbarHost";
import { Text } from "@/ui/Text";
import { fonts } from "@/ui/tokens";

type Stage =
  | { readonly kind: "empty"; readonly error: string | null }
  | { readonly kind: "locked"; readonly chosen: ChosenBackup; readonly error: string | null }
  | { readonly kind: "unlocking"; readonly chosen: ChosenBackup; readonly progress: number }
  | { readonly kind: "ready"; readonly chosen: ChosenBackup; readonly snapshot: Snapshot; readonly summary: SnapshotSummary; readonly error: string | null }
  | { readonly kind: "importing"; readonly chosen: ChosenBackup; readonly snapshot: Snapshot; readonly summary: SnapshotSummary }
  | { readonly kind: "done"; readonly outcome: ImportOutcome };

const modeOptions: readonly { readonly value: ImportMode; readonly label: string }[] = [
  { value: "merge", label: "Fusionner" },
  { value: "replace", label: "Remplacer" },
];

const unreadable = "Impossible d'ouvrir ce fichier";
const interrupted = "Import interrompu, rien n'a changé";

function readError(error: unknown): string | null {
  if (error instanceof WrongPassphraseError) return "Phrase de passe incorrecte";
  if (error instanceof NotABackupError) return "Ce fichier n'est pas une sauvegarde Obnixe";
  if (error instanceof NewerBackupError) return "Sauvegarde faite avec une version plus récente. Mets Obnixe à jour.";
  if (error instanceof CorruptedBackupError) return "Fichier abîmé, impossible à lire";
  if (error instanceof CodedError) return unreadable;
  return null;
}

function importError(error: unknown): string | null {
  if (error instanceof UnresolvedReferenceError || error instanceof DependentRowsError || error instanceof ZodError) return "Sauvegarde incohérente, rien n'a changé";
  if (error instanceof CodedError) return interrupted;
  return null;
}

function withoutExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function outcomeMessage(outcome: ImportOutcome, notify: (message: SnackbarMessage) => void): SnackbarMessage {
  switch (outcome.mode) {
    case "replace":
      return { text: "Sauvegarde restaurée" };
    case "merge": {
      const changesetId = outcome.changesetId;
      if (changesetId === null) return { text: "Rien de nouveau dans cette sauvegarde" };
      return {
        text: "Sauvegarde fusionnée",
        action: {
          label: "Annuler",
          run: () => {
            try {
              undo(changesetId, mergeSummary);
            } catch (error) {
              if (!(error instanceof RevertConflictError || error instanceof DependentRowsError)) throw error;
              notify({ text: "Impossible d'annuler : modifié depuis" });
            }
          },
        },
      };
    }
    default: {
      const unreachable: never = outcome;
      throw new Error(`Unhandled import outcome ${JSON.stringify(unreachable)}`);
    }
  }
}

export default function ImportBackup() {
  const notify = useSnackbar();
  const firstLaunch = useFirstLaunch();
  const [stage, setStage] = useState<Stage>({ kind: "empty", error: null });
  const [passphrase, setPassphrase] = useState("");
  const [mode, setMode] = useState<ImportMode | null>(null);
  const local = useMemo(() => localDataSummary(db()), []);

  useEffect(() => {
    if (stage.kind !== "done" || firstLaunch) return;
    notify(outcomeMessage(stage.outcome, notify));
    router.dismissTo("/");
  }, [stage, firstLaunch, notify]);

  const choose = async (): Promise<void> => {
    try {
      const file = await pickBackupFile();
      if (file === null) return;
      setPassphrase("");
      setMode(null);
      setStage({ kind: "locked", chosen: inspectBackup(file), error: null });
    } catch (error) {
      const message = readError(error);
      setStage({ kind: "empty", error: message ?? unreadable });
      if (message === null) throw error;
    }
  };

  const unlock = async (chosen: ChosenBackup): Promise<void> => {
    setStage({ kind: "unlocking", chosen, progress: 0 });
    try {
      const snapshot = await unlockBackup(chosen, passphrase, (progress) => setStage({ kind: "unlocking", chosen, progress }));
      setStage({ kind: "ready", chosen, snapshot, summary: summarizeSnapshot(snapshot.tables), error: null });
    } catch (error) {
      const message = readError(error);
      setStage({ kind: "locked", chosen, error: message ?? unreadable });
      if (message === null) throw error;
    }
  };

  const run = async (chosen: ChosenBackup, snapshot: Snapshot, summary: SnapshotSummary, chosenMode: ImportMode): Promise<void> => {
    setStage({ kind: "importing", chosen, snapshot, summary });
    try {
      setStage({ kind: "done", outcome: await importBackup(snapshot, chosenMode) });
    } catch (error) {
      const message = importError(error);
      setStage({ kind: "ready", chosen, snapshot, summary, error: message ?? interrupted });
      if (message === null) throw error;
    }
  };

  const chosen = stage.kind === "empty" || stage.kind === "done" ? null : stage.chosen;
  const summary = stage.kind === "ready" || stage.kind === "importing" ? stage.summary : null;

  return (
    <View style={styles.root}>
      <Screen bottomInset={120}>
        <AppBar title="Importer une sauvegarde" variant="context" leading={<BackButton />} />

        {chosen === null ? (
          <View style={styles.head}>
            <Text variant="eyebrow" tone="secondary">
              Sauvegarde
            </Text>
            <Text accessibilityRole="header" style={styles.title}>
              Choisir le fichier
            </Text>
            <Text tone="secondary">Le fichier .obnixe exporté depuis Données et réglages</Text>
            {stage.kind === "empty" && stage.error !== null ? <Problem message={stage.error} /> : null}
          </View>
        ) : (
          <View style={styles.head}>
            <Text variant="eyebrow" tone="secondary">
              Fichier choisi
            </Text>
            <Text accessibilityRole="header" style={styles.title} numberOfLines={2}>
              {withoutExtension(chosen.name)}
            </Text>
            <Text style={styles.file}>
              {fileSize(chosen.size)} <Text style={[styles.file, styles.fileDetail]} tone="secondary">· créé {longDateTime(chosen.header.createdAt)}</Text>
            </Text>
          </View>
        )}

        {stage.kind === "locked" || stage.kind === "unlocking" ? (
          <Section title="Contenu">
            <Text variant="small" tone="secondary" style={styles.lockedNote}>
              Chiffré. Entre la phrase de passe choisie à l'export.
            </Text>
            <TextField
              value={passphrase}
              onChangeText={setPassphrase}
              placeholder="Phrase de passe"
              accessibilityLabel="Phrase de passe"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="password"
              editable={stage.kind === "locked"}
              returnKeyType="done"
              onSubmitEditing={() => {
                if (stage.kind === "locked" && passphrase.length > 0) void unlock(stage.chosen);
              }}
              style={styles.passphrase}
            />
            {stage.kind === "locked" && stage.error !== null ? <Problem message={stage.error} /> : null}
          </Section>
        ) : null}

        {summary !== null ? (
          <Section
            title="Contenu"
            {...(summary.coveredFrom === null || summary.coveredTo === null
              ? {}
              : {
                  action: (
                    <Text variant="small" tone="secondary">
                      du {dayMonth(summary.coveredFrom)} au {dayMonth(summary.coveredTo)}
                    </Text>
                  ),
                })}
          >
            <Row title="Séances" {...(summary.sports > 0 ? { detail: plural(summary.sports, "sport", "sports") } : {})} value={String(summary.sessions)} />
            <Row title="Programmes" value={String(summary.programs)} />
            <Row title="Pesées et mensurations" value={String(summary.bodyEntries)} last={summary.photos === 0} />
            {summary.photos > 0 ? <Row title="Photos" detail="chiffrées" value={String(summary.photos)} last /> : null}
          </Section>
        ) : null}

        {summary !== null && local.hasData ? (
          <Section title="Ce téléphone a déjà des données">
            <View style={styles.mode} accessibilityLabel="Mode d'import">
              <Segmented options={modeOptions} value={mode} onChange={setMode} />
            </View>
            <Text tone="secondary" style={styles.modeDetail} accessibilityLiveRegion="polite">
              {modeDetail(mode, local.sessions)}
            </Text>
          </Section>
        ) : null}

        {stage.kind === "ready" && stage.error !== null ? <Problem message={stage.error} /> : null}
      </Screen>

      <BottomPanel>
        <BottomAction
          stage={stage}
          passphrase={passphrase}
          mode={mode}
          hasLocalData={local.hasData}
          onChoose={() => void choose()}
          onUnlock={(target) => void unlock(target)}
          onImport={(target, snapshot, contents, chosenMode) => void run(target, snapshot, contents, chosenMode)}
        />
      </BottomPanel>
    </View>
  );
}

function Problem({ message }: { readonly message: string }) {
  return (
    <View style={styles.problem} accessibilityLiveRegion="polite">
      <NoticeMark />
      <Text variant="bodyStrong" style={styles.problemText}>
        {message}
      </Text>
    </View>
  );
}

function modeDetail(mode: ImportMode | null, sessions: number): string {
  switch (mode) {
    case null:
      return sessions === 0 ? "Aucune séance ici, d'autres données" : `${plural(sessions, "séance", "séances")} déjà ici`;
    case "merge":
      return "Tout est gardé, sans doublon";
    case "replace":
      return sessions === 0 ? "Les données d'ici vont à la corbeille (30 jours)" : `${sessions === 1 ? "La séance d'ici va" : `Les ${sessions} séances d'ici vont`} à la corbeille (30 jours)`;
    default: {
      const unreachable: never = mode;
      return unreachable;
    }
  }
}

interface BottomActionProps {
  readonly stage: Stage;
  readonly passphrase: string;
  readonly mode: ImportMode | null;
  readonly hasLocalData: boolean;
  readonly onChoose: () => void;
  readonly onUnlock: (chosen: ChosenBackup) => void;
  readonly onImport: (chosen: ChosenBackup, snapshot: Snapshot, summary: SnapshotSummary, mode: ImportMode) => void;
}

function BottomAction({ stage, passphrase, mode, hasLocalData, onChoose, onUnlock, onImport }: BottomActionProps) {
  switch (stage.kind) {
    case "empty":
      return <PrimaryButton label="Choisir le fichier" onPress={onChoose} />;
    case "locked":
      return <PrimaryButton label="Déchiffrer" disabled={passphrase.length === 0} onPress={() => onUnlock(stage.chosen)} />;
    case "unlocking":
      return <PrimaryButton label={`Déchiffrement ${Math.round(stage.progress * 100)} %`} disabled onPress={() => undefined} />;
    case "ready": {
      const sessions = plural(stage.summary.sessions, "séance", "séances");
      if (!hasLocalData) {
        return <PrimaryButton label={stage.summary.sessions === 0 ? "Importer la sauvegarde" : `Importer ${sessions}`} onPress={() => onImport(stage.chosen, stage.snapshot, stage.summary, "replace")} />;
      }
      if (mode === null) return <PrimaryButton label="Fusionner ou remplacer ?" disabled onPress={() => undefined} />;
      const label = mode === "replace" ? "Remplacer par la sauvegarde" : stage.summary.sessions === 0 ? "Fusionner la sauvegarde" : `Fusionner ${sessions}`;
      return <PrimaryButton label={label} onPress={() => onImport(stage.chosen, stage.snapshot, stage.summary, mode)} />;
    }
    case "importing":
      return <PrimaryButton label="Import en cours" disabled onPress={() => undefined} />;
    case "done":
      return <PrimaryButton label="Import terminé" disabled onPress={() => undefined} />;
    default: {
      const unreachable: never = stage;
      throw new Error(`Unhandled import stage ${JSON.stringify(unreachable)}`);
    }
  }
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  head: { marginTop: 14, gap: 6 },
  title: { fontFamily: fonts.text700, fontSize: 30, lineHeight: 33, letterSpacing: -0.6 },
  file: { fontFamily: fonts.figure700, fontSize: 19, lineHeight: 25 },
  fileDetail: { fontFamily: fonts.figure600 },
  lockedNote: { marginTop: 10 },
  passphrase: { marginTop: 10 },
  problem: { marginTop: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  problemText: { flex: 1 },
  mode: { marginTop: 10 },
  modeDetail: { marginTop: 10, minHeight: 44, lineHeight: 23 },
});
