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
      return `Connecté à ${result.device}. ${result.client} peut utiliser Obnixe tant que l'écran Agent reste ouvert.`;
    case "no_phone":
      return "Aucun téléphone en attente. Ouvre l'écran Agent dans Obnixe et vérifie l'adresse du Mac.";
    case "bad_code":
      return result.remaining > 0 ? `Code refusé. Encore ${result.remaining} essai${result.remaining > 1 ? "s" : ""}.` : "Code refusé. Génère un nouveau code sur le téléphone.";
    case "invalid_code":
      return "Le code fait 6 chiffres.";
    case "failed":
      return `Appairage interrompu : ${result.message}`;
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
          write("Indique le code : obnixe-bridge pair 482917");
          return 2;
        }
        code = await prompt.question("Code affiché sur le téléphone : ");
      }
      let result: PairResult;
      try {
        result = await postPairingCode(options.controlPort, code);
      } catch (error) {
        if (error instanceof BridgeUnreachableError) {
          write("Le bridge ne tourne pas. Lance Cursor ou Codex avec le serveur MCP obnixe, puis réessaie.");
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
