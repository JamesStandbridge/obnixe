import { Redirect, useLocalSearchParams } from "expo-router";
import { SensorSourceScreen } from "@/features/recording/SensorSourceScreen";
import { isSportKey } from "@/features/recording/settings";
import { isSensorRole } from "@/features/tracking/sensorDevices";

export default function SensorSource() {
  const { role, sport } = useLocalSearchParams<{ role: string; sport: string }>();
  return isSensorRole(role) && isSportKey(sport) ? <SensorSourceScreen key={`${role}-${sport}`} role={role} sport={sport} /> : <Redirect href="/settings" />;
}
