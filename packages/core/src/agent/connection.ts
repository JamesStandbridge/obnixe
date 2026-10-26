import { and, desc, eq, isNull } from "drizzle-orm";
import { agentCall, agentConnection, settings } from "@obnixe/schema";
import type { ConnectionEndReason, EpochMs, Id } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "../database.ts";
import type { AgentPermissions } from "./environment.ts";

export interface ConnectionPeer {
  readonly client: string;
  readonly host: string;
}

export function readPermissions(db: ObnixeDatabase): AgentPermissions {
  const row = db
    .select({ canReadBody: settings.agentCanReadBody, canWrite: settings.agentCanWrite, canReadPhotos: settings.agentCanReadPhotos })
    .from(settings)
    .get();
  return row ?? { canReadBody: false, canWrite: false, canReadPhotos: false };
}

export function openConnection(db: ObnixeDatabase, env: Environment, peer: ConnectionPeer): Id {
  const id = env.newId();
  const permissions = readPermissions(db);
  db.insert(agentConnection)
    .values({ id, client: peer.client, host: peer.host, ...permissions, startedAt: env.now(), endedAt: null, endReason: null })
    .run();
  return id;
}

export function renameConnectionClient(db: ObnixeDatabase, connectionId: Id, client: string): void {
  db.update(agentConnection).set({ client }).where(eq(agentConnection.id, connectionId)).run();
}

export function closeConnection(db: ObnixeDatabase, env: Environment, connectionId: Id, reason: ConnectionEndReason): void {
  db.update(agentConnection)
    .set({ endedAt: env.now(), endReason: reason })
    .where(and(eq(agentConnection.id, connectionId), isNull(agentConnection.endedAt)))
    .run();
}

export function isConnectionOpen(db: ObnixeDatabase, connectionId: Id): boolean {
  const row = db.select({ endedAt: agentConnection.endedAt }).from(agentConnection).where(eq(agentConnection.id, connectionId)).get();
  return row !== undefined && row.endedAt === null;
}

/** Ends connections left open by a killed app, dated at their last activity. */
export function closeDanglingConnections(db: ObnixeDatabase): void {
  const open = db.select().from(agentConnection).where(isNull(agentConnection.endedAt)).all();
  for (const connection of open) {
    const last = db.select({ calledAt: agentCall.calledAt }).from(agentCall).where(eq(agentCall.connectionId, connection.id)).orderBy(desc(agentCall.calledAt)).get();
    const endedAt: EpochMs = last?.calledAt ?? connection.startedAt;
    db.update(agentConnection).set({ endedAt, endReason: "screen_closed" }).where(eq(agentConnection.id, connection.id)).run();
  }
}
