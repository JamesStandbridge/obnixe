import { createInterface } from "node:readline/promises";
import type { PairResult } from "./phone.ts";

export interface PairCommandOptions {
  readonly controlPort: number;
  readonly code: string | undefined;
  readonly interactive: boolean;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}

export class BridgeUnreachableError extends Error {}

export async function postPairingCode(controlPort: number, code: string): Promise<PairResult> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${controlPort}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
  } catch (error) {
    if (error instanceof TypeError) throw new BridgeUnreachableError(error.message);
    throw error;
  }
  return (await response.json()) as PairResult;
}

function describe(result: PairResult): string {
  switch (result.kind) {
    case "paired":
      return `Connected to ${result.device}. ${result.client} can use Obnixe while the Agent screen stays open; next time the phone reconnects without a code.`;
    case "no_phone":
      return "No phone is waiting. Open the Agent screen in Obnixe and check the Mac address it dials.";
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

export async function runPair(options: PairCommandOptions): Promise<number> {
  const prompt = options.interactive ? createInterface({ input: options.input, output: options.output }) : null;
  const write = (line: string): void => {
    options.output.write(`${line}\n`);
  };
  try {
    let code = options.code;
    for (;;) {
      if (code === undefined) {
        if (prompt === null) {
          write("Pass the code: obnixe-bridge pair 482917");
          return 2;
        }
        code = await prompt.question("Code shown on the phone: ");
      }
      let result: PairResult;
      try {
        result = await postPairingCode(options.controlPort, code);
      } catch (error) {
        if (error instanceof BridgeUnreachableError) {
          write("The bridge is not running. Start Cursor or Codex with the obnixe MCP server, then retry.");
          return 1;
        }
        throw error;
      }
      write(describe(result));
      if (result.kind === "paired") return 0;
      if (!retryable(result) || prompt === null) return 1;
      code = undefined;
    }
  } finally {
    prompt?.close();
  }
}
