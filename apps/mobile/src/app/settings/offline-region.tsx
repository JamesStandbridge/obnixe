import { useLocalSearchParams } from "expo-router";
import type { Id } from "@obnixe/schema";
import { OfflineRegionScreen } from "@/features/maps/OfflineRegionScreen";

export default function OfflineRegion() {
  const { session } = useLocalSearchParams<{ session?: string }>();
  return <OfflineRegionScreen sessionId={session === undefined || session === "" ? null : (session as Id)} />;
}
