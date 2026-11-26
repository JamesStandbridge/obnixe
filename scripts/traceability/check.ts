import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Level = "MUST" | "MUST NOT" | "SHOULD" | "SHOULD NOT";
type Source = "vitest" | "junit" | "maestro";
type Verification = "field" | "ci" | "gap";

interface Requirement {
  readonly id: string;
  readonly level: Level;
  readonly title: string;
}

interface Exemption {
  readonly verifiedBy: Verification;
  readonly where: string;
}

interface Reference {
  readonly id: string;
  readonly source: Source;
  readonly file: string;
}

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "..", "..");
const requirementsFile = join(here, "requirements.json");
const exemptionsFile = join(here, "exemptions.json");
const checkedLevels: ReadonlySet<string> = new Set<Level>(["MUST", "MUST NOT", "SHOULD", "SHOULD NOT"]);
const requirementPattern = /#req\("([A-Z]+-[0-9]+)", "([A-Z ]+)", "((?:[^"\\]|\\.)*)"(?:, phase: "([^"]+)")?/g;
const idPattern = /\b[A-Z]{2,4}-[0-9]{3}\b/g;
const vitestTitlePattern = /\b(?:describe|it|test)(?:\.each\b[\s\S]*?\))?\(\s*"((?:[^"\\\n]|\\.)*)"/g;
const junitNamePattern = /\bfun `([^`]+)`/g;
const maestroHeaderEnd = /^---$/m;
const flowsDirectory = "apps/mobile/.maestro/";

function sync(sectionsDirectory: string): void {
  const requirements: Requirement[] = [];
  for (const file of readdirSync(sectionsDirectory).filter((name) => name.endsWith(".typ")).sort()) {
    for (const match of readFileSync(join(sectionsDirectory, file), "utf8").matchAll(requirementPattern)) {
      const [, id, level, title, phase] = match;
      if (id === undefined || level === undefined || title === undefined) continue;
      if ((phase ?? "V1") === "V1" && checkedLevels.has(level)) requirements.push({ id, level: level as Level, title: title.replaceAll('\\"', '"') });
    }
  }
  requirements.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  writeFileSync(requirementsFile, `${JSON.stringify(requirements, null, 2)}\n`);
  console.log(`Synced ${requirements.length} V1 requirements from ${sectionsDirectory}`);
}

function versionedFiles(): string[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "apps", "packages"], { cwd: root, encoding: "utf8" }).split("\n").filter((file) => file !== "");
}

function idsIn(text: string): string[] {
  return [...text.matchAll(idPattern)].map((match) => match[0]);
}

function references(): Reference[] {
  const found: Reference[] = [];
  const collect = (file: string, source: Source, texts: Iterable<string>): void => {
    for (const text of texts) for (const id of idsIn(text)) found.push({ id, source, file });
  };
  for (const file of versionedFiles()) {
    const read = (): string => readFileSync(join(root, file), "utf8");
    if (/\.test\.tsx?$/.test(file)) collect(file, "vitest", [...read().matchAll(vitestTitlePattern)].map((match) => match[1] ?? ""));
    else if (file.endsWith("Test.kt")) collect(file, "junit", [...read().matchAll(junitNamePattern)].map((match) => match[1] ?? ""));
    else if (file.startsWith(flowsDirectory) && file.endsWith(".yaml")) collect(file, "maestro", [read().split(maestroHeaderEnd)[0] ?? ""]);
  }
  return found;
}

function check(): boolean {
  const requirements = JSON.parse(readFileSync(requirementsFile, "utf8")) as readonly Requirement[];
  const exemptions = JSON.parse(readFileSync(exemptionsFile, "utf8")) as Readonly<Record<string, Exemption>>;
  const known = new Set(requirements.map((requirement) => requirement.id));
  const bySource = new Map<string, Set<Source>>();
  for (const reference of references()) {
    if (!known.has(reference.id)) continue;
    const sources = bySource.get(reference.id) ?? new Set<Source>();
    sources.add(reference.source);
    bySource.set(reference.id, sources);
  }
  const problems: string[] = [];
  for (const requirement of requirements) {
    const tested = bySource.has(requirement.id);
    const exempted = Object.hasOwn(exemptions, requirement.id);
    if (!tested && !exempted) problems.push(`${requirement.id} (${requirement.level}) "${requirement.title}" is referenced by no test and not exempted`);
    if (tested && exempted) problems.push(`${requirement.id} is exempted but a test references it: remove the exemption`);
  }
  for (const id of Object.keys(exemptions)) if (!known.has(id)) problems.push(`${id} is exempted but is not a V1 MUST or SHOULD requirement`);
  const count = (predicate: (sources: ReadonlySet<Source>) => boolean): number => [...bySource.values()].filter(predicate).length;
  const exemptionCount = (verification: Verification): number => Object.values(exemptions).filter((exemption) => exemption.verifiedBy === verification).length;
  console.log(`Requirements: ${requirements.length} V1 MUST and SHOULD`);
  console.log(`Tested: ${bySource.size} (vitest ${count((sources) => sources.has("vitest"))}, junit ${count((sources) => sources.has("junit"))}, maestro ${count((sources) => sources.has("maestro"))}, maestro only ${count((sources) => sources.size === 1 && sources.has("maestro"))})`);
  console.log(`Exempted: ${exemptionCount("field")} field protocol, ${exemptionCount("ci")} CI gate, ${exemptionCount("gap")} known gap`);
  for (const [id, exemption] of Object.entries(exemptions)) if (exemption.verifiedBy === "gap") console.log(`Known gap: ${id}, ${exemption.where}`);
  for (const problem of problems) console.error(`TST-050: ${problem}`);
  return problems.length === 0;
}

const [mode, sectionsDirectory] = process.argv.slice(2);
if (mode === "--sync") {
  if (sectionsDirectory === undefined) throw new Error("Usage: check.ts --sync <spec sections directory>");
  sync(sectionsDirectory);
} else if (!check()) {
  process.exitCode = 1;
}
