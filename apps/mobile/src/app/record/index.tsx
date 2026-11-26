import { useLocalSearchParams } from "expo-router";
import type { Id } from "@obnixe/schema";
import { PrepareScreen } from "@/features/recording/PrepareScreen";
import { isSportKey } from "@/features/recording/settings";

export default function RecordPrepare() {
  const { sport, kind, slotId, variantId } = useLocalSearchParams<{ sport?: string; kind?: string; slotId?: string; variantId?: string }>();
  return <PrepareScreen sport={sport !== undefined && isSportKey(sport) ? sport : null} kind={kind ?? null} slotId={(slotId ?? null) as Id | null} variantId={(variantId ?? null) as Id | null} />;
}
