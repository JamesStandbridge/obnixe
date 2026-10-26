import { router } from "expo-router";
import type { Href } from "expo-router";

export function goBack(fallback: Href): void {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}
