import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { updateSettings } from "@/data/settings";
import { Chevron } from "@/features/data/parts";
import { megabytes } from "@/features/data/format";
import { MapPreview } from "@/features/maps/MapPreview";
import { offlineMapsAvailable, useOfflineRegions } from "@/features/maps/offline";
import { offlineBytes } from "@/features/maps/offlineRegions";
import { mapStyleOptions } from "@/features/maps/styles";
import { useMapStyleSetting } from "@/features/maps/useMapBase";
import { Segmented } from "@/ui/Controls";
import { Choices } from "@/ui/Inputs";
import { Row, Section } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";
import { Text } from "@/ui/Text";

const cacheChoices = ["100", "200", "500", "1000"] as const;

interface MapSettingsSectionProps {
  readonly cacheMegabytes: number;
}

export function MapSettingsSection({ cacheMegabytes }: MapSettingsSectionProps) {
  const mapStyle = useMapStyleSetting();
  const regions = useOfflineRegions();
  const [cacheOpen, setCacheOpen] = useState(false);
  const selected = mapStyleOptions.find((option) => option.value === mapStyle);

  return (
    <Section title="Cartes">
      <MapPreview />
      <View style={styles.style} accessibilityLabel="Fond de carte">
        <Segmented options={mapStyleOptions} value={mapStyle} onChange={(value) => updateSettings({ mapStyle: value })} />
        {selected === undefined ? null : (
          <Text variant="small" tone="secondary" style={styles.styleDetail}>
            {selected.detail}
          </Text>
        )}
      </View>
      {offlineMapsAvailable ? (
        <>
          <Row
            title="Cartes hors ligne"
            detail={regions.length === 0 ? "aucune région" : `${megabytes(offlineBytes(regions))} Mo sur ce téléphone`}
            value={String(regions.length)}
            trailing={<Chevron />}
            onPress={() => router.push("/settings/offline-maps")}
          />
          <Row title="Cache de carte" detail="zones vues récemment" value={String(cacheMegabytes)} valueDetail="Mo" trailing={<Chevron />} onPress={() => setCacheOpen(true)} last />
          <Sheet open={cacheOpen} title="Cache de carte" context="Les zones vues récemment restent affichables sans réseau" onClose={() => setCacheOpen(false)}>
            <Choices
              items={cacheChoices.map((value) => ({ value, label: `${value} Mo`, selected: Number(value) === cacheMegabytes }))}
              onChoose={(value) => {
                updateSettings({ mapCacheMegabytes: Number(value) });
                setCacheOpen(false);
              }}
            />
          </Sheet>
        </>
      ) : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  style: { marginTop: 12, marginBottom: 4 },
  styleDetail: { marginTop: 8 },
});
