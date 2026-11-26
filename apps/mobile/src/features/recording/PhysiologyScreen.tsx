import { useState } from "react";
import { StyleSheet, View } from "react-native";
import type { SettingsPatch } from "@obnixe/core";
import { biologicalSexes } from "@obnixe/schema";
import type { BiologicalSex } from "@obnixe/schema";
import { environment } from "@/data/database";
import { updateSettings, usePhysiology } from "@/data/settings";
import { BackButton, Chevron } from "@/features/data/parts";
import { maxHeartRateBounds, maxHeartRateDetail, maxHeartRateFrom, oldestBirthYear, sexLabels, youngestBirthYear, zoneLines } from "@/features/recording/physiology";
import { Choices } from "@/ui/Inputs";
import { AppBar, Row, Screen, Section } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";
import { PadSheet } from "@/ui/PadSheet";
import { Text } from "@/ui/Text";

type OpenSheet = "birth_year" | "sex" | "max_heart_rate" | null;

type SexChoice = BiologicalSex | "unset";

/** `CAL-004`: optional birth year, sex and maximum heart rate, prefilled with the Tanaka estimate. */
export function PhysiologyScreen() {
  const physiology = usePhysiology();
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const now = environment.now();
  const max = maxHeartRateFrom(physiology, now);
  const youngest = youngestBirthYear(now);
  const close = (): void => setSheet(null);
  const clear = (patch: SettingsPatch): void => {
    updateSettings(patch);
    close();
  };

  return (
    <>
      <Screen>
        <AppBar title="Profil physiologique" variant="context" leading={<BackButton />} />
        <Text variant="body" tone="secondary" style={styles.intro}>
          Tout est facultatif et reste sur ce téléphone. La FC max place tes zones cardio ; l'âge, le sexe et le poids affinent l'énergie dépensée.
        </Text>

        <Section title="Toi">
          <Row
            title="Année de naissance"
            detail={physiology.birthYear === null ? "Non renseignée" : String(physiology.birthYear)}
            trailing={<Chevron />}
            onPress={() => setSheet("birth_year")}
          />
          <Row title="Sexe" detail={physiology.sex === null ? "Non renseigné" : sexLabels[physiology.sex]} trailing={<Chevron />} onPress={() => setSheet("sex")} last />
        </Section>

        <Section title="Fréquence cardiaque">
          <Row
            title="FC maximale"
            detail={maxHeartRateDetail(max)}
            {...(max.kind === "unknown" ? {} : { value: String(max.bpm), valueDetail: "bpm" })}
            trailing={<Chevron />}
            onPress={() => setSheet("max_heart_rate")}
            last
          />
          {max.kind === "unknown" ? null : (
            <View style={styles.zones}>
              {zoneLines(max.bpm).map((line) => (
                <View key={line.zone} style={styles.zone} accessible accessibilityLabel={`${line.label}, ${line.bpm} battements par minute`}>
                  <Text variant="small" tone="secondary">
                    {line.label}
                  </Text>
                  <Text variant="label">{`${line.bpm} bpm`}</Text>
                </View>
              ))}
            </View>
          )}
        </Section>
      </Screen>

      <PadSheet
        open={sheet === "birth_year"}
        title="Année de naissance"
        mode="number"
        unit=""
        decimals={0}
        maxLength={4}
        current={physiology.birthYear === null ? null : String(physiology.birthYear)}
        validate={(value) => (Number.isInteger(value) && value >= oldestBirthYear && value <= youngest ? null : `Entre ${oldestBirthYear} et ${youngest}`)}
        {...(physiology.birthYear === null ? {} : { action: { label: "Effacer", appearance: "link", onPress: () => clear({ birthYear: null }) } })}
        onSubmit={(result) => {
          if (result.kind === "value") updateSettings({ birthYear: result.value });
          close();
        }}
        onClose={close}
      />

      <Sheet open={sheet === "sex"} title="Sexe" context="Pour l'équation d'énergie, rien d'autre" onClose={close}>
        <Choices<SexChoice>
          items={[...biologicalSexes.map((sex) => ({ value: sex, label: sexLabels[sex], selected: physiology.sex === sex })), { value: "unset", label: "Non renseigné", selected: physiology.sex === null }]}
          onChoose={(value) => {
            updateSettings({ sex: value === "unset" ? null : value });
            close();
          }}
        />
      </Sheet>

      <PadSheet
        open={sheet === "max_heart_rate"}
        title="FC maximale"
        context="La plus haute mesurée en effort maximal, sinon l'estimation"
        mode="number"
        unit="bpm"
        decimals={0}
        maxLength={3}
        current={max.kind === "unknown" ? null : String(max.bpm)}
        validate={(value) => (Number.isInteger(value) && value >= maxHeartRateBounds.min && value <= maxHeartRateBounds.max ? null : `Entre ${maxHeartRateBounds.min} et ${maxHeartRateBounds.max} bpm`)}
        {...(max.kind === "entered" ? { action: { label: physiology.birthYear === null ? "Effacer" : "Revenir à l'estimation", appearance: "link", onPress: () => clear({ maxHeartRate: null }) } } : {})}
        onSubmit={(result) => {
          if (result.kind === "value") updateSettings({ maxHeartRate: result.value });
          close();
        }}
        onClose={close}
      />
    </>
  );
}

const styles = StyleSheet.create({
  intro: { marginTop: 8 },
  zones: { marginTop: 12, gap: 8 },
  zone: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
});
