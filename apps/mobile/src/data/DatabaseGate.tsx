import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useMigrations } from "drizzle-orm/expo-sqlite/migrator";
import migrations from "@obnixe/schema/migrations";
import { ensureSettings, eraseDatabase, openDatabase } from "@/data/database";
import type { AppDatabase } from "@/data/database";
import { LinkButton } from "@/ui/Button";
import { MenuItem } from "@/ui/Inputs";
import { StartupError } from "@/ui/StartupError";
import { Text } from "@/ui/Text";

interface DatabaseGateProps {
  readonly children: ReactNode;
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

export function DatabaseGate({ children }: DatabaseGateProps) {
  const [generation, setGeneration] = useState(0);
  const [database, setDatabase] = useState<AppDatabase | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    openDatabase().then(setDatabase, (reason: unknown) => setError(asError(reason)));
  }, [generation]);

  const erase = async (): Promise<void> => {
    await eraseDatabase();
    setDatabase(null);
    setError(null);
    setGeneration((value) => value + 1);
  };

  if (error !== null) return <UnreadableDatabase error={error} onErase={erase} />;
  if (database === null) return null;
  return (
    <Migrated key={generation} database={database} onErase={erase}>
      {children}
    </Migrated>
  );
}

interface MigratedProps {
  readonly database: AppDatabase;
  readonly onErase: () => Promise<void>;
  readonly children: ReactNode;
}

function Migrated({ database, onErase, children }: MigratedProps) {
  const { success, error } = useMigrations(database, migrations);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!success) return;
    ensureSettings();
    setReady(true);
  }, [success]);

  if (error !== undefined) return <UnreadableDatabase error={error} onErase={onErase} />;
  return ready ? children : null;
}

interface UnreadableDatabaseProps {
  readonly error: Error;
  readonly onErase: () => Promise<void>;
}

function UnreadableDatabase({ error, onErase }: UnreadableDatabaseProps) {
  const [confirming, setConfirming] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const erase = (): void => {
    setErasing(true);
    onErase().then(
      () => undefined,
      (reason: unknown) => {
        setErasing(false);
        setFailure(asError(reason).message);
      },
    );
  };

  return (
    <StartupError title="Base de données illisible" detail={error.message}>
      {confirming ? (
        <>
          <Text variant="body">
            Séances, programmes, mesures et réglages enregistrés sur cet appareil seront perdus. Si tu as une sauvegarde, importe-la ensuite depuis l'accueil.
          </Text>
          {failure === null ? null : (
            <Text variant="small" tone="secondary" selectable>
              Effacement impossible : {failure}
            </Text>
          )}
          <MenuItem label={erasing ? "Effacement…" : "Effacer définitivement"} destructive onPress={erasing ? () => undefined : erase} />
          <LinkButton label="Garder les données" disabled={erasing} onPress={() => setConfirming(false)} />
        </>
      ) : (
        <LinkButton label="Effacer les données de cet appareil" onPress={() => setConfirming(true)} />
      )}
    </StartupError>
  );
}
