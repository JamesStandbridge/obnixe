import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { and, eq, isNull } from "drizzle-orm";
import { InvalidRouteError, renameRoute, reverseRoute, trashMutation } from "@obnixe/core";
import type { ElevationPoint } from "@obnixe/core";
import { session, sports } from "@obnixe/schema";
import type { Id, Route, Session } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { useUndoableWrite, write } from "@/data/write";
import type { PreviewPath } from "@/features/activityFiles/importActivity";
import { BottomPanel } from "@/features/data/parts";
import { offlineMapsAvailable } from "@/features/maps/offline";
import { distanceText } from "@/features/recordings/format";
import { lastUsedText } from "@/features/routes/format";
import { RouteMap } from "@/features/routes/RouteMap";
import { RouteOfflineHint } from "@/features/routes/RouteOfflineHint";
import { RouteProfileChart } from "@/features/routes/RouteProfileChart";
import { loadRouteGeometry, routeById, routeMapPath, routeProfilePoints } from "@/features/routes/routeData";
import type { RouteLoad } from "@/features/routes/routeData";
import { useLiveValue } from "@/features/stats/live";
import { Message } from "@/features/training/Message";
import { shortDate } from "@/format/dates";
import { formatInteger } from "@/format/numbers";
import { PrimaryButton } from "@/ui/Button";
import { IconButton, MenuItem, TextField } from "@/ui/Inputs";
import { AppBar, Screen } from "@/ui/Layout";
import { goBack } from "@/ui/navigation";
import { Sheet } from "@/ui/Overlays";
import { BevelView } from "@/ui/Shapes";
import { useSnackbar } from "@/ui/SnackbarHost";
import { StatRow } from "@/ui/Stats";
import type { StatValue } from "@/ui/Stats";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { bevels, radii } from "@/ui/tokens";

interface RouteData {
  readonly row: Route;
  /** The activity it was made from, while it is outside the trash. */
  readonly source: Session | null;
}

function loadRoute(routeId: Id): RouteData | null {
  const row = routeById(routeId);
  if (row === null) return null;
  const source = row.sourceSessionId === null ? undefined : db().select().from(session).where(and(eq(session.id, row.sourceSessionId), isNull(session.deletedAt))).get();
  return { row, source: source ?? null };
}

interface RouteDrawing {
  readonly load: RouteLoad;
  readonly path: PreviewPath | null;
  readonly profile: readonly ElevationPoint[];
}

/** The route's file, read again when it is reversed. */
function useRouteDrawing(row: Route): RouteDrawing | null {
  const [drawing, setDrawing] = useState<RouteDrawing | null>(null);
  const { trackFile, trackSha256, reversed, elevationSource } = row;
  useEffect(() => {
    let active = true;
    void loadRouteGeometry({ trackFile, trackSha256, reversed, elevationSource }).then((load) => {
      if (!active) return;
      setDrawing(load.kind === "loaded" ? { load, path: routeMapPath(load.geometry), profile: routeProfilePoints(load.geometry) } : { load, path: null, profile: [] });
    });
    return () => {
      active = false;
    };
  }, [trackFile, trackSha256, reversed, elevationSource]);
  return drawing;
}

interface RouteScreenProps {
  readonly routeId: Id;
}

/** `RTE-002`: a route with its map and profile, followed from here, renamed, reversed or put in the trash. */
export function RouteScreen({ routeId }: RouteScreenProps) {
  const notify = useSnackbar();
  const data = useLiveValue(() => loadRoute(routeId), ["route", "session"], [routeId]);
  if (data === null) return <Message title="Itinéraire introuvable" detail="Il n'existe pas ou plus." action={null} />;
  const { row } = data;
  if (row.deletedAt !== null) {
    return (
      <Message
        title="Itinéraire supprimé"
        detail="Il reste 30 jours dans la corbeille."
        action={{
          label: "Restaurer",
          run: () => {
            write(`Restauration : itinéraire ${row.name}`, [{ kind: "update", table: "route", key: row.id, patch: { deletedAt: null } }]);
            notify({ text: "Itinéraire restauré", aboveTabBar: false });
          },
        }}
      />
    );
  }
  return <RouteDetail data={data} />;
}

interface RouteDetailProps {
  readonly data: RouteData;
}

function RouteDetail({ data }: RouteDetailProps) {
  const { colors } = useTheme();
  const notify = useSnackbar();
  const undoableWrite = useUndoableWrite();
  const [more, setMore] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const { row, source } = data;
  const drawing = useRouteDrawing(row);
  const placement = { aboveTabBar: false } as const;
  const sportLabel = sports[row.sport].label;

  const distance = distanceText(row.distanceMm);
  const stats: StatValue[] = [
    { label: "Distance", value: distance.value, unit: distance.unit },
    { label: "D+", value: row.ascentMm === null ? "–" : formatInteger(row.ascentMm / 1000), unit: row.ascentMm === null ? "" : "m" },
    { label: "D−", value: row.descentMm === null ? "–" : formatInteger(row.descentMm / 1000), unit: row.descentMm === null ? "" : "m" },
  ];

  const rename = (name: string): void => {
    setRenaming(false);
    try {
      const mutation = renameRoute(row, name);
      if (mutation === null) return;
      undoableWrite({ summary: `Itinéraire renommé : ${name.trim()}`, mutations: [mutation], message: "Itinéraire renommé", ...placement });
    } catch (error) {
      if (error instanceof InvalidRouteError) {
        notify({ text: "Nom manquant", ...placement });
        return;
      }
      throw error;
    }
  };

  const reverse = (): void => {
    setMore(false);
    if (drawing?.load.kind !== "loaded") return;
    undoableWrite({ summary: `Itinéraire inversé : ${row.name}`, mutations: [reverseRoute(row, drawing.load.track)], message: "Sens inversé", ...placement });
  };

  const remove = (): void => {
    setMore(false);
    undoableWrite({ summary: `Suppression : itinéraire ${row.name}`, mutations: [trashMutation("route", row.id, environment.now())], message: "Itinéraire supprimé · dans la corbeille 30 jours", ...placement });
    goBack("/routes");
  };

  const unreadable = drawing !== null && drawing.load.kind !== "loaded";

  return (
    <View style={styles.root}>
      <Screen bottomInset={120}>
        <AppBar title={row.name} leading={<IconButton icon="back" label="Retour" edge="start" onPress={() => goBack("/routes")} />} trailing={<IconButton icon="more" label="Plus d'actions" edge="end" onPress={() => setMore(true)} />} />
        <Text variant="eyebrow" tone="secondary">
          {`${sportLabel} · ${lastUsedText(row.lastUsedAt)}${row.reversed ? " · sens inversé" : ""}`}
        </Text>
        {drawing === null || drawing.path === null ? <View style={[styles.mapPlaceholder, { borderColor: colors.line, backgroundColor: colors.surface }]} /> : <RouteMap path={drawing.path} sport={row.sport} height={260} interactive />}
        {unreadable ? (
          <Text variant="small" tone="secondary" style={styles.problem} accessibilityLiveRegion="polite">
            Le fichier de cet itinéraire est illisible : il ne peut plus être suivi.
          </Text>
        ) : null}
        <BevelView fill={colors.surface} cut={bevels.tile} style={styles.stats}>
          <StatRow stats={stats} />
        </BevelView>
        {drawing === null || drawing.profile.length < 2 ? null : <RouteProfileChart points={drawing.profile} />}
        <RouteOfflineHint route={row} />
      </Screen>

      <BottomPanel>
        <PrimaryButton label="Suivre cet itinéraire" disabled={unreadable} onPress={() => router.push({ pathname: "/record", params: { sport: row.sport, routeId: row.id } })} />
      </BottomPanel>

      <Sheet open={more} title={row.name} onClose={() => setMore(false)}>
        <View style={styles.menu}>
          <MenuItem
            label="Renommer"
            onPress={() => {
              setMore(false);
              setRenaming(true);
            }}
          />
          {drawing?.load.kind === "loaded" ? <MenuItem label="Inverser le sens" detail="D+ et D− recalculés dans l'autre sens" onPress={reverse} /> : null}
          {offlineMapsAvailable ? (
            <MenuItem
              label="Carte hors ligne autour"
              onPress={() => {
                setMore(false);
                router.push({ pathname: "/settings/offline-region", params: { route: row.id } });
              }}
            />
          ) : null}
          {source === null ? null : (
            <MenuItem
              label="Voir l'activité d'origine"
              detail={shortDate(source.localDate)}
              onPress={() => {
                setMore(false);
                router.push({ pathname: "/session/[id]", params: { id: source.id } });
              }}
            />
          )}
          <MenuItem label="Supprimer l'itinéraire" detail="30 jours dans la corbeille" onPress={remove} />
        </View>
      </Sheet>
      <Sheet open={renaming} title="Renommer l'itinéraire" onClose={() => setRenaming(false)}>
        {renaming ? <RenameForm name={row.name} onSave={rename} /> : null}
      </Sheet>
    </View>
  );
}

interface RenameFormProps {
  readonly name: string;
  readonly onSave: (name: string) => void;
}

function RenameForm({ name, onSave }: RenameFormProps) {
  const [draft, setDraft] = useState(name);
  return (
    <View style={styles.form}>
      <TextField value={draft} onChangeText={setDraft} placeholder="Nom de l'itinéraire" accessibilityLabel="Nom de l'itinéraire" maxLength={60} autoFocus />
      <PrimaryButton label="Renommer" disabled={draft.trim() === ""} onPress={() => onSave(draft)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  mapPlaceholder: { height: 260, marginTop: 14, borderRadius: radii.panel, borderWidth: 1 },
  problem: { marginTop: 10 },
  stats: { marginTop: 8, paddingHorizontal: 14, paddingVertical: 14 },
  menu: { marginTop: 8 },
  form: { gap: 14, paddingTop: 12 },
});
