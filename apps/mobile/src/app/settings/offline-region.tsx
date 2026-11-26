import { useLocalSearchParams } from "expo-router";
import type { Id } from "@obnixe/schema";
import { OfflineRegionScreen } from "@/features/maps/OfflineRegionScreen";
import type { OfflineRegionTarget } from "@/features/maps/OfflineRegionScreen";

function targetOf(session: string | undefined, route: string | undefined): OfflineRegionTarget {
  if (route !== undefined && route !== "") return { kind: "route", routeId: route as Id };
  if (session !== undefined && session !== "") return { kind: "session", sessionId: session as Id };
  return { kind: "visible" };
}

export default function OfflineRegion() {
  const { session, route } = useLocalSearchParams<{ session?: string; route?: string }>();
  return <OfflineRegionScreen target={targetOf(session, route)} />;
}
