import { readFileSync, writeFileSync } from "node:fs";
import { catalogSignature, signatureBreaks } from "../src/catalog/signature.ts";
import type { CatalogSnapshot } from "../src/catalog/signature.ts";
import { catalogVersion } from "../src/catalog/sports.ts";

const path = new URL("../catalog.snapshot.json", import.meta.url);
const previous = JSON.parse(readFileSync(path, "utf8")) as CatalogSnapshot;
const current = catalogSignature();
const breaks = signatureBreaks(previous.paths, current);
if (breaks.length > 0) throw new Error(`Catalog keys must be retired, not removed or changed:\n${breaks.join("\n")}`);
const added = Object.keys(current).filter((key) => !(key in previous.paths));
if (added.length > 0 && catalogVersion <= previous.version) throw new Error(`New catalog keys require bumping catalogVersion above ${previous.version}:\n${added.join("\n")}`);
const paths = Object.fromEntries(Object.entries({ ...previous.paths, ...current }).sort(([left], [right]) => left.localeCompare(right)));
const snapshot: CatalogSnapshot = { version: catalogVersion, paths };
writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
