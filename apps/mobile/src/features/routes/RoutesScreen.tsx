import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { routeLibrary } from "@obnixe/core";
import type { RouteOrder } from "@obnixe/core";
import { sports } from "@obnixe/schema";
import { db } from "@/data/database";
import { BackButton, BottomPanel } from "@/features/data/parts";
import { TrackPreview } from "@/features/recordings/TrackPreview";
import { lastUsedText, routeFigures } from "@/features/routes/format";
import { useLiveValue } from "@/features/stats/live";
import { PrimaryButton } from "@/ui/Button";
import { Segmented } from "@/ui/Controls";
import type { SegmentOption } from "@/ui/Controls";
import { AppBar, Row, Screen, Section } from "@/ui/Layout";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";

const orderOptions: readonly SegmentOption<RouteOrder>[] = [
  { value: "recent", label: "Récents" },
  { value: "name", label: "Nom" },
  { value: "distance", label: "Distance" },
  { value: "ascent", label: "D+" },
];

/** `RTE-002`: every route outside the trash, sorted, each opened on its own screen. */
export function RoutesScreen() {
  const { colors } = useTheme();
  const [order, setOrder] = useState<RouteOrder>("recent");
  const routes = useLiveValue(() => routeLibrary(db(), order, null), ["route"], [order]);
  return (
    <View style={styles.root}>
      <Screen bottomInset={120}>
        <AppBar title="Itinéraires" variant="context" leading={<BackButton />} />
        <Text tone="secondary" style={styles.intro}>
          Choisis-en un au départ d'une sortie : la carte le montre sous ta trace et te prévient si tu t'en écartes.
        </Text>
        {routes.length === 0 ? null : (
          <View style={styles.order} accessibilityLabel="Trier les itinéraires">
            <Segmented options={orderOptions} value={order} onChange={setOrder} />
          </View>
        )}
        <Section title="Itinéraires">
          {routes.length === 0 ? (
            <Text tone="tertiary" style={styles.empty}>
              Aucun itinéraire : importe un GPX, ou ouvre une sortie et choisis « Refaire ce parcours ».
            </Text>
          ) : (
            routes.map((row, index) => (
              <Row
                key={row.id}
                title={row.name}
                detail={
                  <>
                    <Text variant="small">{routeFigures(row)}</Text>
                    <Text variant="small" tone="secondary">{`${sports[row.sport].label} · ${lastUsedText(row.lastUsedAt)}`}</Text>
                  </>
                }
                trailing={<TrackPreview polyline={row.previewPolyline} color={colors.mark} width={44} height={32} />}
                onPress={() => router.push({ pathname: "/routes/[id]", params: { id: row.id } })}
                last={index === routes.length - 1}
              />
            ))
          )}
        </Section>
      </Screen>
      <BottomPanel>
        <PrimaryButton label="Importer un itinéraire" onPress={() => router.push("/routes/import")} />
      </BottomPanel>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  intro: { marginTop: 4 },
  order: { marginTop: 16 },
  empty: { paddingVertical: 16 },
});
