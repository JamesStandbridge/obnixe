import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyToClients, clientConfigPath, findOnPath, launchCommand, parseClientCommand } from "./install.ts";
import type { ClaudeCli, CliResult, InstallContext, LaunchCommand } from "./install.ts";
import { pairingFilePath } from "./pairings.ts";

const launch: LaunchCommand = { command: "/opt/obnixe/obnixe-bridge", args: [] };
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "obnixe-install-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function context(overrides: Partial<InstallContext> = {}): InstallContext {
  return { platform: "darwin", env: {}, home, launch, claude: null, dryRun: false, ...overrides };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

interface FakeCli {
  readonly cli: ClaudeCli;
  readonly calls: (readonly string[])[];
}

function fakeCli(result: (args: readonly string[]) => CliResult): FakeCli {
  const calls: (readonly string[])[] = [];
  return {
    calls,
    cli: {
      path: "/usr/local/bin/claude",
      run: (args) => {
        calls.push(args);
        return result(args);
      },
    },
  };
}

describe("client config locations", () => {
  it("follows each client's convention per platform", () => {
    expect(clientConfigPath("cursor", context())).toBe(join(home, ".cursor", "mcp.json"));
    expect(clientConfigPath("claude-desktop", context())).toBe(join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"));
    expect(clientConfigPath("claude-desktop", { platform: "win32", env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, home: "C:\\Users\\me" })).toBe(
      "C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
    );
    expect(clientConfigPath("claude-desktop", { platform: "linux", env: {}, home: "/home/me" })).toBe("/home/me/.config/Claude/claude_desktop_config.json");
    expect(clientConfigPath("claude-code", { platform: "linux", env: {}, home: "/home/me" })).toBe("/home/me/.claude.json");
  });

  it("keeps the bridge file in %APPDATA% on Windows and in the XDG config home elsewhere, unless overridden", () => {
    expect(pairingFilePath({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32", "C:\\Users\\me")).toBe("C:\\Users\\me\\AppData\\Roaming\\obnixe\\bridge.json");
    expect(pairingFilePath({}, "win32", "C:\\Users\\me")).toBe("C:\\Users\\me\\AppData\\Roaming\\obnixe\\bridge.json");
    expect(pairingFilePath({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/me")).toBe("/xdg/obnixe/bridge.json");
    expect(pairingFilePath({}, "darwin", "/Users/me")).toBe("/Users/me/.config/obnixe/bridge.json");
    expect(pairingFilePath({ OBNIXE_BRIDGE_CONFIG: "/tmp/bridge.json", APPDATA: "C:\\x" }, "win32", "C:\\Users\\me")).toBe("/tmp/bridge.json");
  });
});

describe("install", () => {
  it("creates a missing config file and its directories for an explicit client", () => {
    const report = applyToClients("install", "cursor", context());
    const path = join(home, ".cursor", "mcp.json");
    expect(report).toEqual({ ok: true, lines: [`Cursor: added obnixe in ${path}`] });
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify({ mcpServers: { obnixe: { command: launch.command, args: [] } } }, null, 2)}\n`);
  });

  it("keeps every other key and server and replaces an earlier obnixe entry in place", () => {
    const path = join(home, ".cursor", "mcp.json");
    mkdirSync(join(home, ".cursor"));
    writeFileSync(path, JSON.stringify({ mcpServers: { github: { url: "https://example.test" }, obnixe: { command: "npx" }, linear: { command: "x" } }, theme: "dark" }));
    const report = applyToClients("install", "all", context());
    expect(report.lines).toEqual([`Cursor: replaced obnixe in ${path}`]);
    const written = readJson(path);
    expect(written).toEqual({ mcpServers: { github: { url: "https://example.test" }, obnixe: { command: launch.command, args: [] }, linear: { command: "x" } }, theme: "dark" });
    expect(Object.keys((written as { mcpServers: object }).mcpServers)).toEqual(["github", "obnixe", "linear"]);
  });

  it("treats an empty file as an empty config", () => {
    const path = clientConfigPath("claude-desktop", context());
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "\n");
    expect(applyToClients("install", "claude-desktop", context()).ok).toBe(true);
    expect(readJson(path)).toEqual({ mcpServers: { obnixe: { command: launch.command, args: [] } } });
  });

  it("refuses to overwrite invalid JSON or an unexpected shape and still configures the other clients", () => {
    mkdirSync(join(home, ".cursor"));
    const cursor = join(home, ".cursor", "mcp.json");
    writeFileSync(cursor, "{ \"mcpServers\": { ");
    const desktop = clientConfigPath("claude-desktop", context());
    mkdirSync(join(desktop, ".."), { recursive: true });
    const report = applyToClients("install", "all", context());
    expect(report.ok).toBe(false);
    expect(report.lines[0]).toMatch(new RegExp(`^Cursor: ${cursor.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not valid JSON \\(.+\\); fix or remove it, nothing was written\\.$`));
    expect(report.lines[1]).toBe(`Claude Desktop: added obnixe in ${desktop}`);
    expect(readFileSync(cursor, "utf8")).toBe("{ \"mcpServers\": { ");

    writeFileSync(cursor, JSON.stringify({ mcpServers: [] }));
    expect(applyToClients("install", "cursor", context()).lines).toEqual([`Cursor: mcpServers in ${cursor} is not a JSON object; nothing was written.`]);
    writeFileSync(cursor, "[]");
    expect(applyToClients("install", "cursor", context()).lines).toEqual([`Cursor: ${cursor} does not hold a JSON object; nothing was written.`]);
  });

  it("only configures detected clients with all and reports when there is none", () => {
    expect(applyToClients("install", "all", context())).toEqual({ ok: false, lines: ["No MCP client found (Cursor, Claude Desktop, Claude Code). Pass --client to write its config anyway."] });
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ numStartups: 3, projects: {} }, null, 2));
    const report = applyToClients("install", "all", context());
    expect(report.lines).toEqual([`Claude Code: added obnixe in ${join(home, ".claude.json")}`]);
    expect(readJson(join(home, ".claude.json"))).toEqual({ numStartups: 3, projects: {}, mcpServers: { obnixe: { type: "stdio", command: launch.command, args: [], env: {} } } });
    expect(existsSync(join(home, ".cursor"))).toBe(false);
  });

  it("writes nothing on a dry run", () => {
    const report = applyToClients("install", "cursor", context({ dryRun: true }));
    expect(report.lines).toEqual([`Cursor: would add obnixe in ${join(home, ".cursor", "mcp.json")}: {"command":"/opt/obnixe/obnixe-bridge","args":[]}`]);
    expect(existsSync(join(home, ".cursor"))).toBe(false);
  });

  it("registers Claude Code through its CLI when it is on PATH, replacing an earlier registration", () => {
    const fake = fakeCli(() => ({ status: 0, output: "" }));
    const spaced: LaunchCommand = { command: "/Applications/My Tools/obnixe-bridge", args: [] };
    const report = applyToClients("install", "claude-code", context({ claude: fake.cli, launch: spaced }));
    expect(report.lines).toEqual(['Claude Code: ran claude mcp add --scope user obnixe -- "/Applications/My Tools/obnixe-bridge"']);
    expect(fake.calls).toEqual([
      ["mcp", "remove", "--scope", "user", "obnixe"],
      ["mcp", "add", "--scope", "user", "obnixe", "--", "/Applications/My Tools/obnixe-bridge"],
    ]);
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
  });

  it("reports a failing Claude Code CLI and runs nothing on a dry run", () => {
    const failing = fakeCli((args) => (args[1] === "add" ? { status: 1, output: "permission denied" } : { status: 1, output: "not found" }));
    expect(applyToClients("install", "claude-code", context({ claude: failing.cli }))).toEqual({
      ok: false,
      lines: ["Claude Code: claude mcp add --scope user obnixe -- /opt/obnixe/obnixe-bridge failed: permission denied"],
    });
    const dry = fakeCli(() => ({ status: 0, output: "" }));
    expect(applyToClients("install", "claude-code", context({ claude: dry.cli, dryRun: true })).lines).toEqual([
      "Claude Code: would run claude mcp add --scope user obnixe -- /opt/obnixe/obnixe-bridge",
    ]);
    expect(dry.calls).toEqual([]);
  });
});

describe("uninstall", () => {
  it("removes only the obnixe entry and leaves missing files alone", () => {
    const path = join(home, ".cursor", "mcp.json");
    mkdirSync(join(home, ".cursor"));
    writeFileSync(path, JSON.stringify({ mcpServers: { obnixe: { command: "x" }, github: { url: "https://example.test" } } }));
    expect(applyToClients("uninstall", "cursor", context({ dryRun: true })).lines).toEqual([`Cursor: would remove obnixe from ${path}`]);
    expect(applyToClients("uninstall", "cursor", context()).lines).toEqual([`Cursor: removed obnixe from ${path}`]);
    expect(readJson(path)).toEqual({ mcpServers: { github: { url: "https://example.test" } } });
    expect(applyToClients("uninstall", "cursor", context()).lines).toEqual([`Cursor: no obnixe server in ${path}`]);
    const desktop = clientConfigPath("claude-desktop", context());
    expect(applyToClients("uninstall", "claude-desktop", context())).toEqual({ ok: true, lines: [`Claude Desktop: no obnixe server in ${desktop}`] });
    expect(existsSync(desktop)).toBe(false);
  });

  it("removes the Claude Code registration through its CLI", () => {
    const fake = fakeCli(() => ({ status: 0, output: "" }));
    expect(applyToClients("uninstall", "all", context({ claude: fake.cli })).lines).toEqual(["Claude Code: ran claude mcp remove --scope user obnixe"]);
    expect(fake.calls).toEqual([["mcp", "remove", "--scope", "user", "obnixe"]]);
  });
});

describe("command line", () => {
  it("parses the client and dry run options", () => {
    expect(parseClientCommand([])).toEqual({ kind: "ok", command: { selection: "all", dryRun: false } });
    expect(parseClientCommand(["--client", "claude-code", "--dry-run"])).toEqual({ kind: "ok", command: { selection: "claude-code", dryRun: true } });
    expect(parseClientCommand(["--client=cursor"])).toEqual({ kind: "ok", command: { selection: "cursor", dryRun: false } });
    expect(parseClientCommand(["--client", "vim"])).toEqual({ kind: "invalid", message: "Unknown client vim; use cursor, claude-desktop, claude-code, all." });
    expect(parseClientCommand(["--force"]).kind).toBe("invalid");
    expect(parseClientCommand(["cursor"]).kind).toBe("invalid");
  });

  it("launches a single executable directly and a script through node with its flags", () => {
    expect(launchCommand(true, "/opt/obnixe-bridge", [], "/opt/obnixe-bridge")).toEqual({ command: "/opt/obnixe-bridge", args: [] });
    expect(launchCommand(false, "/usr/bin/node", ["--no-warnings"], "/lib/obnixe/dist/main.mjs")).toEqual({ command: "/usr/bin/node", args: ["--no-warnings", "/lib/obnixe/dist/main.mjs"] });
  });

  it("finds an executable on PATH", () => {
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), "#!/bin/sh\n");
    chmodSync(join(bin, "claude"), 0o755);
    writeFileSync(join(home, "file"), "");
    expect(findOnPath("claude", { PATH: [join(home, "missing"), join(home, "file"), bin].join(":") }, "darwin")).toBe(join(bin, "claude"));
    expect(findOnPath("claude", { PATH: join(home, "missing") }, "darwin")).toBeNull();
    writeFileSync(join(bin, "claude.cmd"), "@echo off\r\n");
    expect(findOnPath("claude", { PATH: bin, PATHEXT: ".EXE;.CMD" }, "linux")).toBe(join(bin, "claude"));
  });
});
