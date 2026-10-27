import { createInterface } from "node:readline/promises";
import type { InviteResult, InviteState, InviteStatus, InviteTicket, PairResult } from "./phone.ts";
import { terminalQr } from "./qr.ts";

export interface PairCommandOptions {
  readonly controlPort: number;
  readonly code: string | undefined;
  readonly interactive: boolean;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly openPage: ((url: string) => void) | null;
  readonly pollMs?: number;
}

export class BridgeUnreachableError extends Error {}

async function control(controlPort: number, path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`http://127.0.0.1:${controlPort}${path}`, init);
  } catch (error) {
    if (error instanceof TypeError) throw new BridgeUnreachableError(error.message);
    throw error;
  }
}

export async function postPairingCode(controlPort: number, code: string): Promise<PairResult> {
  const response = await control(controlPort, "/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  return (await response.json()) as PairResult;
}

export async function postInvite(controlPort: number, fresh: boolean): Promise<InviteResult> {
  const response = await control(controlPort, "/invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fresh }) });
  return (await response.json()) as InviteResult;
}

export async function getInviteStatus(controlPort: number): Promise<InviteStatus | null> {
  const response = await control(controlPort, "/invite", { method: "GET" });
  return response.status === 404 ? null : ((await response.json()) as InviteStatus);
}

function describe(result: PairResult): string {
  switch (result.kind) {
    case "paired":
      return `Connected to ${result.device}. ${result.client} can use Obnixe while the Agent screen stays open; next time the phone reconnects without a code.`;
    case "no_phone":
      return "No phone is waiting. Open the Agent screen in Obnixe, touch Saisir l'adresse and check the computer address it dials.";
    case "bad_code":
      return result.remaining > 0 ? `Code refused. ${result.remaining} attempt${result.remaining > 1 ? "s" : ""} left.` : "Code refused. Generate a new code on the phone.";
    case "invalid_code":
      return "The code has 6 digits.";
    case "failed":
      return `Pairing interrupted: ${result.message}`;
    default: {
      const unreachable: never = result;
      throw new Error(`Unhandled pair result ${JSON.stringify(unreachable)}`);
    }
  }
}

function retryable(result: PairResult): boolean {
  return result.kind === "invalid_code" || (result.kind === "bad_code" && result.remaining > 0);
}

/** Final line for an invitation that is no longer waiting, or null while the phone may still scan it. */
function describeInvite(state: InviteState): string | null {
  switch (state.kind) {
    case "waiting":
      return null;
    case "paired":
      return `Connected to ${state.device}. ${state.client} can use Obnixe while the Agent screen stays open; next time the phone reconnects by itself.`;
    case "expired":
      return "The QR code expired. Run `obnixe-bridge pair` again for a new one.";
    case "failed":
      return `Pairing interrupted: ${state.message}`;
    default: {
      const unreachable: never = state;
      throw new Error(`Unhandled invite state ${JSON.stringify(unreachable)}`);
    }
  }
}

async function waitForInvite(options: PairCommandOptions, ticket: InviteTicket): Promise<string> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1000));
    const status = await getInviteStatus(options.controlPort);
    if (status === null || status.id !== ticket.id) return "Another QR code replaced this one; scan the newest.";
    const line = describeInvite(status.state);
    if (line !== null) return line;
  }
}

async function runInvite(options: PairCommandOptions, write: (line: string) => void): Promise<number> {
  const result = await postInvite(options.controlPort, true);
  switch (result.kind) {
    case "no_address":
      write("This computer has no private network address the phone can dial (Wi-Fi, Ethernet or Tailscale). Join the phone's network, or set OBNIXE_PHONE_HOST to an IPv4 address.");
      return 1;
    case "ready":
      break;
    default: {
      const unreachable: never = result;
      throw new Error(`Unhandled invite result ${JSON.stringify(unreachable)}`);
    }
  }
  const { ticket } = result;
  const page = `http://127.0.0.1:${options.controlPort}/pair`;
  write(terminalQr(ticket.url));
  write("");
  write("On the phone: Obnixe, Aujourd'hui, Connecter un agent, Scanner le QR code.");
  write(`Valid 5 minutes, once. Larger version: ${page}`);
  write(`The phone will dial ${ticket.hosts.join(", ")}.`);
  write(`Link, opens Obnixe when sent to the phone: ${ticket.url}`);
  write("No camera? Touch Saisir l'adresse on the phone, then run `obnixe-bridge pair <code>` with the code it shows.");
  options.openPage?.(page);
  const line = await waitForInvite(options, ticket);
  write(line);
  return line.startsWith("Connected to ") ? 0 : 1;
}

/** Without a code, shows a QR code and waits for the phone to scan it; with a code, pairs the phone that displays it. */
export async function runPair(options: PairCommandOptions): Promise<number> {
  const write = (line: string): void => {
    options.output.write(`${line}\n`);
  };
  const unreachable = (): number => {
    write("The bridge is not running. Start your MCP client (Cursor, Claude or another) with the obnixe server, then retry.");
    return 1;
  };
  if (options.code === undefined) {
    try {
      return await runInvite(options, write);
    } catch (error) {
      if (error instanceof BridgeUnreachableError) return unreachable();
      throw error;
    }
  }
  const prompt = options.interactive ? createInterface({ input: options.input, output: options.output }) : null;
  try {
    let code = options.code;
    for (;;) {
      let result: PairResult;
      try {
        result = await postPairingCode(options.controlPort, code);
      } catch (error) {
        if (error instanceof BridgeUnreachableError) return unreachable();
        throw error;
      }
      write(describe(result));
      if (result.kind === "paired") return 0;
      if (!retryable(result) || prompt === null) return 1;
      code = await prompt.question("Code shown on the phone: ");
    }
  } finally {
    prompt?.close();
  }
}
