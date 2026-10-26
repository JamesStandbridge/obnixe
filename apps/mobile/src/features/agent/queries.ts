import { useEffect, useRef, useState } from "react";
import type { DependencyList } from "react";
import { addDatabaseChangeListener } from "expo-sqlite";
import { asc, count, desc, eq, isNull } from "drizzle-orm";
import { loadRevertIndex } from "@obnixe/core";
import type { RevertIndex } from "@obnixe/core";
import { agentCall, agentConnection, photo, programVersion, settings } from "@obnixe/schema";
import type { AgentCallKind, AgentConnection, Id } from "@obnixe/schema";
import { db, environment } from "@/data/database";

function useLiveRead<T>(tables: readonly string[], read: () => T, deps: DependencyList): T {
  const [value, setValue] = useState<T>(read);
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    let scheduled = false;
    setValue(readRef.current());
    const listener = addDatabaseChangeListener(({ tableName }) => {
      if (scheduled || !tables.includes(tableName)) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        setValue(readRef.current());
      });
    });
    return () => listener.remove();
  }, deps);
  return value;
}

export interface AgentSettings {
  readonly canReadBody: boolean;
  readonly canWrite: boolean;
  readonly canReadPhotos: boolean;
  readonly bridgeHost: string | null;
}

const noSettings: AgentSettings = { canReadBody: false, canWrite: false, canReadPhotos: false, bridgeHost: null };

export function useAgentSettings(): AgentSettings {
  return useLiveRead(
    ["settings"],
    () =>
      db()
        .select({ canReadBody: settings.agentCanReadBody, canWrite: settings.agentCanWrite, canReadPhotos: settings.agentCanReadPhotos, bridgeHost: settings.bridgeHost })
        .from(settings)
        .get() ?? noSettings,
    [],
  );
}

export type PermissionKey = "agentCanReadBody" | "agentCanWrite" | "agentCanReadPhotos";

export function setPermission(key: PermissionKey, value: boolean): void {
  const patch: Partial<Record<PermissionKey, boolean>> = { [key]: value };
  db()
    .update(settings)
    .set({ ...patch, updatedAt: environment.now() })
    .run();
}

export function saveBridgeHost(host: string | null): void {
  db().update(settings).set({ bridgeHost: host, updatedAt: environment.now() }).run();
}

export function markAgentChangesSeen(): void {
  db().update(settings).set({ agentChangesSeenAt: environment.now(), updatedAt: environment.now() }).run();
}

export interface CallRow {
  readonly id: Id;
  readonly connectionId: Id;
  readonly tool: string;
  readonly kind: AgentCallKind;
  readonly summary: string;
  readonly changesetId: Id | null;
  readonly calledAt: number;
  readonly versionNumber: number | null;
}

function readCalls(connectionId: Id | null): CallRow[] {
  const query = db()
    .select({
      id: agentCall.id,
      connectionId: agentCall.connectionId,
      tool: agentCall.tool,
      kind: agentCall.kind,
      summary: agentCall.summary,
      changesetId: agentCall.changesetId,
      calledAt: agentCall.calledAt,
      versionNumber: programVersion.number,
    })
    .from(agentCall)
    .leftJoin(programVersion, eq(programVersion.changesetId, agentCall.changesetId));
  return (connectionId === null ? query : query.where(eq(agentCall.connectionId, connectionId))).orderBy(asc(agentCall.calledAt)).all();
}

export function useCalls(connectionId: Id | null): readonly CallRow[] {
  return useLiveRead(["agent_call"], () => readCalls(connectionId), [connectionId]);
}

export function useConnections(): readonly AgentConnection[] {
  return useLiveRead(["agent_connection"], () => db().select().from(agentConnection).orderBy(desc(agentConnection.startedAt)).all(), []);
}

export function useConnection(connectionId: Id | null): AgentConnection | null {
  return useLiveRead(
    ["agent_connection"],
    () => (connectionId === null ? null : (db().select().from(agentConnection).where(eq(agentConnection.id, connectionId)).get() ?? null)),
    [connectionId],
  );
}

export function useRevertIndex(): RevertIndex {
  return useLiveRead(["changeset"], () => loadRevertIndex(db()), []);
}

export interface AgentTotals {
  readonly connections: number;
  readonly writes: number;
}

export function useAgentTotals(): AgentTotals {
  return useLiveRead(
    ["agent_connection", "agent_call"],
    () => ({
      connections: db().select({ value: count() }).from(agentConnection).get()?.value ?? 0,
      writes: db().select({ value: count() }).from(agentCall).where(eq(agentCall.kind, "write")).get()?.value ?? 0,
    }),
    [],
  );
}

export function usePhotoCount(): number {
  return useLiveRead(["photo"], () => db().select({ value: count() }).from(photo).where(isNull(photo.deletedAt)).get()?.value ?? 0, []);
}
