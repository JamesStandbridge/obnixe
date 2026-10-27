import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const assets = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

const defaultChrome = {
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  linux: "google-chrome",
  win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
};

const chrome = process.env.CHROME_PATH ?? defaultChrome[process.platform];
if (!chrome) throw new Error(`Set CHROME_PATH: no default Chrome location for ${process.platform}`);

/** @type {ReadonlyArray<{ source: string; output: string; size: number; transparent: boolean }>} */
const targets = [
  { source: "icon.svg", output: "icon.png", size: 1024, transparent: false },
  { source: "android-icon-foreground.svg", output: "android-icon-foreground.png", size: 1024, transparent: true },
  { source: "android-icon-background.svg", output: "android-icon-background.png", size: 1024, transparent: false },
  { source: "android-icon-monochrome.svg", output: "android-icon-monochrome.png", size: 1024, transparent: true },
  { source: "splash-icon.svg", output: "splash-icon.png", size: 1024, transparent: true },
  { source: "favicon.svg", output: "favicon.png", size: 48, transparent: false },
];

const PNG_COLOR_RGB = 2;
const PNG_COLOR_RGBA = 6;

const work = mkdtempSync(join(tmpdir(), "obnixe-icons-"));
try {
  for (const target of targets) {
    const svg = readFileSync(join(assets, "source", target.source));
    const page = join(work, `${target.output}.html`);
    const output = join(assets, target.output);
    writeFileSync(
      page,
      `<!doctype html><html><body style="margin:0"><img src="data:image/svg+xml;base64,${svg.toString("base64")}" width="${target.size}" height="${target.size}" style="display:block"></body></html>`,
    );
    execFileSync(
      chrome,
      [
        "--headless",
        "--hide-scrollbars",
        ...(target.transparent ? ["--default-background-color=00000000"] : []),
        `--window-size=${target.size},${target.size}`,
        `--screenshot=${output}`,
        `file://${page}`,
      ],
      { stdio: "ignore" },
    );

    const png = readFileSync(output);
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const colorType = png.readUInt8(25);
    const expectedColorType = target.transparent ? PNG_COLOR_RGBA : PNG_COLOR_RGB;
    if (width !== target.size || height !== target.size || colorType !== expectedColorType) {
      throw new Error(`${target.output}: got ${width}x${height} color type ${colorType}, expected ${target.size}x${target.size} color type ${expectedColorType}`);
    }
    console.log(`${target.output} ${width}x${height}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
