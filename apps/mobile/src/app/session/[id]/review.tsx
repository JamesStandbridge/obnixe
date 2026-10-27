import { useLocalSearchParams } from "expo-router";
import type { Id } from "@obnixe/schema";
import { ReviewScreen } from "@/features/training/review/ReviewScreen";

export default function SessionReview() {
  const { id, attach } = useLocalSearchParams<{ id: string; attach?: string }>();
  return <ReviewScreen sessionId={id as Id} offerAttach={attach === "1"} />;
}
