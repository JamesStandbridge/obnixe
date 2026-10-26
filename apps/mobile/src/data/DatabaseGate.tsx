import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useMigrations } from "drizzle-orm/expo-sqlite/migrator";
import migrations from "@obnixe/schema/migrations";
import { ensureSettings, openDatabase } from "@/data/database";
import type { AppDatabase } from "@/data/database";
import { StartupError } from "@/ui/StartupError";

interface DatabaseGateProps {
  readonly children: ReactNode;
}

export function DatabaseGate({ children }: DatabaseGateProps) {
  const [database, setDatabase] = useState<AppDatabase | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    openDatabase().then(setDatabase, (reason: unknown) => {
      setError(reason instanceof Error ? reason : new Error(String(reason)));
    });
  }, []);

  if (error !== null) return <StartupError title="Base de données illisible" detail={error.message} />;
  if (database === null) return null;
  return <Migrated database={database}>{children}</Migrated>;
}

interface MigratedProps {
  readonly database: AppDatabase;
  readonly children: ReactNode;
}

function Migrated({ database, children }: MigratedProps) {
  const { success, error } = useMigrations(database, migrations);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!success) return;
    ensureSettings();
    setReady(true);
  }, [success]);

  if (error !== undefined) return <StartupError title="Base de données illisible" detail={error.message} />;
  return ready ? children : null;
}
