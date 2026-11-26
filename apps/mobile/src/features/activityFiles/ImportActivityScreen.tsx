import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { CodedError } from "expo";
import { AlreadyImportedError, computeDemImport, computeImport, DependentRowsError, NothingToMergeError, ReplacedSessionNotFoundError, RevertConflictError, TrackDecodeError } from "@obnixe/core";
import type { ImportComputation, ImportedActivity, SportGuess } from "@obnixe/core";
import { sports } from "@obnixe/schema";
import type { Id } from "@obnixe/schema";
import { undo } from "@/data/write";
import { ImportMap } from "@/features/activityFiles/ImportMap";
import {
  commitImport,
  decisionOf,
  defaultResolution,
  importSports,
  matchImport,
  matchedSession,
  MergeTrackUnavailableError,
  previewPath,
  readActivity,
  resolutionsOf,
  sportChoice,
} from "@/features/activityFiles/importActivity";
import type { ImportMatch, ImportResult, MatchedSession, PreviewPath, Resolution } from "@/features/activityFiles/importActivity";
import { SportStrip } from "@/features/activity/components";
import { pickActivityFile, readOpenedFile, releaseOpenedFile } from "@/features/data/files";
import type { PickedFile } from "@/features/data/files";
import { fileSize, longDateTime } from "@/features/data/format";
import { BackButton, BottomPanel, NoticeMark, SwitchRow } from "@/features/data/parts";
import { terrainUnder } from "@/features/maps/terrain";
import { TrackWriteError } from "@/features/tracking/trackStore";
import { formatLongClock } from "@/format/durations";
import { formatInteger, formatNumber } from "@/format/numbers";
import { LinkButton, PrimaryButton } from "@/ui/Button";
import { Segmented } from "@/ui/Controls";
import { AppBar, Screen, Section } from "@/ui/Layout";
import { goBack } from "@/ui/navigation";
import { useSnackbar } from "@/ui/SnackbarHost";
import { StatRow } from "@/ui/Stats";
import { Text } from "@/ui/Text";
import { fonts } from "@/ui/tokens";

interface ChosenFile {
  readonly name: string;
  readonly size: number;
  readonly activity: ImportedActivity;
  /** The detected sport until the user picks another; `null` until the user picks one. */
  readonly sport: SportGuess | null;
}

interface Measured {
  readonly computation: ImportComputation;
  readonly match: ImportMatch;
  readonly matched: MatchedSession | null;
  readonly path: PreviewPath | null;
}

type Stage =
  | { readonly kind: "empty"; readonly error: string | null }
  | { readonly kind: "reading" }
  | { readonly kind: "chosen"; readonly file: ChosenFile; readonly measured: Measured | null; readonly error: string | null }
  | { readonly kind: "importing"; readonly file: ChosenFile; readonly measured: Measured };

const formatLabels: Readonly<Record<ImportedActivity["format"], string>> = { gpx: "GPX", tcx: "TCX", fit: "FIT" };
const unreadable = "Impossible d'ouvrir ce fichier";
const interrupted = "Import interrompu, rien n'a changé";

function importError(error: unknown): string | null {
  if (error instanceof AlreadyImportedError) return "Ce fichier vient d'être importé ailleurs";
  if (error instanceof ReplacedSessionNotFoundError) return "La séance à remplacer n'existe plus";
  if (error instanceof NothingToMergeError) return "La montre n'apporte rien de plus à cette sortie";
  if (error instanceof MergeTrackUnavailableError || error instanceof TrackDecodeError) return "Trace du téléphone indisponible, fusion impossible";
  if (error instanceof TrackWriteError || error instanceof CodedError) return interrupted;
  return null;
}

function matchText(match: ImportMatch, matched: MatchedSession | null, resolution: Resolution): string {
  const when = matched === null ? "" : ` du ${longDateTime(matched.startedAt)}`;
  switch (match.kind) {
    case "new":
      return "";
    case "already_imported":
      return resolution === "replace" ? `La séance${when} va à la corbeille, le fichier est importé de nouveau` : `Déjà importé : séance${when}`;
    case "probable":
      return resolution === "replace" ? `La séance${when} va à la corbeille (30 jours)` : `Une séance du même sport démarre au même moment${when === "" ? "" : `, celle${when}`}`;
    case "merge":
      return match.merge.addsHeartRate ? `Ajoute la fréquence cardiaque de la montre à ta sortie${when}` : `Ta sortie${when} enregistrée par le téléphone couvre ce fichier`;
    default: {
      const unreachable: never = match;
      return unreachable;
    }
  }
}

function actionLabel(match: ImportMatch, resolution: Resolution): string {
  switch (resolution) {
    case "keep":
      return match.kind === "new" ? "Importer l'activité" : "Importer quand même";
    case "ignore":
      return match.kind === "already_imported" ? "Voir la séance" : "Ne pas importer";
    case "replace":
      return "Remplacer la séance";
    case "merge":
      return "Fusionner";
    default: {
      const unreachable: never = resolution;
      return unreachable;
    }
  }
}

function sessionRoute(sessionId: Id) {
  return { pathname: "/session/[id]", params: { id: sessionId } } as const;
}

interface ImportActivityScreenProps {
  /** `IO-051`: the URI of a file shared to the app or opened with it. */
  readonly openedFile: string | null;
}

/** `IO-010` to `IO-012`, `IO-052`: pick or receive a file, check its sport and preview, settle duplicates, import. */
export function ImportActivityScreen({ openedFile }: ImportActivityScreenProps) {
  const notify = useSnackbar();
  const [stage, setStage] = useState<Stage>(openedFile === null ? { kind: "empty", error: null } : { kind: "reading" });
  const [resolution, setResolution] = useState<Resolution>("keep");
  const [replaceAltitude, setReplaceAltitude] = useState(false);
  const measuring = useRef(0);

  const measure = (file: ChosenFile, error: string | null = null): void => {
    const token = (measuring.current += 1);
    const sport = file.sport;
    setStage({ kind: "chosen", file, measured: null, error });
    if (sport === null) return;
    setTimeout(() => {
      if (token !== measuring.current) return;
      const computation = computeImport(file.activity, sport);
      const match = matchImport(computation);
      setResolution(defaultResolution(match));
      setReplaceAltitude(false);
      setStage({ kind: "chosen", file, measured: { computation, match, matched: matchedSession(match, file.activity.startedAt), path: previewPath(computation) }, error });
      if (computation.processed !== null && computation.summary.elevationSource === "none") void measureOnRelief(token, computation);
    }, 0);
  };

  /** `ELE-003`: a file without altitude is measured again on the DEM when the relief can be downloaded. */
  const measureOnRelief = async (token: number, computation: ImportComputation): Promise<void> => {
    const terrain = await terrainUnder(computation.track.samples.fixes);
    if (terrain === null || token !== measuring.current) return;
    const corrected = computeDemImport(computation, terrain);
    setStage((current) =>
      current.kind === "chosen" && current.measured?.computation === computation ? { ...current, measured: { ...current.measured, computation: corrected, path: previewPath(corrected) } } : current,
    );
  };

  const open = (picked: PickedFile): void => {
    const reading = readActivity(picked.bytes);
    switch (reading.kind) {
      case "refused":
        measuring.current += 1;
        setStage({ kind: "empty", error: reading.message });
        return;
      case "read":
        measure({ name: picked.name, size: picked.size, activity: reading.activity, sport: reading.activity.sport });
        return;
      default: {
        const unreachable: never = reading;
        throw new Error(`Unhandled reading ${JSON.stringify(unreachable)}`);
      }
    }
  };

  useEffect(() => {
    if (openedFile === null) return;
    let active = true;
    setStage({ kind: "reading" });
    readOpenedFile(openedFile)
      .then((picked) => {
        if (active) open(picked);
      })
      .catch((error: unknown) => {
        if (!(error instanceof CodedError)) throw error;
        if (active) setStage({ kind: "empty", error: unreadable });
      })
      .finally(() => releaseOpenedFile(openedFile));
    return () => {
      active = false;
    };
  }, [openedFile]);

  const choose = async (): Promise<void> => {
    try {
      const picked = await pickActivityFile();
      if (picked !== null) open(picked);
    } catch (error) {
      if (!(error instanceof CodedError)) throw error;
      setStage({ kind: "empty", error: unreadable });
    }
  };

  const run = async (file: ChosenFile, measured: Measured): Promise<void> => {
    const decision = decisionOf(measured.match, resolution, measured.matched, replaceAltitude);
    if (decision === null) {
      if (measured.match.kind === "already_imported") router.replace(sessionRoute(measured.match.sessionId));
      else goBack("/");
      return;
    }
    setStage({ kind: "importing", file, measured });
    let result: ImportResult;
    try {
      result = await commitImport(measured.computation, decision);
    } catch (error) {
      const message = importError(error);
      measure(file, message ?? interrupted);
      if (message === null) throw error;
      return;
    }
    notify({
      text: decision.kind === "merge" ? "Sortie complétée par la montre" : "Activité importée",
      action: {
        label: "Annuler",
        run: () => {
          try {
            undo(result.changesetId, result.summary);
          } catch (error) {
            if (!(error instanceof RevertConflictError || error instanceof DependentRowsError)) throw error;
            notify({ text: "Impossible d'annuler : modifié depuis" });
          }
        },
      },
    });
    router.replace(sessionRoute(result.sessionId));
  };

  const file = stage.kind === "chosen" || stage.kind === "importing" ? stage.file : null;
  const measured = stage.kind === "chosen" || stage.kind === "importing" ? stage.measured : null;

  return (
    <View style={styles.root}>
      <Screen bottomInset={120}>
        <AppBar title="Importer une activité" variant="context" leading={<BackButton />} />
        {file === null ? (
          <View style={styles.head}>
            <Text variant="eyebrow" tone="secondary">
              Activité
            </Text>
            <Text accessibilityRole="header" style={styles.title}>
              Choisir le fichier
            </Text>
            <Text tone="secondary">GPX, TCX ou FIT, ou le ZIP « Exporter l'original » de Garmin Connect</Text>
            <Text variant="small" tone="secondary" style={styles.hint}>
              Sur la montre, l'enregistrement « Chaque seconde » donne des splits et des records plus justes.
            </Text>
            {stage.kind === "empty" && stage.error !== null ? <Problem message={stage.error} /> : null}
          </View>
        ) : (
          <FileHead file={file} />
        )}

        {file === null ? null : (
          <Section title="Sport" action={<LinkButton label="Autre fichier" disabled={stage.kind === "importing"} onPress={() => void choose()} style={styles.sectionLink} />}>
            <SportStrip
              items={importSports(file.activity.sport).map((key) => ({ key, label: sports[key].label }))}
              value={file.sport?.sport ?? null}
              onChange={(key) => {
                if (key !== "catalogue" && stage.kind === "chosen") measure({ ...file, sport: sportChoice(file.activity.sport, key) });
              }}
            />
            {file.sport === null ? (
              <Text variant="small" tone="secondary" style={styles.sportHint}>
                Le fichier ne dit pas quel sport c'est
              </Text>
            ) : null}
          </Section>
        )}

        {measured === null ? null : <Preview measured={measured} />}

        {measured !== null && measured.match.kind !== "new" ? (
          <Section title={measured.match.kind === "merge" ? "Sortie déjà enregistrée" : "Doublon"}>
            <View style={styles.choice} accessibilityLabel="Que faire de ce fichier">
              <Segmented options={resolutionsOf(measured.match)} value={resolution} onChange={setResolution} />
            </View>
            <Text tone="secondary" style={styles.choiceDetail} accessibilityLiveRegion="polite">
              {matchText(measured.match, measured.matched, resolution)}
            </Text>
            {measured.match.kind === "merge" && resolution === "merge" && measured.match.merge.offersAltitude ? (
              <SwitchRow title="Altitude de la montre" detail="remplace celle du téléphone par son baromètre" value={replaceAltitude} onChange={setReplaceAltitude} divided />
            ) : null}
          </Section>
        ) : null}

        {stage.kind === "chosen" && stage.error !== null ? <Problem message={stage.error} /> : null}
      </Screen>

      <BottomPanel>
        <BottomAction stage={stage} resolution={resolution} onChoose={() => void choose()} onRun={(target, done) => void run(target, done)} />
      </BottomPanel>
    </View>
  );
}

function FileHead({ file }: { readonly file: ChosenFile }) {
  const { activity } = file;
  return (
    <View style={styles.head}>
      <Text variant="eyebrow" tone="secondary">
        {activity.device ?? `Fichier ${formatLabels[activity.format]}`}
      </Text>
      <Text accessibilityRole="header" style={styles.title} numberOfLines={2}>
        {activity.name ?? file.name}
      </Text>
      <Text style={styles.file}>
        {longDateTime(activity.startedAt)}{" "}
        <Text style={[styles.file, styles.fileDetail]} tone="secondary">
          · {formatLabels[activity.format]}, {fileSize(file.size)}
        </Text>
      </Text>
    </View>
  );
}

function Preview({ measured }: { readonly measured: Measured }) {
  const { summary, sport } = measured.computation;
  return (
    <Section title="Aperçu">
      {measured.path === null ? null : <ImportMap path={measured.path} sport={sport.sport} />}
      <StatRow
        style={styles.stats}
        stats={[
          { label: "Distance", value: formatNumber(summary.distanceMm / 1_000_000, 2), unit: "km" },
          { label: "En mouvement", value: formatLongClock(summary.movingMs / 1000), unit: "" },
          { label: "D+", value: summary.ascentMm === null ? "–" : formatInteger(Math.round(summary.ascentMm / 1000)), unit: summary.ascentMm === null ? "" : "m" },
        ]}
      />
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
  readonly resolution: Resolution;
  readonly onChoose: () => void;
  readonly onRun: (file: ChosenFile, measured: Measured) => void;
}

function BottomAction({ stage, resolution, onChoose, onRun }: BottomActionProps) {
  switch (stage.kind) {
    case "empty":
      return <PrimaryButton label="Choisir le fichier" onPress={onChoose} />;
    case "reading":
      return <PrimaryButton label="Lecture du fichier" disabled onPress={() => undefined} />;
    case "chosen": {
      const { file, measured } = stage;
      if (file.sport === null) return <PrimaryButton label="Choisis le sport" disabled onPress={() => undefined} />;
      if (measured === null) return <PrimaryButton label="Calcul en cours" disabled onPress={() => undefined} />;
      return <PrimaryButton label={actionLabel(measured.match, resolution)} onPress={() => onRun(file, measured)} />;
    }
    case "importing":
      return <PrimaryButton label="Import en cours" disabled onPress={() => undefined} />;
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
  hint: { marginTop: 6 },
  sectionLink: { marginVertical: -12, marginRight: -10 },
  sportHint: { marginTop: 8 },
  stats: { marginTop: 14 },
  choice: { marginTop: 10 },
  choiceDetail: { marginTop: 10, minHeight: 44, lineHeight: 23 },
  problem: { marginTop: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  problemText: { flex: 1 },
});
