import { useLocalSearchParams } from "expo-router";
import type { Id } from "@obnixe/schema";
import { SessionDetailScreen } from "@/features/training/detail/SessionDetailScreen";

export default function SessionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <SessionDetailScreen sessionId={id as Id} />;
}
