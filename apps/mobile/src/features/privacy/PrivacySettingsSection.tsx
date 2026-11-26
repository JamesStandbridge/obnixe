import { useState } from "react";
import { router } from "expo-router";
import { updateSettings } from "@/data/settings";
import { Chevron, SwitchRow } from "@/features/data/parts";
import { usePrivacyZones } from "@/features/privacy/usePrivacyZones";
import { formatInteger } from "@/format/numbers";
import { Choices } from "@/ui/Inputs";
import { Row, Section } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";

const hideEndsChoices = ["0", "100", "200", "300", "500", "1000"] as const;

function hideEndsLabel(meters: number): string {
  return meters === 0 ? "Visibles" : `${formatInteger(meters)} m`;
}

interface PrivacySettingsSectionProps {
  readonly hideTrackEndsMeters: number;
  readonly exportPrivacy: boolean;
}

/** Zones, hidden track ends and the export default of `PRV-010` to `PRV-012`. */
export function PrivacySettingsSection({ hideTrackEndsMeters, exportPrivacy }: PrivacySettingsSectionProps) {
  const zones = usePrivacyZones();
  const [endsOpen, setEndsOpen] = useState(false);

  return (
    <Section title="Confidentialité">
      <Row
        title="Zones de confidentialité"
        detail={zones.length === 0 ? "aucune" : zones.map((zone) => zone.label).join(", ")}
        value={String(zones.length)}
        trailing={<Chevron />}
        onPress={() => router.push("/settings/privacy-zones")}
      />
      <Row
        title="Début et fin de trace"
        detail={hideTrackEndsMeters === 0 ? "visibles hors de l'app" : "masqués hors de l'app"}
        {...(hideTrackEndsMeters === 0 ? {} : { value: formatInteger(hideTrackEndsMeters), valueDetail: "m" })}
        trailing={<Chevron />}
        onPress={() => setEndsOpen(true)}
      />
      <SwitchRow title="Appliquer les zones à l'export" detail="choix proposé à chaque export" value={exportPrivacy} onChange={(value) => updateSettings({ exportPrivacy: value })} />
      <Sheet open={endsOpen} title="Début et fin de trace" context="Masqués dans les exports, les aperçus et pour l'agent, sur cette distance" onClose={() => setEndsOpen(false)}>
        <Choices
          items={hideEndsChoices.map((value) => ({ value, label: hideEndsLabel(Number(value)), selected: Number(value) === hideTrackEndsMeters }))}
          onChoose={(value) => {
            updateSettings({ hideTrackEndsMeters: Number(value) });
            setEndsOpen(false);
          }}
        />
      </Sheet>
    </Section>
  );
}
