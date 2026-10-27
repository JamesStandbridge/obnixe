import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { platformPath, userConfigDir } from "./paths.ts";

export const serverName = "obnixe";

export type ClientId = "cursor" | "claude-desktop" | "claude-code";

export const clientIds: readonly ClientId[] = ["cursor", "claude-desktop", "claude-code"];

export type ClientSelection = ClientId | "all";

export type ConfigAction = "install" | "uninstall";

/** How an MCP client starts this bridge. */
export interface LaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface CliResult {
  readonly status: number | null;
  readonly output: string;
}

/** The `claude` CLI found on PATH. */
export interface ClaudeCli {
  readonly path: string;
  readonly run: (args: readonly string[]) => CliResult;
}

export interface InstallContext {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly launch: LaunchCommand;
  readonly claude: ClaudeCli | null;
  readonly dryRun: boolean;
}

export interface InstallReport {
  readonly lines: readonly string[];
  readonly ok: boolean;
}

export interface ClientCommand {
  readonly selection: ClientSelection;
  readonly dryRun: boolean;
}

export type ParsedClientCommand = { readonly kind: "ok"; readonly command: ClientCommand } | { readonly kind: "invalid"; readonly message: string };

export type JsonObject = Record<string, unknown>;

export class ClientConfigError extends Error {}

function errorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isClientSelection(value: string): value is ClientSelection {
  return value === "all" || clientIds.some((client) => client === value);
}

export function parseClientCommand(args: readonly string[]): ParsedClientCommand {
  let values: { readonly client?: string | undefined; readonly "dry-run"?: boolean | undefined };
  try {
    values = parseArgs({ args: [...args], options: { client: { type: "string" }, "dry-run": { type: "boolean" } }, strict: true, allowPositionals: false }).values;
  } catch (error) {
    const code = errorCode(error);
    if (code === null || !code.startsWith("ERR_PARSE_ARGS_")) throw error;
    return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
  }
  const client = values.client ?? "all";
  if (!isClientSelection(client)) return { kind: "invalid", message: `Unknown client ${client}; use ${[...clientIds, "all"].join(", ")}.` };
  return { kind: "ok", command: { selection: client, dryRun: values["dry-run"] ?? false } };
}

/** A single executable starts itself; a script run by node needs node, its flags and the script path. */
export function launchCommand(sea: boolean, execPath: string, execArgv: readonly string[], script: string | undefined): LaunchCommand {
  if (sea) return { command: execPath, args: [] };
  if (script === undefined) throw new Error("Cannot tell which script runs the bridge.");
  return { command: execPath, args: [...execArgv, script] };
}

export function clientTitle(client: ClientId): string {
  switch (client) {
    case "cursor":
      return "Cursor";
    case "claude-desktop":
      return "Claude Desktop";
    case "claude-code":
      return "Claude Code";
    default: {
      const unreachable: never = client;
      throw new Error(`Unhandled client ${String(unreachable)}`);
    }
  }
}

export function clientConfigPath(client: ClientId, context: Pick<InstallContext, "platform" | "env" | "home">): string {
  const path = platformPath(context.platform);
  switch (client) {
    case "cursor":
      return path.join(context.home, ".cursor", "mcp.json");
    case "claude-desktop":
      return context.platform === "darwin"
        ? path.join(context.home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : path.join(userConfigDir(context.platform, context.env, context.home), "Claude", "claude_desktop_config.json");
    case "claude-code":
      return path.join(context.home, ".claude.json");
    default: {
      const unreachable: never = client;
      throw new Error(`Unhandled client ${String(unreachable)}`);
    }
  }
}

function isDetected(client: ClientId, context: InstallContext): boolean {
  switch (client) {
    case "cursor":
      return existsSync(platformPath(context.platform).join(context.home, ".cursor"));
    case "claude-desktop":
      return existsSync(platformPath(context.platform).dirname(clientConfigPath(client, context)));
    case "claude-code":
      return context.claude !== null || existsSync(clientConfigPath(client, context));
    default: {
      const unreachable: never = client;
      throw new Error(`Unhandled client ${String(unreachable)}`);
    }
  }
}

export function serverEntry(client: ClientId, launch: LaunchCommand): JsonObject {
  switch (client) {
    case "cursor":
    case "claude-desktop":
      return { command: launch.command, args: [...launch.args] };
    case "claude-code":
      return { type: "stdio", command: launch.command, args: [...launch.args], env: {} };
    default: {
      const unreachable: never = client;
      throw new Error(`Unhandled client ${String(unreachable)}`);
    }
  }
}

/** The parsed config file, an empty object for an empty file, or null when the file does not exist. */
export function readConfig(path: string): JsonObject | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ClientConfigError(`${path} is not valid JSON (${error.message}); fix or remove it, nothing was written.`);
    throw error;
  }
  if (!isJsonObject(parsed)) throw new ClientConfigError(`${path} does not hold a JSON object; nothing was written.`);
  return parsed;
}

function mcpServers(config: JsonObject, path: string): JsonObject {
  const servers = config.mcpServers;
  if (servers === undefined) return {};
  if (!isJsonObject(servers)) throw new ClientConfigError(`mcpServers in ${path} is not a JSON object; nothing was written.`);
  return servers;
}

export function hasServer(config: JsonObject, path: string): boolean {
  return Object.hasOwn(mcpServers(config, path), serverName);
}

export function withServer(config: JsonObject, path: string, entry: JsonObject): JsonObject {
  return { ...config, mcpServers: { ...mcpServers(config, path), [serverName]: entry } };
}

export function withoutServer(config: JsonObject, path: string): JsonObject {
  return { ...config, mcpServers: Object.fromEntries(Object.entries(mcpServers(config, path)).filter(([name]) => name !== serverName)) };
}

export function writeConfig(path: string, config: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** Words joined for display, quoting those a shell would split or expand. */
export function commandLine(words: readonly string[]): string {
  return words.map((word) => (/^[\w@%+=:,./\\-]+$/.test(word) ? word : `"${word}"`)).join(" ");
}

function claudeLine(args: readonly string[]): string {
  return commandLine(["claude", ...args]);
}

function installFile(client: ClientId, context: InstallContext): string {
  const title = clientTitle(client);
  const path = clientConfigPath(client, context);
  const config = readConfig(path) ?? {};
  const replacing = hasServer(config, path);
  const entry = serverEntry(client, context.launch);
  const next = withServer(config, path, entry);
  if (context.dryRun) return `${title}: would ${replacing ? "replace" : "add"} ${serverName} in ${path}: ${JSON.stringify(entry)}`;
  writeConfig(path, next);
  return `${title}: ${replacing ? "replaced" : "added"} ${serverName} in ${path}`;
}

function uninstallFile(client: ClientId, context: InstallContext): string {
  const title = clientTitle(client);
  const path = clientConfigPath(client, context);
  const config = readConfig(path);
  if (config === null || !hasServer(config, path)) return `${title}: no ${serverName} server in ${path}`;
  if (context.dryRun) return `${title}: would remove ${serverName} from ${path}`;
  writeConfig(path, withoutServer(config, path));
  return `${title}: removed ${serverName} from ${path}`;
}

function installCli(cli: ClaudeCli, context: InstallContext): string {
  const add = ["mcp", "add", "--scope", "user", serverName, "--", context.launch.command, ...context.launch.args];
  if (context.dryRun) return `Claude Code: would run ${claudeLine(add)}`;
  cli.run(["mcp", "remove", "--scope", "user", serverName]);
  const result = cli.run(add);
  if (result.status !== 0) throw new ClientConfigError(`${claudeLine(add)} failed: ${result.output}`);
  return `Claude Code: ran ${claudeLine(add)}`;
}

function uninstallCli(cli: ClaudeCli, context: InstallContext): string {
  const remove = ["mcp", "remove", "--scope", "user", serverName];
  if (context.dryRun) return `Claude Code: would run ${claudeLine(remove)}`;
  const result = cli.run(remove);
  return result.status === 0 ? `Claude Code: ran ${claudeLine(remove)}` : `Claude Code: nothing removed (${result.output})`;
}

function applyToClient(action: ConfigAction, client: ClientId, context: InstallContext): string {
  const cli = client === "claude-code" ? context.claude : null;
  switch (action) {
    case "install":
      return cli === null ? installFile(client, context) : installCli(cli, context);
    case "uninstall":
      return cli === null ? uninstallFile(client, context) : uninstallCli(cli, context);
    default: {
      const unreachable: never = action;
      throw new Error(`Unhandled action ${String(unreachable)}`);
    }
  }
}

/** Adds or removes the obnixe server in each selected client; "all" only touches clients found on this computer. */
export function applyToClients(action: ConfigAction, selection: ClientSelection, context: InstallContext): InstallReport {
  const clients = selection === "all" ? clientIds.filter((client) => isDetected(client, context)) : [selection];
  if (clients.length === 0) {
    return { lines: ["No MCP client found (Cursor, Claude Desktop, Claude Code). Pass --client to write its config anyway."], ok: false };
  }
  const lines: string[] = [];
  let ok = true;
  for (const client of clients) {
    try {
      lines.push(applyToClient(action, client, context));
    } catch (error) {
      if (!(error instanceof ClientConfigError)) throw error;
      lines.push(`${clientTitle(client)}: ${error.message}`);
      ok = false;
    }
  }
  return { lines, ok };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") return false;
    throw error;
  }
}

export function findOnPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const path = platformPath(platform);
  const directories = (env.PATH ?? "").split(path.delimiter).filter((directory) => directory !== "");
  const extensions = platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((extension) => extension !== "") : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

export function systemClaudeCli(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ClaudeCli | null {
  const found = findOnPath("claude", env, platform);
  if (found === null) return null;
  // Windows only runs .cmd and .bat files through a shell, which needs every word quoted.
  const viaShell = platform === "win32" && /\.(cmd|bat)$/i.test(found);
  const quote = (word: string): string => `"${word}"`;
  return {
    path: found,
    run: (args) => {
      const result = viaShell
        ? spawnSync(quote(found), args.map(quote), { encoding: "utf8", env, shell: true })
        : spawnSync(found, [...args], { encoding: "utf8", env });
      if (result.error !== undefined) throw result.error;
      return { status: result.status, output: `${result.stdout}${result.stderr}`.trim() };
    },
  };
}
