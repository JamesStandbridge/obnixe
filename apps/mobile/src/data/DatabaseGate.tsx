import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useMigrations } from "drizzle-orm/expo-sqlite/migrator";
import migrations from "@obnixe/schema/migrations";
import { ensureSettings, eraseDatabase, openDatabase, setDatabaseAside } from "@/data/database";
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

  const restartAfter =
    (discard: () => Promise<void>) =>
    async (): Promise<void> => {
      await discard();
      setDatabase(null);
      setError(null);
      setGeneration((value) => value + 1);
    };
  const recovery: Recovery = { setAside: restartAfter(setDatabaseAside), erase: restartAfter(eraseDatabase) };

  if (error !== null) return <UnreadableDatabase error={error} recovery={recovery} />;
  if (database === null) return null;
  return (
    <Migrated key={generation} database={database} recovery={recovery}>
      {children}
    </Migrated>
  );
}

interface Recovery {
  readonly setAside: () => Promise<void>;
  readonly erase: () => Promise<void>;
}

interface MigratedProps {
  readonly database: AppDatabase;
  readonly recovery: Recovery;
  readonly children: ReactNode;
}

function Migrated({ database, recovery, children }: MigratedProps) {
  const { success, error } = useMigrations(database, migrations);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!success) return;
    ensureSettings();
    setReady(true);
  }, [success]);

  if (error !== undefined) return <UnreadableDatabase error={error} recovery={recovery} />;
  return ready ? children : null;
}

interface UnreadableDatabaseProps {
  readonly error: Error;
  readonly recovery: Recovery;
}

function UnreadableDatabase({ error, recovery }: UnreadableDatabaseProps) {
  const [confirming, setConfirming] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = (action: () => Promise<void>): void => {
    setErasing(true);
    action().then(
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
            L'app repart de zéro. Une copie de la base illisible reste sur l'appareil, elle n'est plus utilisée. Si tu as une sauvegarde, importe-la ensuite depuis l'accueil.
          </Text>
          {failure === null ? null : (
            <Text variant="small" tone="secondary" selectable>
              Rien n'a été modifié : {failure}
            </Text>
          )}
          <MenuItem label={erasing ? "En cours…" : "Mettre de côté et repartir"} destructive onPress={erasing ? () => undefined : () => run(recovery.setAside)} />
          {failure === null ? null : (
            <MenuItem label="Effacer définitivement, sans copie" destructive onPress={erasing ? () => undefined : () => run(recovery.erase)} />
          )}
          <LinkButton label="Garder les données" disabled={erasing} onPress={() => setConfirming(false)} />
        </>
      ) : (
        <LinkButton label="Repartir de zéro" onPress={() => setConfirming(true)} />
      )}
    </StartupError>
  );
}
