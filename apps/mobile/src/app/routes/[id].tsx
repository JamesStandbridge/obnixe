import { useLocalSearchParams } from "expo-router";
import type { Id } from "@obnixe/schema";
import { RouteScreen } from "@/features/routes/RouteScreen";

export default function RouteDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <RouteScreen routeId={id as Id} />;
}
