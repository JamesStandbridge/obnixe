import { useLocalSearchParams } from "expo-router";
import { sportKeys } from "@obnixe/schema";
import type { SportKey } from "@obnixe/schema";
import { RecordsScreen } from "@/features/records/RecordsScreen";

function sportParam(value: string | undefined): SportKey | null {
  return sportKeys.find((key) => key === value) ?? null;
}

export default function Records() {
  const { sport } = useLocalSearchParams<{ sport?: string }>();
  return <RecordsScreen initialSport={sportParam(sport)} />;
}
