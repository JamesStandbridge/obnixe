import { useLocalSearchParams } from "expo-router";
import type { Id } from "@obnixe/schema";
import { SegmentScreen } from "@/features/segments/SegmentScreen";

export default function SegmentDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <SegmentScreen segmentId={id as Id} />;
}
