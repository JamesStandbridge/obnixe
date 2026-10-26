import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useMigrations } from "drizzle-orm/expo-sqlite/migrator";
import migrations from "@obnixe/schema/migrations";
import { ensureSettings, expoDb } from "@/data/database";
import { StartupError } from "@/ui/StartupError";

interface DatabaseGateProps {
  readonly children: ReactNode;
}

export function DatabaseGate({ children }: DatabaseGateProps) {
  const { success, error } = useMigrations(expoDb, migrations);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!success) return;
    ensureSettings();
    setReady(true);
  }, [success]);

  if (error !== undefined) return <StartupError title="Base de données illisible" detail={error.message} />;
  return ready ? children : null;
}
