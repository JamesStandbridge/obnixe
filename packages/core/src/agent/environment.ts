import type { Id } from "@obnixe/schema";
import type { Environment } from "../database.ts";
import type { AgentPermission } from "./contract.ts";

export interface AgentPermissions {
  readonly canReadBody: boolean;
  readonly canWrite: boolean;
  readonly canReadPhotos: boolean;
}

export interface AgentEnvironment extends Environment {
  readonly timeZone: string;
  readonly permissions: AgentPermissions;
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
};

export function hasPermission(permissions: AgentPermissions, permission: AgentPermission): boolean {
  switch (permission) {
    case "body":
      return permissions.canReadBody;
    case "photos":
      return permissions.canReadPhotos;
    case "write":
      return permissions.canWrite;
    default: {
      const unreachable: never = permission;
      throw new Error(`Unhandled permission ${String(unreachable)}`);
    }
  }
}
