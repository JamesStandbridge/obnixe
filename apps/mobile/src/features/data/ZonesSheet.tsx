import { View } from "react-native";
import { isNull } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { zoneKeys, zones, zoneTracking } from "@obnixe/schema";
import type { ZoneKey } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { write } from "@/data/write";
import { SwitchRow } from "@/features/data/parts";
import { Sheet } from "@/ui/Overlays";

export function useTrackedZones(): readonly { readonly id: string; readonly zone: ZoneKey }[] {
  const { data } = useLiveQuery(db().select({ id: zoneTracking.id, zone: zoneTracking.zone }).from(zoneTracking).where(isNull(zoneTracking.endedAt)));
  return data;
}

interface ZonesSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function ZonesSheet({ open, onClose }: ZonesSheetProps) {
  const tracked = useTrackedZones();
  const trackedByZone = new Map(tracked.map((row) => [row.zone, row.id]));

  const toggle = (zone: ZoneKey, enabled: boolean): void => {
    const label = zones[zone].label;
    const existing = trackedByZone.get(zone);
    if (enabled && existing === undefined) {
      write(`Suivi : ${label}`, [{ kind: "insert", table: "zone_tracking", row: { id: environment.newId(), zone, reason: "user", painReportId: null, startedAt: environment.now(), endedAt: null } }]);
    } else if (!enabled && existing !== undefined) {
      write(`Fin du suivi : ${label}`, [{ kind: "update", table: "zone_tracking", key: existing, patch: { endedAt: environment.now() } }]);
    }
  };

  return (
    <Sheet open={open} title="Zones suivies" context="Elles reviennent dans chaque bilan" onClose={onClose}>
      <View>
        {zoneKeys
          .filter((zone) => !("retired" in zones[zone]) || trackedByZone.has(zone))
          .map((zone) => (
            <SwitchRow key={zone} title={zones[zone].label} value={trackedByZone.has(zone)} onChange={(enabled) => toggle(zone, enabled)} divided large />
          ))}
      </View>
    </Sheet>
  );
}
