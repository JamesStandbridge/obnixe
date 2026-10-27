import { BridgeUnreachableError } from "./pair.ts";
import type { PairingFile } from "./pairings.ts";
import type { ForgetResult } from "./phone.ts";

export interface ForgetCommandOptions {
  readonly controlPort: number;
  readonly pairings: PairingFile;
  readonly output: NodeJS.WritableStream;
}

export async function postForget(controlPort: number): Promise<ForgetResult> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${controlPort}/forget`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  } catch (error) {
    if (error instanceof TypeError) throw new BridgeUnreachableError(error.message);
    throw error;
  }
  return (await response.json()) as ForgetResult;
}

/** Revokes every trusted phone through the running bridge, or directly in the pairing file when no bridge runs. */
export async function runForget(options: ForgetCommandOptions): Promise<number> {
  let devices: readonly string[];
  try {
    devices = (await postForget(options.controlPort)).devices;
  } catch (error) {
    if (!(error instanceof BridgeUnreachableError)) throw error;
    devices = options.pairings.revokeAll().map((pairing) => pairing.device);
  }
  const line = devices.length === 0 ? "No phone is paired with this computer." : `Forgot ${devices.join(", ")}. The phone will ask for a new code.`;
  options.output.write(`${line}\n`);
  return 0;
}
