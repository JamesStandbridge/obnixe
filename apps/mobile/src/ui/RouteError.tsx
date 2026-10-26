import type { ErrorBoundaryProps } from "expo-router";
import { PrimaryButton } from "@/ui/Button";
import { StartupError } from "@/ui/StartupError";

export function RouteError({ error, retry }: ErrorBoundaryProps) {
  return (
    <StartupError title="Cet écran a planté" detail={error.message}>
      <PrimaryButton label="Réessayer" onPress={() => void retry()} />
    </StartupError>
  );
}
