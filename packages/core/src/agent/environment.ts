import type { Id } from "@obnixe/schema";
import type { Environment } from "../database.ts";
import type { AgentPermission } from "./contract.ts";

export interface AgentPermissions {
  readonly canReadBody: boolean;
  readonly canWrite: boolean;
  readonly canReadPhotos: boolean;
  readonly canReadLocation: boolean;
}

/** Reads a stored `.otrk` file from its `recording.track_file` value; `null` when the file is missing or unreadable on this device. */
export type TrackReader = (file: string) => Uint8Array | null;

export interface AgentEnvironment extends Environment {
  readonly timeZone: string;
  readonly permissions: AgentPermissions;
  readonly readTrack: TrackReader;
}

export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

export type ToolResult =
  | { readonly kind: "read"; readonly summary: string; readonly data: Json }
  | { readonly kind: "write"; readonly summary: string; readonly changesetId: Id; readonly data: Json };

export class ToolInputError extends Error {}

export class PermissionDeniedError extends Error {
  readonly permission: AgentPermission;

  constructor(permission: AgentPermission) {
    super(permissionMessages[permission]);
    this.permission = permission;
  }
}

const permissionMessages: Readonly<Record<AgentPermission, string>> = {
  body: "The user has not allowed agents to access body data (weight, measurements), needed to read or record it. Ask them to turn on 'Lire le corps' on the Agent screen of the phone.",
  photos: "The user has not allowed agents to see photos. Ask them to turn on 'Voir les photos' on the Agent screen of the phone.",
  write: "The user has not allowed agents to modify data. Ask them to turn on 'Modifier directement' on the Agent screen of the phone, or describe the change so they can apply it.",
  location: "The user has not allowed agents to read GPS tracks. Ask them to turn on 'Lire les traces' on the Agent screen of the phone; summaries, splits and laps stay available through get_history and get_activity.",
};

export function hasPermission(permissions: AgentPermissions, permission: AgentPermission): boolean {
  switch (permission) {
    case "body":
      return permissions.canReadBody;
    case "photos":
      return permissions.canReadPhotos;
    case "write":
      return permissions.canWrite;
    case "location":
      return permissions.canReadLocation;
    default: {
      const unreachable: never = permission;
      throw new Error(`Unhandled permission ${String(unreachable)}`);
    }
  }
}
