import { Redirect, useLocalSearchParams } from "expo-router";
import { isSportKey } from "@/features/recording/settings";
import { SportSettingsScreen } from "@/features/recording/SportSettingsScreen";

export default function SportRecordingSettings() {
  const { sport } = useLocalSearchParams<{ sport: string }>();
  return isSportKey(sport) ? <SportSettingsScreen key={sport} sport={sport} /> : <Redirect href="/settings" />;
}
