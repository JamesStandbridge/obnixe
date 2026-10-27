export const relayVersion = 1;

export type Role = "bridge" | "phone";

export type Refusal = "occupied" | "rooms" | "busy" | "version";

export type ClientMessage =
  | { readonly type: "join"; readonly v: number; readonly role: Role; readonly room: string }
  | { readonly type: "leave"; readonly room: string }
  | { readonly type: "frame"; readonly room: string; readonly data: string }
  | { readonly type: "close"; readonly room: string };

export type BridgeNotice =
  | { readonly type: "joined"; readonly room: string }
  | { readonly type: "refused"; readonly room: string; readonly reason: Refusal }
  | { readonly type: "peer"; readonly room: string }
  | { readonly type: "frame"; readonly room: string; readonly data: string }
  | { readonly type: "peer_left"; readonly room: string };

export type PhoneNotice = { readonly type: "peer" } | { readonly type: "refused"; readonly reason: Refusal } | { readonly type: "peer_left" };

const roomPattern = /^[A-Za-z0-9_-]{43}$/;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roomOf(value: Readonly<Record<string, unknown>>): string | null {
  const room = value.room;
  return typeof room === "string" && roomPattern.test(room) ? room : null;
}

/** Parses a control message from a client, or returns null when it is not one; payloads are never inspected beyond their type. */
export function parseClientMessage(text: string): ClientMessage | null {
  const value = parseJson(text);
  if (!isRecord(value)) return null;
  const room = roomOf(value);
  if (room === null) return null;
  switch (value.type) {
    case "join": {
      const { v, role } = value;
      if (typeof v !== "number" || !Number.isInteger(v) || (role !== "bridge" && role !== "phone")) return null;
      return { type: "join", v, role, room };
    }
    case "leave":
      return { type: "leave", room };
    case "close":
      return { type: "close", room };
    case "frame":
      return typeof value.data === "string" ? { type: "frame", room, data: value.data } : null;
    default:
      return null;
  }
}
