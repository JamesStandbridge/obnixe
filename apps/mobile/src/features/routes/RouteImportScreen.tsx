import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { CodedError } from "expo";
import type { SportGuess } from "@obnixe/core";
import { sports } from "@obnixe/schema";
import { useUndoableWrite } from "@/data/write";
import { importSports, sportChoice } from "@/features/activityFiles/importActivity";
import { SportStrip } from "@/features/activity/components";
import { pickActivityFile } from "@/features/data/files";
import type { PickedFile } from "@/features/data/files";
import { BackButton, BottomPanel, NoticeMark } from "@/features/data/parts";
import { routeFigures } from "@/features/routes/format";
import { RouteMap } from "@/features/routes/RouteMap";
import { RouteProfileChart } from "@/features/routes/RouteProfileChart";
import { candidateFigures, readRoute, routeMapPath, routeProfilePoints, routeSaveError, routeSaveInterrupted, writeRouteFile } from "@/features/routes/routeData";
import type { RouteCandidate } from "@/features/routes/routeData";
import { LinkButton, PrimaryButton } from "@/ui/Button";
import { TextField } from "@/ui/Inputs";
import { AppBar, Screen, Section } from "@/ui/Layout";
import { Text } from "@/ui/Text";
import { fonts } from "@/ui/tokens";

interface ChosenRoute {
  readonly fileName: string;
  readonly candidate: RouteCandidate;
  readonly sport: SportGuess | null;
  readonly name: string;
}

type Stage =
  | { readonly kind: "empty"; readonly error: string | null }
  | { readonly kind: "chosen"; readonly route: ChosenRoute; readonly error: string | null }
  | { readonly kind: "saving"; readonly route: ChosenRoute };

const unreadable = "Impossible d'ouvrir ce fichier";

function fileTitle(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return (dot > 0 ? fileName.slice(0, dot) : fileName).slice(0, 60);
}

/** `RTE-001`: a GPX track or route, or a FIT or TCX course, previewed with the engine's distance and D+, then saved. */
export function RouteImportScreen() {
  const undoableWrite = useUndoableWrite();
  const [stage, setStage] = useState<Stage>({ kind: "empty", error: null });

  const open = (picked: PickedFile): void => {
    const reading = readRoute(picked.bytes);
    switch (reading.kind) {
      case "refused":
        setStage({ kind: "empty", error: reading.message });
        return;
      case "read": {
        const { candidate } = reading;
        setStage({ kind: "chosen", route: { fileName: picked.name, candidate, sport: candidate.sport, name: candidate.name ?? fileTitle(picked.name) }, error: null });
        return;
      }
      default: {
        const unreachable: never = reading;
        throw new Error(`Unhandled reading ${JSON.stringify(unreachable)}`);
      }
    }
  };

  const choose = async (): Promise<void> => {
    try {
      const picked = await pickActivityFile();
      if (picked !== null) open(picked);
    } catch (error) {
      if (!(error instanceof CodedError)) throw error;
      setStage({ kind: "empty", error: unreadable });
    }
  };

  const save = async (route: ChosenRoute): Promise<void> => {
    if (route.sport === null) return;
    setStage({ kind: "saving", route });
    try {
      const plan = await writeRouteFile(route.candidate, route.name, route.sport.sport, null);
      undoableWrite({ summary: `Itinéraire importé : ${route.name.trim()}`, mutations: [plan.mutation], message: "Itinéraire importé", aboveTabBar: false });
      router.replace({ pathname: "/routes/[id]", params: { id: plan.routeId } });
    } catch (error) {
      const message = routeSaveError(error) ?? (error instanceof CodedError ? routeSaveInterrupted : null);
      setStage({ kind: "chosen", route, error: message ?? routeSaveInterrupted });
      if (message === null) throw error;
    }
  };

  const route = stage.kind === "empty" ? null : stage.route;
  const update = (next: Partial<Pick<ChosenRoute, "sport" | "name">>): void => {
    if (stage.kind === "chosen") setStage({ kind: "chosen", route: { ...stage.route, ...next }, error: null });
  };

  return (
    <View style={styles.root}>
      <Screen bottomInset={120}>
        <AppBar title="Importer un itinéraire" variant="context" leading={<BackButton />} />
        {route === null ? (
          <View style={styles.head}>
            <Text variant="eyebrow" tone="secondary">
              Itinéraire
            </Text>
            <Text accessibilityRole="header" style={styles.title}>
              Choisir le fichier
            </Text>
            <Text tone="secondary">Une trace GPX, ou un parcours FIT ou TCX : celui d'une montre, de Komoot, d'OpenRunner ou de Visugpx</Text>
            {stage.kind === "empty" && stage.error !== null ? <Problem message={stage.error} /> : null}
          </View>
        ) : (
          <ChosenRouteView route={route} saving={stage.kind === "saving"} onChange={update} onChoose={() => void choose()} />
        )}
        {stage.kind === "chosen" && stage.error !== null ? <Problem message={stage.error} /> : null}
      </Screen>
      <BottomPanel>
        <BottomAction stage={stage} onChoose={() => void choose()} onSave={(chosen) => void save(chosen)} />
      </BottomPanel>
    </View>
  );
}

interface ChosenRouteViewProps {
  readonly route: ChosenRoute;
  readonly saving: boolean;
  readonly onChange: (next: Partial<Pick<ChosenRoute, "sport" | "name">>) => void;
  readonly onChoose: () => void;
}

function ChosenRouteView({ route, saving, onChange, onChoose }: ChosenRouteViewProps) {
  const { candidate } = route;
  const path = useMemo(() => routeMapPath(candidate.geometry), [candidate]);
  const profile = useMemo(() => routeProfilePoints(candidate.geometry), [candidate]);
  return (
    <>
      <View style={styles.head}>
        <Text variant="eyebrow" tone="secondary">
          {route.fileName}
        </Text>
        <Text accessibilityRole="header" style={styles.title} numberOfLines={2}>
          {routeFigures(candidateFigures(candidate.geometry))}
        </Text>
        {candidate.elevationSource === "none" ? (
          <Text variant="small" tone="secondary">
            Le fichier n'a pas d'altitude : pas de D+ pour cet itinéraire
          </Text>
        ) : null}
      </View>
      <RouteMap path={path} sport={route.sport?.sport ?? "run"} height={240} interactive />
      {profile.length < 2 ? null : <RouteProfileChart points={profile} />}
      <Section title="Nom">
        <TextField value={route.name} onChangeText={(name) => onChange({ name })} placeholder="Nom de l'itinéraire" accessibilityLabel="Nom de l'itinéraire" maxLength={60} editable={!saving} />
      </Section>
      <Section title="Sport">
        <SportStrip
          items={importSports(candidate.sport).map((key) => ({ key, label: sports[key].label }))}
          value={route.sport?.sport ?? null}
          onChange={(key) => {
            if (key !== "catalogue" && !saving) onChange({ sport: sportChoice(candidate.sport, key) });
          }}
        />
        {route.sport === null ? (
          <Text variant="small" tone="secondary" style={styles.hint}>
            Le fichier ne dit pas pour quel sport il est
          </Text>
        ) : null}
      </Section>
      <LinkButton label="Autre fichier" disabled={saving} onPress={onChoose} style={styles.other} />
    </>
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
  readonly onSave: (route: ChosenRoute) => void;
}

function BottomAction({ stage, onChoose, onSave }: BottomActionProps) {
  switch (stage.kind) {
    case "empty":
      return <PrimaryButton label="Choisir le fichier" onPress={onChoose} />;
    case "chosen": {
      const { route } = stage;
      if (route.sport === null) return <PrimaryButton label="Choisis le sport" disabled onPress={() => undefined} />;
      return <PrimaryButton label="Enregistrer l'itinéraire" disabled={route.name.trim() === ""} onPress={() => onSave(route)} />;
    }
    case "saving":
      return <PrimaryButton label="Enregistrement" disabled onPress={() => undefined} />;
    default: {
      const unreachable: never = stage;
      throw new Error(`Unhandled route import stage ${JSON.stringify(unreachable)}`);
    }
  }
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  head: { marginTop: 14, gap: 6 },
  title: { fontFamily: fonts.text700, fontSize: 30, lineHeight: 33, letterSpacing: -0.6 },
  hint: { marginTop: 8 },
  other: { marginTop: 16, alignSelf: "flex-start", marginLeft: -10 },
  problem: { marginTop: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  problemText: { flex: 1 },
});
