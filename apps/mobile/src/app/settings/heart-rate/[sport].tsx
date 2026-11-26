import { Redirect, useLocalSearchParams } from "expo-router";
import { HeartRateSourceScreen } from "@/features/recording/HeartRateSourceScreen";
import { isSportKey } from "@/features/recording/settings";

export default function HeartRateSource() {
  const { sport } = useLocalSearchParams<{ sport: string }>();
  return isSportKey(sport) ? <HeartRateSourceScreen key={sport} sport={sport} /> : <Redirect href="/settings" />;
}
