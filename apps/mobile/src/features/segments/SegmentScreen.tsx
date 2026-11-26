import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { LayoutChangeEvent } from "react-native";
import { router } from "expo-router";
import { and, eq, isNull } from "drizzle-orm";
import { activePrivacyMask, dateParts, InvalidSegmentError, renameSegment, segmentBoard, trashMutation } from "@obnixe/core";
import type { SegmentBoard, SegmentEffortEntry } from "@obnixe/core";
import { session, sports } from "@obnixe/schema";
import type { Id, LocalDate, Segment, SegmentFamily, Session, SportKey } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { useUndoableWrite, write } from "@/data/write";
import { AttributionButton } from "@/features/maps/MapControls";
import { MapSurface } from "@/features/maps/MapSurface";
import type { MapCamera, MapOverlay } from "@/features/maps/surface";
import { rims } from "@/features/maps/trackLayers";
import { useMapBase } from "@/features/maps/useMapBase";
import { fitCamera } from "@/features/maps/viewport";
import { distanceText, elapsedText } from "@/features/recordings/format";
import { segmentRankLabel, segmentTrendText } from "@/features/segments/format";
import { segmentLayers, segmentMapGeometry, segmentSourceId } from "@/features/segments/segmentMap";
import type { SegmentMapGeometry } from "@/features/segments/segmentMap";
import { useLiveValue } from "@/features/stats/live";
import { useDerivedRebuildState } from "@/features/tracking/recorder";
import { Message } from "@/features/training/Message";
import { shortDate } from "@/format/dates";
import { formatInteger, formatNumber } from "@/format/numbers";
import { PrimaryButton } from "@/ui/Button";
import { Tag } from "@/ui/Controls";
import { IconButton, MenuItem, TextField } from "@/ui/Inputs";
import { AppBar, Row, Screen, Section } from "@/ui/Layout";
import { goBack } from "@/ui/navigation";
import { Sheet } from "@/ui/Overlays";
import { BevelView } from "@/ui/Shapes";
import { useSnackbar } from "@/ui/SnackbarHost";
import { StatRow } from "@/ui/Stats";
import type { StatValue } from "@/ui/Stats";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { bevels, fonts, radii } from "@/ui/tokens";

const mapHeight = 260;
const framePadding = 36;
const maxFitZoom = 17;

/** The sport whose colors a family's segments are drawn with. */
const familySport: Readonly<Record<SegmentFamily, SportKey>> = { foot: "run", bike: "bike", snow: "nordic_ski", water: "paddle" };
const familyLabels: Readonly<Record<SegmentFamily, string>> = { foot: "Segment à pied", bike: "Segment à vélo", snow: "Segment à ski", water: "Segment sur l'eau" };

interface SegmentData {
  readonly board: SegmentBoard;
  /** The activity it was drawn from, while it is outside the trash. */
  readonly source: Session | null;
  readonly geometry: SegmentMapGeometry;
}

function loadSegment(segmentId: Id): SegmentData | null {
  const board = segmentBoard(db(), segmentId);
  if (board === null) return null;
  const sourceId = board.segment.sourceSessionId;
  const source = sourceId === null ? undefined : db().select().from(session).where(and(eq(session.id, sourceId), isNull(session.deletedAt))).get();
  return { board, source: source ?? null, geometry: segmentMapGeometry(board.segment, activePrivacyMask(db()).zones) };
}

function dateText(date: LocalDate): string {
  return `${shortDate(date)} ${dateParts(date).year}`;
}

function entryTitle(entry: SegmentEffortEntry): string {
  return entry.title ?? sports[entry.sport].label;
}

function openSession(sessionId: Id): void {
  router.push({ pathname: "/session/[id]", params: { id: sessionId } });
}

interface SegmentScreenProps {
  readonly segmentId: Id;
}

/** `SEG-003`: a segment with its best, last, count and trend, and every effort in force ranked. */
export function SegmentScreen({ segmentId }: SegmentScreenProps) {
  const notify = useSnackbar();
  const data = useLiveValue(() => loadSegment(segmentId), ["segment", "segment_effort", "session", "privacy_zone"], [segmentId]);
  if (data === null) return <Message title="Segment introuvable" detail="Il n'existe pas ou plus." action={null} />;
  const { segment } = data.board;
  if (segment.deletedAt !== null) {
    return (
      <Message
        title="Segment supprimé"
        detail="Il reste 30 jours dans la corbeille."
        action={{
          label: "Restaurer",
          run: () => {
            write(`Restauration : segment ${segment.name}`, [{ kind: "update", table: "segment", key: segment.id, patch: { deletedAt: null } }]);
            notify({ text: "Segment restauré", aboveTabBar: false });
          },
        }}
      />
    );
  }
  return <SegmentDetail data={data} />;
}

interface SegmentDetailProps {
  readonly data: SegmentData;
}

function SegmentDetail({ data }: SegmentDetailProps) {
  const { colors } = useTheme();
  const notify = useSnackbar();
  const undoableWrite = useUndoableWrite();
  const rebuild = useDerivedRebuildState();
  const [more, setMore] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const { board, source, geometry } = data;
  const { segment } = board;
  const placement = { aboveTabBar: false } as const;

  const distance = distanceText(segment.distanceMm);
  const stats: StatValue[] = [
    { label: "Distance", value: distance.value, unit: distance.unit },
    { label: "D+", value: formatInteger(segment.ascentMm / 1000), unit: "m" },
    { label: "Pente moy.", value: formatNumber((segment.ascentMm / segment.distanceMm) * 100, 1, 1), unit: "%" },
    { label: "Passages", value: formatInteger(board.count), unit: "" },
  ];

  const rename = (name: string): void => {
    setRenaming(false);
    try {
      const mutation = renameSegment(segment, name);
      if (mutation === null) return;
      undoableWrite({ summary: `Segment renommé : ${name.trim()}`, mutations: [mutation], message: "Segment renommé", ...placement });
    } catch (error) {
      if (error instanceof InvalidSegmentError) {
        notify({ text: "Nom manquant", ...placement });
        return;
      }
      throw error;
    }
  };

  const remove = (): void => {
    setMore(false);
    undoableWrite({ summary: `Suppression : segment ${segment.name}`, mutations: [trashMutation("segment", segment.id, environment.now())], message: "Segment supprimé · dans la corbeille 30 jours", aboveTabBar: false });
    goBack("/records");
  };

  return (
    <>
      <Screen>
        <AppBar title={segment.name} leading={<IconButton icon="back" label="Retour" edge="start" onPress={() => goBack("/records")} />} trailing={<IconButton icon="more" label="Plus d'actions" edge="end" onPress={() => setMore(true)} />} />
        <Text variant="eyebrow" tone="secondary">
          {familyLabels[segment.family]}
        </Text>
        <SegmentMap segment={segment} geometry={geometry} />
        <BevelView fill={colors.surface} cut={bevels.tile} style={styles.stats}>
          <StatRow stats={stats} />
        </BevelView>
        {rebuild.segments > 0 ? (
          <Text variant="small" tone="secondary" style={styles.searching} accessibilityLiveRegion="polite">
            Recherche des passages…
          </Text>
        ) : null}
        <Section title="Tes temps">
          {board.best === null || board.last === null ? (
            <Text tone="secondary" style={styles.empty}>
              Aucun passage pour l'instant : chaque activité qui le parcourt dans le même sens y apparaîtra.
            </Text>
          ) : (
            <>
              <Row title="Meilleur temps" detail={dateText(board.best.localDate)} value={elapsedText(board.best.elapsedMs)} onPress={() => board.best !== null && openSession(board.best.sessionId)} />
              <Row title="Dernier passage" detail={dateText(board.last.localDate)} value={elapsedText(board.last.elapsedMs)} onPress={() => board.last !== null && openSession(board.last.sessionId)} />
              <Row title="Tendance" detail="tes derniers passages face aux précédents" value={segmentTrendText(board.trend)} last />
            </>
          )}
        </Section>
        {board.ranked.length === 0 ? null : (
          <Section title="Classement">
            {board.ranked.map((entry, index) => {
              const badge = index === 0 ? segmentRankLabel(1, board.count) : null;
              return (
                <Row
                  key={`${entry.sessionId}:${entry.occurrence}`}
                  leading={<Text style={[styles.rank, { color: index === 0 ? colors.mark : colors.text2 }]}>{index + 1}</Text>}
                  title={entryTitle(entry)}
                  detail={dateText(entry.localDate)}
                  value={elapsedText(entry.elapsedMs)}
                  {...(entry.heartRateAvg === null ? {} : { valueDetail: `${formatInteger(entry.heartRateAvg)} bpm` })}
                  trailing={badge === null ? undefined : <Tag label={badge} />}
                  onPress={() => openSession(entry.sessionId)}
                  last={index === board.ranked.length - 1}
                />
              );
            })}
          </Section>
        )}
      </Screen>

      <Sheet open={more} title={segment.name} onClose={() => setMore(false)}>
        <View style={styles.menu}>
          <MenuItem
            label="Renommer"
            onPress={() => {
              setMore(false);
              setRenaming(true);
            }}
          />
          {source === null ? null : (
            <MenuItem
              label="Voir l'activité d'origine"
              detail={dateText(source.localDate)}
              onPress={() => {
                setMore(false);
                openSession(source.id);
              }}
            />
          )}
          <MenuItem label="Supprimer le segment" detail="30 jours dans la corbeille" onPress={remove} />
        </View>
      </Sheet>
      <RenameSheet open={renaming} name={segment.name} onClose={() => setRenaming(false)} onSave={rename} />
    </>
  );
}

interface SegmentMapProps {
  readonly segment: Segment;
  readonly geometry: SegmentMapGeometry;
}

function SegmentMap({ segment, geometry }: SegmentMapProps) {
  const { colors, name } = useTheme();
  const sport = familySport[segment.family];
  const base = useMapBase(sport);
  const [camera, setCamera] = useState<MapCamera | null>(null);
  const overlays = useMemo<MapOverlay[]>(
    () => [{ id: segmentSourceId, data: geometry.data, lineMetrics: false, layers: segmentLayers({ line: colors.sport[sport], rim: rims[name], start: colors.sportDeep[sport], finish: colors.text }) }],
    [geometry, colors, sport, name],
  );
  const onLayout = (event: LayoutChangeEvent): void => {
    if (camera !== null || geometry.bounds === null) return;
    const { width, height } = event.nativeEvent.layout;
    setCamera(fitCamera(geometry.bounds, { width, height }, framePadding, maxFitZoom));
  };
  return (
    <View style={[styles.frame, { borderColor: colors.line, backgroundColor: colors.surface }]} onLayout={onLayout}>
      {camera === null ? null : <MapSurface mapStyle={base.style} fallbackStyle={base.fallback} initialCamera={camera} overlays={overlays} />}
      {geometry.masked ? (
        <View style={[styles.badge, { backgroundColor: colors.surface, borderColor: colors.line }]} pointerEvents="none">
          <Text variant="caption" tone="secondary">
            Parties masquées
          </Text>
        </View>
      ) : null}
      <View style={styles.attribution}>
        <AttributionButton attribution={base.attribution} />
      </View>
    </View>
  );
}

interface RenameSheetProps {
  readonly open: boolean;
  readonly name: string;
  readonly onClose: () => void;
  readonly onSave: (name: string) => void;
}

function RenameSheet({ open, name, onClose, onSave }: RenameSheetProps) {
  return (
    <Sheet open={open} title="Renommer le segment" onClose={onClose}>
      {open ? <RenameForm name={name} onSave={onSave} /> : null}
    </Sheet>
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
      <TextField value={draft} onChangeText={setDraft} placeholder="Nom du segment" accessibilityLabel="Nom du segment" maxLength={60} autoFocus />
      <PrimaryButton label="Renommer" disabled={draft.trim() === ""} onPress={() => onSave(draft)} />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { height: mapHeight, marginTop: 8, borderRadius: radii.panel, borderWidth: 1, overflow: "hidden" },
  attribution: { position: "absolute", right: 8, bottom: 8 },
  badge: { position: "absolute", left: 8, top: 8, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, borderWidth: 1 },
  stats: { marginTop: 8, paddingHorizontal: 14, paddingVertical: 14 },
  searching: { marginTop: 12 },
  empty: { marginTop: 10 },
  rank: { width: 22, fontFamily: fonts.figure700, fontSize: 17 },
  menu: { marginTop: 8 },
  form: { gap: 14, paddingTop: 12 },
});
