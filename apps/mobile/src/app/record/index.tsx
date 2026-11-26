import { useLocalSearchParams } from "expo-router";
import type { Id } from "@obnixe/schema";
import { PrepareScreen } from "@/features/recording/PrepareScreen";
import { isSportKey } from "@/features/recording/settings";

export default function RecordPrepare() {
  const { sport, kind, slotId, variantId, routeId } = useLocalSearchParams<{ sport?: string; kind?: string; slotId?: string; variantId?: string; routeId?: string }>();
  return (
    <PrepareScreen
      sport={sport !== undefined && isSportKey(sport) ? sport : null}
      kind={kind ?? null}
      slotId={(slotId ?? null) as Id | null}
      variantId={(variantId ?? null) as Id | null}
      routeId={(routeId ?? null) as Id | null}
    />
  );
}
