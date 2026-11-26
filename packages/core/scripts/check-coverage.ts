import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

/** `TST-001`: branch coverage of the signal stages; the line threshold of the whole folder is enforced by vitest. */
const stageBranchThreshold = 85;
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const reportPath = new URL("../coverage/coverage-final.json", import.meta.url);

interface Position {
  readonly line: number;
  readonly column: number | null;
}

interface Range {
  readonly start: Position;
  readonly end: Position;
}

interface BranchMapping {
  readonly type: string;
  readonly locations: readonly Range[];
}

interface FileCoverage {
  readonly path: string;
  readonly s: Readonly<Record<string, number>>;
  readonly b: Readonly<Record<string, readonly number[]>>;
  readonly branchMap: Readonly<Record<string, BranchMapping>>;
}

interface BranchCount {
  covered: number;
  total: number;
}

/**
 * `values[index] ?? 0`: the fallback that `noUncheckedIndexedAccess` requires on in-bounds typed array reads. It has
 * no behavior to test, so it is left out of the branch count.
 */
function isIndexFallback(lines: readonly string[], mapping: BranchMapping, alternative: number): boolean {
  const location = mapping.locations[alternative];
  if (mapping.type !== "binary-expr" || alternative === 0 || location === undefined) return false;
  const line = lines[location.start.line - 1] ?? "";
  const column = location.start.column ?? 0;
  return /\]\s*\?\?\s*$/.test(line.slice(0, column)) && /^(-?[0-9.]+|null)\b/.test(line.slice(column));
}

function stageBranches(file: FileCoverage): BranchCount {
  const lines = readFileSync(file.path, "utf8").split("\n");
  const count: BranchCount = { covered: 0, total: 0 };
  for (const [id, hits] of Object.entries(file.b)) {
    const mapping = file.branchMap[id];
    if (mapping === undefined) continue;
    hits.forEach((hit, alternative) => {
      if (isIndexFallback(lines, mapping, alternative)) return;
      count.total += 1;
      if (hit > 0) count.covered += 1;
    });
  }
  return count;
}

const report = JSON.parse(readFileSync(reportPath, "utf8")) as Readonly<Record<string, FileCoverage>>;
const failures: string[] = [];
const stages: BranchCount = { covered: 0, total: 0 };
for (const file of Object.values(report)) {
  const name = relative(packageRoot, file.path);
  const statements = Object.values(file.s);
  if (statements.length > 0 && statements.every((hits) => hits === 0)) failures.push(`${name} is not exercised by any test`);
  if (!name.startsWith("src/tracking/stages/")) continue;
  const count = stageBranches(file);
  stages.covered += count.covered;
  stages.total += count.total;
}
const stagePercent = stages.total === 0 ? 100 : (100 * stages.covered) / stages.total;
console.log(`Stage branches: ${stagePercent.toFixed(2)} % (${stages.covered}/${stages.total}, threshold ${stageBranchThreshold} %)`);
if (stagePercent < stageBranchThreshold) failures.push(`stage branch coverage ${stagePercent.toFixed(2)} % is below ${stageBranchThreshold} %`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`TST-001: ${failure}`);
  process.exit(1);
}
