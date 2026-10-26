import { useLocalSearchParams } from "expo-router";
import type { Id } from "@obnixe/schema";
import { ReviewScreen } from "@/features/training/review/ReviewScreen";

export default function SessionReview() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ReviewScreen sessionId={id as Id} />;
}
