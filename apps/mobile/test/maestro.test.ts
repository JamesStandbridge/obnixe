import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAll } from "js-yaml";
import { describe, expect, it } from "vitest";

interface FlowHeader {
  readonly appId?: unknown;
  readonly name?: unknown;
  readonly tags?: unknown;
}

interface Flow {
  readonly file: string;
  readonly header: FlowHeader;
  readonly commands: readonly unknown[];
}

interface TextSelector {
  readonly command: string;
  readonly text: string;
  readonly optional: boolean;
}

const mobile = fileURLToPath(new URL("..", import.meta.url));
const flowsDirectory = join(mobile, ".maestro");
const appConfig = JSON.parse(readFileSync(join(mobile, "app.json"), "utf8")) as { readonly expo: { readonly android: { readonly package: string }; readonly ios: { readonly bundleIdentifier: string } } };
const requirementIds = new Set((JSON.parse(readFileSync(join(mobile, "..", "..", "scripts", "traceability", "requirements.json"), "utf8")) as readonly { readonly id: string }[]).map((requirement) => requirement.id));
const platformTags: ReadonlySet<string> = new Set(["android", "ios"]);
const commands: ReadonlySet<string> = new Set(["launchApp", "tapOn", "longPressOn", "assertVisible", "assertNotVisible", "extendedWaitUntil", "scrollUntilVisible", "setLocation", "travel", "pressKey", "swipe", "runFlow", "inputText", "hideKeyboard", "waitForAnimationToEnd"]);
const selectorKeys: Readonly<Record<string, string>> = { tapOn: "text", longPressOn: "text", assertVisible: "text", assertNotVisible: "text", scrollUntilVisible: "element", extendedWaitUntil: "visible" };
const regexCharacters = /[.*+?()[\]|\\]/;

function filesUnder(directory: string, accept: (name: string) => boolean): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter(accept)
    .map((file) => join(directory, file));
}

function flowOf(file: string): Flow {
  const documents = loadAll(readFileSync(file, "utf8"));
  expect(documents, file).toHaveLength(2);
  const [header, commandList] = documents;
  expect(Array.isArray(commandList), file).toBe(true);
  return { file, header: header as FlowHeader, commands: commandList as readonly unknown[] };
}

function selectorsOf(flow: Flow): TextSelector[] {
  const selectors: TextSelector[] = [];
  for (const command of flow.commands) {
    if (typeof command !== "object" || command === null) continue;
    for (const [name, argument] of Object.entries(command)) {
      const key = selectorKeys[name];
      if (key === undefined) continue;
      if (typeof argument === "string") {
        selectors.push({ command: name, text: argument, optional: false });
      } else if (typeof argument === "object" && argument !== null) {
        const options = argument as Record<string, unknown>;
        const value = options[key];
        const text = typeof value === "object" && value !== null ? (value as Record<string, unknown>).text : value;
        if (typeof text === "string") selectors.push({ command: name, text, optional: options.optional === true });
      }
    }
  }
  return selectors;
}

const flowFiles = filesUnder(flowsDirectory, (name) => name.endsWith(".yaml"));
const flows = flowFiles.map(flowOf);
const journeys = flows.filter((flow) => !flow.file.includes(`${join(".maestro", "shared")}`));
const appText = [
  ...filesUnder(join(mobile, "src"), (name) => /\.tsx?$/.test(name) && !name.endsWith(".test.ts")),
  ...filesUnder(join(mobile, "modules"), (name) => name.endsWith(".kt") && !name.endsWith("Test.kt")),
  ...filesUnder(join(mobile, "..", "..", "packages", "schema", "src"), (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")),
]
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

describe("Maestro flows (TST-031)", () => {
  it("covers the recording, permission, import, export, pairing, offline map and settings journeys", () => {
    expect(journeys.length).toBeGreaterThanOrEqual(10);
  });

  it("targets the app with a name and known tags", () => {
    for (const flow of flows) {
      expect(flow.header.appId, flow.file).toBe(appConfig.expo.android.package);
      expect(appConfig.expo.ios.bundleIdentifier).toBe(appConfig.expo.android.package);
      expect(typeof flow.header.name === "string" && flow.header.name.length > 0, flow.file).toBe(true);
    }
    for (const flow of journeys) {
      const tags = flow.header.tags;
      expect(Array.isArray(tags) && tags.includes("TST-031"), flow.file).toBe(true);
      for (const tag of tags as readonly unknown[]) expect(typeof tag === "string" && (requirementIds.has(tag) || platformTags.has(tag)), `${flow.file}: ${String(tag)}`).toBe(true);
    }
  });

  it("uses only known commands and existing subflows", () => {
    for (const flow of flows) {
      for (const command of flow.commands) {
        const names = typeof command === "string" ? [command] : Object.keys(command as object);
        expect(names, flow.file).toHaveLength(1);
        const name = names[0] ?? "";
        expect(commands.has(name), `${flow.file}: ${name}`).toBe(true);
        if (name === "runFlow") expect(existsSync(join(dirname(flow.file), String((command as Record<string, unknown>).runFlow))), flow.file).toBe(true);
      }
    }
  });

  it("looks for labels the app actually shows", () => {
    for (const flow of flows) {
      for (const selector of selectorsOf(flow)) {
        if (selector.optional || regexCharacters.test(selector.text)) continue;
        expect(appText.includes(selector.text), `${flow.file}: ${selector.command} "${selector.text}"`).toBe(true);
      }
    }
  });
});
