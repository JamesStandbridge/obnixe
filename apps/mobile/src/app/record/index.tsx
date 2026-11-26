import { useLocalSearchParams } from "expo-router";
import { sportKeys } from "@obnixe/schema";
import type { Id, SportKey } from "@obnixe/schema";
import { PrepareScreen } from "@/features/recording/PrepareScreen";

function isSportKey(value: string): value is SportKey {
  return (sportKeys as readonly string[]).includes(value);
}

export default function RecordPrepare() {
  const { sport, kind, slotId, variantId } = useLocalSearchParams<{ sport?: string; kind?: string; slotId?: string; variantId?: string }>();
  return <PrepareScreen sport={sport !== undefined && isSportKey(sport) ? sport : null} kind={kind ?? null} slotId={(slotId ?? null) as Id | null} variantId={(variantId ?? null) as Id | null} />;
}
