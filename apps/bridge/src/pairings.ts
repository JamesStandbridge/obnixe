import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { generateIdentity } from "@obnixe/core/agent/wire";
import type { RandomBytes } from "@obnixe/core/agent/wire";

const maxRevoked = 32;

const bridgePairingSchema = z.object({
  pairingId: z.string(),
  deviceId: z.string(),
  device: z.string(),
  secret: z.string(),
  pairedAt: z.int(),
});

const fileSchema = z.object({
  bridgeId: z.string(),
  pairings: z.array(bridgePairingSchema),
  revoked: z.array(z.string()),
});

/** One phone this bridge trusts to reconnect without a code; ids and secret are base64. */
export type BridgePairing = z.infer<typeof bridgePairingSchema>;

type PairingState = z.infer<typeof fileSchema>;

export type PairingLookup = { readonly kind: "known"; readonly pairing: BridgePairing } | { readonly kind: "revoked" } | { readonly kind: "unknown" };

export class PairingFileError extends Error {}

export function pairingFilePath(env: NodeJS.ProcessEnv): string {
  const override = env.OBNIXE_BRIDGE_CONFIG;
  if (override !== undefined && override !== "") return override;
  const configHome = env.XDG_CONFIG_HOME;
  return join(configHome !== undefined && configHome !== "" ? configHome : join(homedir(), ".config"), "obnixe", "bridge.json");
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Bridge identity and trusted pairings, kept in a 0600 JSON file. Every call reads the file again so `obnixe-bridge forget`
 * and a running bridge never disagree.
 */
export class PairingFile {
  readonly path: string;
  private readonly randomBytes: RandomBytes;

  constructor(path: string, randomBytes: RandomBytes) {
    this.path = path;
    this.randomBytes = randomBytes;
  }

  bridgeId(): string {
    return this.load().bridgeId;
  }

  list(): readonly BridgePairing[] {
    return this.load().pairings;
  }

  lookup(pairingId: string): PairingLookup {
    const state = this.load();
    const pairing = state.pairings.find((candidate) => candidate.pairingId === pairingId);
    if (pairing !== undefined) return { kind: "known", pairing };
    return state.revoked.includes(pairingId) ? { kind: "revoked" } : { kind: "unknown" };
  }

  /** Trusts a freshly paired phone; an earlier pairing of the same device is revoked, so its secret no longer resumes. */
  remember(pairing: BridgePairing): void {
    const state = this.load();
    const replaced = state.pairings.filter((candidate) => candidate.deviceId === pairing.deviceId).map((candidate) => candidate.pairingId);
    this.save({
      ...state,
      pairings: [...state.pairings.filter((candidate) => candidate.deviceId !== pairing.deviceId), pairing],
      revoked: [...state.revoked, ...replaced].slice(-maxRevoked),
    });
  }

  revoke(pairingId: string): BridgePairing | null {
    const state = this.load();
    const pairing = state.pairings.find((candidate) => candidate.pairingId === pairingId) ?? null;
    if (pairing === null) return null;
    this.save({ ...state, pairings: state.pairings.filter((candidate) => candidate !== pairing), revoked: [...state.revoked, pairingId].slice(-maxRevoked) });
    return pairing;
  }

  revokeAll(): readonly BridgePairing[] {
    const state = this.load();
    if (state.pairings.length === 0) return [];
    this.save({ ...state, pairings: [], revoked: [...state.revoked, ...state.pairings.map((pairing) => pairing.pairingId)].slice(-maxRevoked) });
    return state.pairings;
  }

  private load(): PairingState {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      const fresh: PairingState = { bridgeId: generateIdentity(this.randomBytes), pairings: [], revoked: [] };
      this.save(fresh);
      return fresh;
    }
    const parsed = fileSchema.safeParse(parseJson(this.path, text));
    if (!parsed.success) throw new PairingFileError(`${this.path} is not a valid Obnixe bridge file: ${parsed.error.message}. Delete it to pair again.`);
    return parsed.data;
  }

  private save(state: PairingState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
  }
}

function parseJson(path: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new PairingFileError(`${path} is not valid JSON: ${error.message}. Delete it to pair again.`);
    throw error;
  }
}
