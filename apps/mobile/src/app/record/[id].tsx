import { useLocalSearchParams } from "expo-router";
import type { Id } from "@obnixe/schema";
import { RecordScreen } from "@/features/recording/RecordScreen";

export default function Recording() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <RecordScreen key={id} sessionId={id as Id} />;
}
