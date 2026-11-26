import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { distanceToRouteStart, routeLibrary } from "@obnixe/core";
import type { Id, SportKey } from "@obnixe/schema";
import { db } from "@/data/database";
import type { GeoPoint } from "@/features/maps/tiles";
import { routeFigures, startDistanceText } from "@/features/routes/format";
import { useLiveValue } from "@/features/stats/live";
import { MenuItem } from "@/ui/Inputs";
import { Sheet } from "@/ui/Overlays";
import { Text } from "@/ui/Text";

interface RouteSheetProps {
  readonly open: boolean;
  readonly sport: SportKey;
  readonly sportLabel: string;
  readonly position: GeoPoint | null;
  readonly onSelect: (routeId: Id | null) => void;
  readonly onClose: () => void;
}

/** `RTE-003`: the routes of the sport, most recently followed first, with the distance to their start. */
export function RouteSheet({ open, sport, sportLabel, position, onSelect, onClose }: RouteSheetProps) {
  const routes = useLiveValue(() => routeLibrary(db(), "recent", sport), ["route"], [sport]);
  const leave = (pathname: "/routes" | "/routes/import"): void => {
    onClose();
    router.push(pathname);
  };
  return (
    <Sheet open={open} title="Itinéraire" context={sportLabel} onClose={onClose}>
      <View>
        <MenuItem label="Sans itinéraire" onPress={() => onSelect(null)} />
        {routes.map((row) => (
          <MenuItem
            key={row.id}
            label={row.name}
            detail={position === null ? routeFigures(row) : `${routeFigures(row)} · ${startDistanceText(distanceToRouteStart(row, position))}`}
            onPress={() => onSelect(row.id)}
          />
        ))}
        {routes.length === 0 ? (
          <Text variant="small" tone="secondary" style={styles.empty}>
            Aucun itinéraire pour ce sport : importe un GPX ou refais une de tes sorties.
          </Text>
        ) : null}
        <MenuItem label="Importer un itinéraire" detail="GPX, FIT ou TCX" onPress={() => leave("/routes/import")} />
        <MenuItem label="Tous les itinéraires" onPress={() => leave("/routes")} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  empty: { paddingVertical: 12 },
});
