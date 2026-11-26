import type { RefObject } from "react";
import type { HostInstance } from "react-native";
import { shareFile } from "@/features/data/files";

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

function unquoted(family: string): string {
  const trimmed = family.trim();
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function dataUrlOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Font unreadable"));
    reader.readAsDataURL(blob);
  });
}

function fontFaces(): readonly CSSFontFaceRule[] {
  const faces: CSSFontFaceRule[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch (error) {
      if (error instanceof DOMException) continue;
      throw error;
    }
    for (const rule of Array.from(rules)) if (rule instanceof CSSFontFaceRule) faces.push(rule);
  }
  return faces;
}

/** An SVG drawn as an image reaches no page font: the faces it uses are inlined as data URLs. */
async function embeddedFonts(families: ReadonlySet<string>): Promise<string> {
  const declarations: string[] = [];
  for (const face of fontFaces()) {
    const family = unquoted(face.style.getPropertyValue("font-family"));
    const source = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(face.style.getPropertyValue("src"))?.[1];
    if (!families.has(family) || source === undefined) continue;
    const response = await fetch(source);
    if (!response.ok) continue;
    declarations.push(`@font-face{font-family:${JSON.stringify(family)};src:url(${JSON.stringify(await dataUrlOf(await response.blob()))})}`);
  }
  return declarations.join("");
}

async function standalone(svg: SVGSVGElement, size: ImageSize): Promise<string> {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", String(size.width));
  copy.setAttribute("height", String(size.height));
  const families = new Set<string>();
  for (const element of Array.from(copy.querySelectorAll<SVGElement>("*"))) {
    const family = element.style.fontFamily;
    if (family === "") continue;
    families.add(unquoted(family));
    element.style.fontFamily = `${family}, sans-serif`;
  }
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = await embeddedFonts(families);
  copy.insertBefore(style, copy.firstChild);
  return new XMLSerializer().serializeToString(copy);
}

/** Rasterizes the card's SVG at `size` pixels and downloads it as a PNG (`SUM-006`). */
export async function shareCardImage(card: RefObject<HostInstance | null>, size: ImageSize, name: string): Promise<void> {
  const svg = (card.current as unknown as HTMLElement | null)?.querySelector("svg") ?? null;
  if (svg === null) throw new Error("The share card has no drawing");
  const url = URL.createObjectURL(new Blob([await standalone(svg, size)], { type: "image/svg+xml" }));
  try {
    const image = new Image(size.width, size.height);
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("No 2D canvas");
    context.drawImage(image, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (blob === null) throw new Error("The canvas gave no PNG");
    await shareFile({ name, bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: "image/png" });
  } finally {
    URL.revokeObjectURL(url);
  }
}
