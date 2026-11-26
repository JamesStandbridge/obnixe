import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { dayMonth, fileSize, megabytes } from "@/features/data/format";
import { BackButton, BottomPanel, Chevron } from "@/features/data/parts";
import { deleteOfflineRegion, offlineMapsAvailable, updateOfflineRegion, useOfflineRegions } from "@/features/maps/offline";
import { offlineBytes } from "@/features/maps/offlineRegions";
import type { OfflineRegion, OfflineRegionState } from "@/features/maps/offlineRegions";
import { mapStyleOptions } from "@/features/maps/styles";
import { useNativeFailure } from "@/features/maps/nativeFailure";
import { PrimaryButton } from "@/ui/Button";
import { MenuItem } from "@/ui/Inputs";
import { AppBar, Row, Screen, Section } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";

function styleLabel(region: OfflineRegion): string {
  return mapStyleOptions.find((option) => option.value === region.mapStyle)?.label ?? "";
}

function progressLabel(state: OfflineRegionState, percentage: number): string {
  switch (state) {
    case "downloading":
      return `Téléchargement, ${Math.floor(percentage)} %`;
    case "paused":
      return `En attente de réseau, ${Math.floor(percentage)} %`;
    case "complete":
      return "";
    default: {
      const unhandled: never = state;
      return unhandled;
    }
  }
}

interface ProgressLineProps {
  readonly percentage: number;
}

function ProgressLine({ percentage }: ProgressLineProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.track, { backgroundColor: colors.line }]}>
      <View style={[styles.fill, { width: `${percentage}%`, backgroundColor: colors.mark }]} />
    </View>
  );
}

interface RegionProgressProps {
  readonly region: OfflineRegion;
}

function RegionProgress({ region }: RegionProgressProps) {
  return (
    <View style={styles.progress}>
      <Text variant="small" tone="secondary">
        {progressLabel(region.state, region.percentage)}
      </Text>
      <ProgressLine percentage={region.percentage} />
    </View>
  );
}

/** Downloaded regions, their size and date, with update and removal (MAP-031). */
export function OfflineMapsScreen() {
  const regions = useOfflineRegions();
  const run = useNativeFailure();
  const [chosen, setChosen] = useState<OfflineRegion | null>(null);
  const close = (): void => setChosen(null);

  if (!offlineMapsAvailable) {
    return (
      <Screen>
        <AppBar title="Cartes hors ligne" variant="context" leading={<BackButton />} />
        <Text tone="secondary" style={styles.intro}>
          Les régions hors ligne se téléchargent depuis l'application sur téléphone.
        </Text>
      </Screen>
    );
  }

  return (
    <View style={styles.root}>
      <Screen bottomInset={120}>
        <AppBar title="Cartes hors ligne" variant="context" leading={<BackButton />} />
        <Text tone="secondary" style={styles.intro}>
          Fond de carte jusqu'au zoom 14 et relief, affichés sans réseau. Un téléchargement interrompu reprend seul.
        </Text>

        <Section title="Régions">
          {regions.length === 0 ? (
            <Text tone="tertiary" style={styles.empty}>
              Aucune région téléchargée
            </Text>
          ) : (
            regions.map((region) => (
              <Row
                key={region.id}
                title={region.name}
                detail={region.state === "complete" ? `${dayMonth(region.createdAt)} · ${styleLabel(region)}` : <RegionProgress region={region} />}
                {...(region.state === "complete" ? { value: megabytes(region.bytes), valueDetail: "Mo" } : {})}
                trailing={<Chevron />}
                onPress={() => setChosen(region)}
              />
            ))
          )}
          <Row title="Espace occupé" detail="régions hors ligne" value={megabytes(offlineBytes(regions))} valueDetail="Mo" trailing={<View style={styles.chevronSpace} />} last />
        </Section>
      </Screen>

      <BottomPanel>
        <PrimaryButton label="Télécharger une région" onPress={() => router.push("/settings/offline-region")} />
      </BottomPanel>

      <Sheet open={chosen !== null} title={chosen?.name ?? ""} context={chosen === null ? "" : `${fileSize(chosen.bytes)} · ${styleLabel(chosen)}`} onClose={close}>
        {chosen === null ? null : (
          <View>
            <MenuItem
              label={chosen.state === "complete" ? "Mettre à jour" : "Reprendre"}
              detail={chosen.state === "complete" ? "Télécharge ce qui a changé depuis" : "Relance le téléchargement"}
              onPress={() => {
                close();
                run(updateOfflineRegion(chosen.id), "Mise à jour impossible");
              }}
            />
            <MenuItem
              label="Supprimer"
              detail="Libère l'espace sur ce téléphone"
              destructive
              onPress={() => {
                close();
                run(deleteOfflineRegion(chosen.id), "Suppression impossible");
              }}
            />
          </View>
        )}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  intro: { marginTop: 4 },
  empty: { paddingVertical: 16 },
  progress: { gap: 6, paddingTop: 2 },
  track: { height: 3, borderRadius: 2, overflow: "hidden" },
  fill: { height: 3 },
  chevronSpace: { width: 16 },
});
