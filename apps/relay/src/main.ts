import { RelayServer } from "./server.ts";

function integer(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer between ${min} and ${max}, got ${value}`);
  return parsed;
}

function log(line: string): void {
  process.stdout.write(`[obnixe-relay] ${line}\n`);
}

const port = integer("PORT", 8080, 0, 65_535);
const proxyHops = integer("TRUST_PROXY", 0, 0, 16);
const host = process.env.HOST;
const server = new RelayServer({ port, proxyHops, log, ...(host !== undefined && host !== "" ? { host } : {}) });
const bound = await server.listen();
log(`Listening on port ${bound}${proxyHops > 0 ? `, trusting ${proxyHops} proxy hop${proxyHops > 1 ? "s" : ""} for client addresses` : ""}.`);

let stopping = false;
function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  log(`${signal} received, closing connections.`);
  void server.close().then(() => process.exit(0));
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
