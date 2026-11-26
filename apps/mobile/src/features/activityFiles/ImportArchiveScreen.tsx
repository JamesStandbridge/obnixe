import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { CodedError } from "expo";
import { ArchiveError, ArchiveStoppedError, DependentRowsError, openGarminArchive, RevertConflictError } from "@obnixe/core";
import type { ArchiveDuplicatePolicy, ArchiveImportReport, ArchivePreview, ArchiveProgress, ArchiveRefusal, OpenedArchive } from "@obnixe/core";
import { sports } from "@obnixe/schema";
import { analyseArchive, archiveControl, archiveErrorMessage, archiveRefusalMessage, importArchiveActivities, lastArchiveImport, saveLastArchiveImport, undoArchive } from "@/features/activityFiles/importArchive";
import type { LastArchiveImport } from "@/features/activityFiles/importArchive";
import { archiveScratch, pickArchiveFile } from "@/features/data/files";
import type { PickedArchive } from "@/features/data/files";
import { dayMonth, fileSize, longDateTime } from "@/features/data/format";
import { BackButton, BottomPanel, NoticeMark } from "@/features/data/parts";
import { holdDerivedRefresh } from "@/features/tracking/recorder";
import { TrackWriteError } from "@/features/tracking/trackStore";
import { plural } from "@/format/labels";
import { LinkButton, PrimaryButton } from "@/ui/Button";
import { Segmented } from "@/ui/Controls";
import { AppBar, Row, Screen, Section } from "@/ui/Layout";
import { goBack } from "@/ui/navigation";
import { useSnackbar } from "@/ui/SnackbarHost";
import { Text } from "@/ui/Text";
import { fonts } from "@/ui/tokens";
import { useKeepAwakeWhile } from "@/ui/useKeepAwakeWhile";

interface ChosenArchive {
  readonly name: string;
  readonly size: number;
}

type Stage =
  | { readonly kind: "empty"; readonly error: string | null }
  | { readonly kind: "opening"; readonly chosen: ChosenArchive; readonly progress: ArchiveProgress | null }
  | { readonly kind: "analysing"; readonly chosen: ChosenArchive; readonly progress: ArchiveProgress | null }
  | { readonly kind: "ready"; readonly chosen: ChosenArchive; readonly archive: OpenedArchive; readonly preview: ArchivePreview; readonly error: string | null }
  | { readonly kind: "importing"; readonly chosen: ChosenArchive; readonly preview: ArchivePreview; readonly progress: ArchiveProgress | null }
  | { readonly kind: "done"; readonly chosen: ChosenArchive; readonly report: ArchiveImportReport; readonly error: string | null }
  | { readonly kind: "undoing"; readonly chosen: ChosenArchive | null; readonly report: ArchiveImportReport };

const policyOptions: readonly { readonly value: ArchiveDuplicatePolicy; readonly label: string }[] = [
  { value: "ignore", label: "Ignorer" },
  { value: "replace", label: "Remplacer" },
  { value: "keep", label: "Garder les deux" },
];

const exportSteps = [
  "Sur garmin.com, ouvre ton compte Garmin, puis Gestion des données › Exporter vos données › Demander l'exportation.",
  "Garmin envoie par e-mail un lien vers un ZIP, en général sous quelques jours.",
  "Télécharge le ZIP sur ce téléphone, sans le décompresser, puis choisis-le ici.",
] as const;

const unreadable = "Impossible d'ouvrir ce fichier";
const failed = "Import arrêté. Les activités déjà importées sont gardées : relance l'import pour reprendre.";
const undoConflict = "Impossible d'annuler : des activités importées ont été modifiées depuis";
const undoFailed = "Annulation impossible, rien n'a changé";
const shownRefusals = 20;

function readError(error: unknown): string | null {
  if (error instanceof ArchiveError) return archiveErrorMessage(error.reason);
  if (error instanceof CodedError) return unreadable;
  return null;
}

function percent(progress: ArchiveProgress | null): string {
  return progress === null || progress.total === 0 ? "0 %" : `${Math.floor((progress.done / progress.total) * 100)} %`;
}

function policyDetail(policy: ArchiveDuplicatePolicy, duplicates: number): string {
  switch (policy) {
    case "ignore":
      return duplicates === 1 ? "Le doublon n'est pas importé" : "Les doublons ne sont pas importés";
    case "replace":
      return duplicates === 1 ? "La séance en double va à la corbeille (30 jours)" : "Les séances en double vont à la corbeille (30 jours)";
    case "keep":
      return duplicates === 1 ? "Le doublon est importé à côté de la séance" : "Les doublons sont importés à côté des séances";
    default: {
      const unreachable: never = policy;
      return unreachable;
    }
  }
}

/** The file inside its nested archive, without the export's folders. */
function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** `IO-053` on the path of `IO-020`: explain the export, open it, preview, import by batches, report, undo. */
export function ImportArchiveScreen() {
  const notify = useSnackbar();
  const [stage, setStage] = useState<Stage>({ kind: "empty", error: null });
  const [policy, setPolicy] = useState<ArchiveDuplicatePolicy>("ignore");
  const [last, setLast] = useState<LastArchiveImport | null>(null);
  const picked = useRef<PickedArchive | null>(null);
  const opened = useRef<OpenedArchive | null>(null);
  const stopRequested = useRef(false);
  const unmounted = useRef(false);
  const running = useRef(false);
  const working = stage.kind === "opening" || stage.kind === "analysing" || stage.kind === "importing" || stage.kind === "undoing";
  useKeepAwakeWhile(working);

  const release = async (): Promise<void> => {
    const archive = opened.current;
    const file = picked.current;
    opened.current = null;
    picked.current = null;
    if (archive !== null) await archive.close();
    file?.release();
  };

  useEffect(() => {
    let active = true;
    void lastArchiveImport().then((found) => {
      if (active) setLast(found);
    });
    return () => {
      active = false;
    };
  }, []);

  /** Leaving the screen stops the task, which releases the archive once it returns. */
  useEffect(() => {
    return () => {
      unmounted.current = true;
      stopRequested.current = true;
      if (!running.current) void release();
    };
  }, []);

  const task = async (work: () => Promise<void>): Promise<void> => {
    running.current = true;
    try {
      await work();
    } finally {
      running.current = false;
      if (unmounted.current) await release();
    }
  };

  const choose = async (): Promise<void> => {
    await release();
    let file: PickedArchive | null;
    try {
      file = await pickArchiveFile();
    } catch (error) {
      if (!(error instanceof CodedError)) throw error;
      setStage({ kind: "empty", error: unreadable });
      return;
    }
    if (file === null) return;
    picked.current = file;
    const chosen: ChosenArchive = { name: file.name, size: file.source.size };
    stopRequested.current = false;
    setStage({ kind: "opening", chosen, progress: null });
    await task(() => openAndAnalyse(file, chosen));
  };

  const openAndAnalyse = async (file: PickedArchive, chosen: ChosenArchive): Promise<void> => {
    try {
      const archive = await openGarminArchive(
        file.source,
        archiveScratch(),
        archiveControl(
          () => stopRequested.current,
          (progress) => setStage({ kind: "opening", chosen, progress }),
        ),
      );
      opened.current = archive;
      setStage({ kind: "analysing", chosen, progress: null });
      const preview = await analyseArchive(
        archive,
        archiveControl(
          () => stopRequested.current,
          (progress) => setStage({ kind: "analysing", chosen, progress }),
        ),
      );
      setPolicy("ignore");
      setStage({ kind: "ready", chosen, archive, preview, error: null });
    } catch (error) {
      await release();
      if (error instanceof ArchiveStoppedError) {
        setStage({ kind: "empty", error: null });
        return;
      }
      const message = readError(error);
      setStage({ kind: "empty", error: message ?? unreadable });
      if (message === null) throw error;
    }
  };

  const run = async (chosen: ChosenArchive, archive: OpenedArchive, preview: ArchivePreview): Promise<void> => {
    stopRequested.current = false;
    setStage({ kind: "importing", chosen, preview, progress: null });
    await task(() => importAll(chosen, archive, preview));
  };

  const importAll = async (chosen: ChosenArchive, archive: OpenedArchive, preview: ArchivePreview): Promise<void> => {
    let report: ArchiveImportReport;
    const releaseRefresh = holdDerivedRefresh();
    try {
      report = await importArchiveActivities(
        archive,
        preview,
        policy,
        archiveControl(
          () => stopRequested.current,
          (progress) => setStage({ kind: "importing", chosen, preview, progress }),
        ),
      );
    } catch (error) {
      setStage({ kind: "ready", chosen, archive, preview, error: failed });
      if (!(error instanceof TrackWriteError || error instanceof CodedError)) throw error;
      return;
    } finally {
      releaseRefresh();
    }
    await release();
    const saved = await saveLastArchiveImport(report);
    if (saved !== null) setLast(saved);
    setStage({ kind: "done", chosen, report, error: null });
  };

  /** From the report, or from the empty screen for the last import of this device (`chosen` is then `null`). */
  const cancelImport = async (chosen: ChosenArchive | null, report: ArchiveImportReport): Promise<void> => {
    setStage({ kind: "undoing", chosen, report });
    try {
      await undoArchive(report);
    } catch (error) {
      const conflict = error instanceof RevertConflictError || error instanceof DependentRowsError;
      const message = conflict ? undoConflict : undoFailed;
      setStage(chosen === null ? { kind: "empty", error: message } : { kind: "done", chosen, report, error: message });
      if (!conflict) throw error;
      return;
    }
    setLast(null);
    notify({ text: "Import annulé" });
    goBack("/");
  };

  const chosen = stage.kind === "empty" ? null : stage.chosen;
  const undoable = stage.kind === "empty" || (stage.kind === "undoing" && stage.chosen === null) ? last : null;

  return (
    <View style={styles.root}>
      <Screen bottomInset={120}>
        <AppBar title="Importer l'archive Garmin" variant="context" leading={<BackButton />} />
        {chosen === null ? (
          <View style={styles.head}>
            <Text variant="eyebrow" tone="secondary">
              Garmin Connect
            </Text>
            <Text accessibilityRole="header" style={styles.title}>
              Tout l'historique en une fois
            </Text>
            <Text tone="secondary">L'export de compte Garmin Connect contient les fichiers d'origine de toutes tes activités</Text>
            {stage.kind === "empty" && stage.error !== null ? <Problem message={stage.error} /> : null}
          </View>
        ) : (
          <View style={styles.head}>
            <Text variant="eyebrow" tone="secondary">
              Archive choisie
            </Text>
            <Text accessibilityRole="header" style={styles.title} numberOfLines={2}>
              {chosen.name}
            </Text>
            <Text style={styles.file}>{fileSize(chosen.size)}</Text>
          </View>
        )}

        {undoable === null ? null : (
          <Section title="Dernier import">
            <Row
              title={plural(undoable.report.imported, "activité importée", "activités importées")}
              detail={`le ${longDateTime(undoable.importedAt)}`}
              trailing={<LinkButton label="Annuler l'import" disabled={stage.kind === "undoing"} onPress={() => void cancelImport(null, undoable.report)} style={styles.rowLink} />}
              last
            />
          </Section>
        )}

        {stage.kind === "empty" ? (
          <Section title="Demander l'export">
            {exportSteps.map((step, index) => (
              <View key={step} style={styles.step}>
                <Text style={styles.stepNumber}>{index + 1}</Text>
                <Text style={styles.stepText}>{step}</Text>
              </View>
            ))}
          </Section>
        ) : null}

        {stage.kind === "opening" || stage.kind === "analysing" ? (
          <Section title={stage.kind === "opening" ? "Ouverture" : "Analyse"}>
            <Text tone="secondary" style={styles.note} accessibilityLiveRegion="polite">
              {stage.kind === "opening" ? "Décompression des fichiers d'origine" : `Lecture des activités${stage.progress === null ? "" : ` : ${stage.progress.done} sur ${stage.progress.total} fichiers`}`}
            </Text>
          </Section>
        ) : null}

        {stage.kind === "ready" || stage.kind === "importing" ? <PreviewSections preview={stage.preview} /> : null}

        {stage.kind === "ready" && stage.preview.duplicates > 0 ? (
          <Section title={plural(stage.preview.duplicates, "doublon probable", "doublons probables")}>
            <View style={styles.choice} accessibilityLabel="Que faire des doublons">
              <Segmented options={policyOptions} value={policy} onChange={setPolicy} />
            </View>
            <Text tone="secondary" style={styles.choiceDetail} accessibilityLiveRegion="polite">
              {policyDetail(policy, stage.preview.duplicates)}
            </Text>
          </Section>
        ) : null}

        {stage.kind === "importing" ? (
          <Section title="Import">
            <Text tone="secondary" style={styles.note} accessibilityLiveRegion="polite">
              {stage.progress === null ? "Préparation" : `${stage.progress.done} sur ${plural(stage.progress.total, "activité", "activités")}`}
            </Text>
          </Section>
        ) : null}

        {stage.kind === "done" || (stage.kind === "undoing" && stage.chosen !== null) ? <ReportSections report={stage.report} /> : null}

        {stage.kind === "ready" && stage.error !== null ? <Problem message={stage.error} /> : null}
        {stage.kind === "done" && stage.error !== null ? <Problem message={stage.error} /> : null}
      </Screen>

      <BottomPanel>
        <BottomAction
          stage={stage}
          onChoose={() => void choose()}
          onStop={() => {
            stopRequested.current = true;
          }}
          onImport={(target, archive, preview) => void run(target, archive, preview)}
          onUndo={(target, report) => void cancelImport(target, report)}
          onClose={() => goBack("/")}
        />
      </BottomPanel>
    </View>
  );
}

function PreviewSections({ preview }: { readonly preview: ArchivePreview }) {
  const period = preview.firstStartedAt === null || preview.lastStartedAt === null ? null : `du ${dayMonth(preview.firstStartedAt)} au ${dayMonth(preview.lastStartedAt)}`;
  const skipped = [
    { title: "Déjà importées", count: preview.alreadyImported },
    { title: "Sports non pris en charge", count: preview.unsupported },
    { title: "Fichiers refusés", count: preview.refused.length },
  ].filter((row) => row.count > 0);
  return (
    <>
      <Section
        title={preview.importable === 0 ? "Rien de nouveau" : plural(preview.importable, "activité à importer", "activités à importer")}
        {...(period === null
          ? {}
          : {
              action: (
                <Text variant="small" tone="secondary">
                  {period}
                </Text>
              ),
            })}
      >
        {preview.sports.map((row, index) => (
          <Row key={row.sport} title={sports[row.sport].label} value={String(row.count)} last={index === preview.sports.length - 1} />
        ))}
      </Section>
      {skipped.length === 0 ? null : (
        <Section title="Laissé de côté">
          {skipped.map((row, index) => (
            <Row key={row.title} title={row.title} value={String(row.count)} last={index === skipped.length - 1} />
          ))}
        </Section>
      )}
      <Refusals refused={preview.refused} />
    </>
  );
}

function ReportSections({ report }: { readonly report: ArchiveImportReport }) {
  const rows = [
    { title: "Importées", count: report.imported },
    { title: "Séances remplacées", count: report.replaced },
    { title: "Ignorées", count: report.skipped },
    { title: "Fichiers refusés", count: report.refused.length },
  ];
  return (
    <>
      <Section title={report.stopped ? "Import interrompu" : "Import terminé"}>
        {report.stopped ? (
          <Text tone="secondary" style={styles.note}>
            Les activités importées avant l'arrêt sont gardées. Relance l'import de la même archive pour reprendre : rien n'est importé deux fois.
          </Text>
        ) : null}
        {rows.map((row, index) => (
          <Row key={row.title} title={row.title} value={String(row.count)} last={index === rows.length - 1} />
        ))}
      </Section>
      <Refusals refused={report.refused} />
    </>
  );
}

function Refusals({ refused }: { readonly refused: readonly ArchiveRefusal[] }) {
  if (refused.length === 0) return null;
  const shown = refused.slice(0, shownRefusals);
  return (
    <Section title="Fichiers refusés">
      {shown.map((refusal, index) => (
        <Row key={refusal.path} title={fileName(refusal.path)} detail={archiveRefusalMessage(refusal.reason)} last={index === shown.length - 1 && refused.length <= shownRefusals} />
      ))}
      {refused.length > shownRefusals ? <Row title={`Et ${plural(refused.length - shownRefusals, "autre fichier", "autres fichiers")}`} last /> : null}
    </Section>
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

interface BottomActionProps {
  readonly stage: Stage;
  readonly onChoose: () => void;
  readonly onStop: () => void;
  readonly onImport: (chosen: ChosenArchive, archive: OpenedArchive, preview: ArchivePreview) => void;
  readonly onUndo: (chosen: ChosenArchive, report: ArchiveImportReport) => void;
  readonly onClose: () => void;
}

function BottomAction({ stage, onChoose, onStop, onImport, onUndo, onClose }: BottomActionProps) {
  switch (stage.kind) {
    case "empty":
      return <PrimaryButton label="Choisir l'archive" onPress={onChoose} />;
    case "opening":
      return <Working label={`Ouverture ${percent(stage.progress)}`} onStop={onStop} />;
    case "analysing":
      return <Working label={`Analyse ${percent(stage.progress)}`} onStop={onStop} />;
    case "ready":
      return (
        <View style={styles.actions}>
          {stage.preview.importable === 0 ? (
            <PrimaryButton label="Fermer" onPress={onClose} />
          ) : (
            <PrimaryButton label={`Importer ${plural(stage.preview.importable, "activité", "activités")}`} onPress={() => onImport(stage.chosen, stage.archive, stage.preview)} />
          )}
          <LinkButton label="Autre archive" onPress={onChoose} />
        </View>
      );
    case "importing":
      return <Working label={`Import ${percent(stage.progress)}`} onStop={onStop} />;
    case "done":
      return (
        <View style={styles.actions}>
          <PrimaryButton label="Terminé" onPress={onClose} />
          {stage.report.batches.length > 0 ? <LinkButton label="Annuler l'import" onPress={() => onUndo(stage.chosen, stage.report)} /> : null}
        </View>
      );
    case "undoing":
      return <PrimaryButton label="Annulation en cours" disabled onPress={() => undefined} />;
    default: {
      const unreachable: never = stage;
      throw new Error(`Unhandled archive import stage ${JSON.stringify(unreachable)}`);
    }
  }
}

function Working({ label, onStop }: { readonly label: string; readonly onStop: () => void }) {
  return (
    <View style={styles.actions}>
      <PrimaryButton label={label} disabled onPress={() => undefined} />
      <LinkButton label="Interrompre" onPress={onStop} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  head: { marginTop: 14, gap: 6 },
  title: { fontFamily: fonts.text700, fontSize: 30, lineHeight: 33, letterSpacing: -0.6 },
  file: { fontFamily: fonts.figure700, fontSize: 19, lineHeight: 25 },
  step: { flexDirection: "row", gap: 12, marginTop: 12 },
  stepNumber: { fontFamily: fonts.figure700, fontSize: 17, lineHeight: 23, minWidth: 16 },
  stepText: { flex: 1, lineHeight: 23 },
  note: { marginTop: 10, lineHeight: 23 },
  choice: { marginTop: 10 },
  choiceDetail: { marginTop: 10, minHeight: 44, lineHeight: 23 },
  actions: { gap: 4, alignItems: "stretch" },
  rowLink: { marginVertical: -12, marginRight: -10 },
  problem: { marginTop: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  problemText: { flex: 1 },
});
