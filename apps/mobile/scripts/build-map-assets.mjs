import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import opentype from "opentype.js";

/*
 * Generates the embedded map resources (DEC-12): SDF glyph ranges of the app's OFL fonts and the SDF icon sprite.
 * Output goes to public/maps, served as is on the web and copied into the native bundles by plugins/withObnixeMaps.js.
 */

const require = createRequire(import.meta.url);
const output = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "maps");

/** MapLibre's SDF contract: 24 px em, 3 px border, edge at 192/255, 8 px of distance across the ramp. */
const glyphSize = 24;
const glyphBorder = 3;
const sdfRadius = 8;
const sdfCutoff = 0.25;
/** Distance from the glyph origin to the baseline, as in the glyphs served by MapLibre font servers. */
const baselineOrigin = 26;

/** @type {ReadonlyArray<{ stack: string; file: string }>} */
const fonts = [
  { stack: "SofiaSans-Medium", file: "@expo-google-fonts/sofia-sans/500Medium/SofiaSans_500Medium.ttf" },
  { stack: "SofiaSans-Bold", file: "@expo-google-fonts/sofia-sans/700Bold/SofiaSans_700Bold.ttf" },
  { stack: "SofiaSans-MediumItalic", file: "@expo-google-fonts/sofia-sans/500Medium_Italic/SofiaSans_500Medium_Italic.ttf" },
  { stack: "SofiaSansCondensed-SemiBold", file: "@expo-google-fonts/sofia-sans-condensed/600SemiBold/SofiaSansCondensed_600SemiBold.ttf" },
  { stack: "Outfit-SemiBold", file: "@expo-google-fonts/outfit/600SemiBold/Outfit_600SemiBold.ttf" },
];

/** Latin, Greek, Cyrillic and punctuation: labels read `name:latin` before `name`, so other scripts are not embedded. */
const ranges = [0, 256, 512, 768, 1024, 1280, 7680, 7936, 8192, 8448, 8704];

function sdfValue(distance) {
  return Math.max(0, Math.min(255, Math.round(255 - 255 * (distance / sdfRadius + sdfCutoff))));
}

/** Flattens path commands (absolute M, L, Q, C, Z) into closed polylines. */
function flatten(commands) {
  const rings = [];
  let ring = [];
  let x = 0;
  let y = 0;
  for (const command of commands) {
    switch (command.type) {
      case "M":
        if (ring.length > 1) rings.push(ring);
        ring = [[command.x, command.y]];
        break;
      case "L":
        ring.push([command.x, command.y]);
        break;
      case "Q":
        for (let step = 1; step <= 8; step += 1) {
          const t = step / 8;
          const u = 1 - t;
          ring.push([u * u * x + 2 * u * t * command.x1 + t * t * command.x, u * u * y + 2 * u * t * command.y1 + t * t * command.y]);
        }
        break;
      case "C":
        for (let step = 1; step <= 12; step += 1) {
          const t = step / 12;
          const u = 1 - t;
          ring.push([
            u * u * u * x + 3 * u * u * t * command.x1 + 3 * u * t * t * command.x2 + t * t * t * command.x,
            u * u * u * y + 3 * u * u * t * command.y1 + 3 * u * t * t * command.y2 + t * t * t * command.y,
          ]);
        }
        break;
      case "Z":
        if (ring.length > 1) rings.push(ring);
        ring = [];
        break;
      default:
        throw new Error(`Unsupported path command ${command.type}`);
    }
    if (command.type !== "Z") {
      x = command.x;
      y = command.y;
    }
  }
  if (ring.length > 1) rings.push(ring);
  return rings.map((points) => {
    const [first] = points;
    const last = points[points.length - 1];
    return first[0] === last[0] && first[1] === last[1] ? points.slice(0, -1) : points;
  });
}

/**
 * Exact signed distance field of polygons, in y-down pixel space.
 * `scale` maps polygon units to field pixels; distances are measured in polygon units.
 */
function distanceField(rings, originX, originY, width, height, scale, fill) {
  const segments = [];
  for (const ring of rings) {
    for (let index = 0; index < ring.length; index += 1) {
      const a = ring[index];
      const b = ring[(index + 1) % ring.length];
      segments.push([a[0], a[1], b[0], b[1]]);
    }
  }
  const field = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const py = originY + (row + 0.5) / scale;
    for (let column = 0; column < width; column += 1) {
      const px = originX + (column + 0.5) / scale;
      let nearest = Infinity;
      let winding = 0;
      let crossings = 0;
      for (const [ax, ay, bx, by] of segments) {
        const dx = bx - ax;
        const dy = by - ay;
        const lengthSquared = dx * dx + dy * dy;
        const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
        const ex = ax + t * dx - px;
        const ey = ay + t * dy - py;
        const distanceSquared = ex * ex + ey * ey;
        if (distanceSquared < nearest) nearest = distanceSquared;
        if (ay <= py !== by <= py) {
          const crossX = ax + ((py - ay) / dy) * dx;
          if (crossX > px) {
            winding += by > ay ? 1 : -1;
            crossings += 1;
          }
        }
      }
      const inside = fill === "nonzero" ? winding !== 0 : crossings % 2 === 1;
      const distance = Math.sqrt(nearest);
      field[row * width + column] = sdfValue(inside ? -distance : distance);
    }
  }
  return field;
}

class ProtobufWriter {
  constructor() {
    this.bytes = [];
  }

  varint(value) {
    let rest = value >>> 0;
    while (rest > 0x7f) {
      this.bytes.push((rest & 0x7f) | 0x80);
      rest >>>= 7;
    }
    this.bytes.push(rest);
  }

  key(field, wireType) {
    this.varint((field << 3) | wireType);
  }

  uint(field, value) {
    this.key(field, 0);
    this.varint(value);
  }

  sint(field, value) {
    this.key(field, 0);
    this.varint((value << 1) ^ (value >> 31));
  }

  bytesField(field, bytes) {
    this.key(field, 2);
    this.varint(bytes.length);
    for (const byte of bytes) this.bytes.push(byte);
  }

  string(field, value) {
    this.bytesField(field, new TextEncoder().encode(value));
  }

  finish() {
    return Uint8Array.from(this.bytes);
  }
}

function encodeGlyph(glyph) {
  const writer = new ProtobufWriter();
  writer.uint(1, glyph.id);
  if (glyph.bitmap.length > 0) writer.bytesField(2, glyph.bitmap);
  writer.uint(3, glyph.width);
  writer.uint(4, glyph.height);
  writer.sint(5, glyph.left);
  writer.sint(6, glyph.top);
  writer.uint(7, glyph.advance);
  return writer.finish();
}

function encodeRange(stack, start, glyphs) {
  const fontstack = new ProtobufWriter();
  fontstack.string(1, stack);
  fontstack.string(2, `${start}-${start + 255}`);
  for (const glyph of glyphs) fontstack.bytesField(3, encodeGlyph(glyph));
  const message = new ProtobufWriter();
  message.bytesField(1, fontstack.finish());
  return message.finish();
}

function renderGlyph(font, glyph, codePoint) {
  const advance = Math.round((glyph.advanceWidth ?? 0) * (glyphSize / font.unitsPerEm));
  const rings = flatten(glyph.getPath(0, 0, glyphSize).commands);
  if (rings.length === 0) return { id: codePoint, bitmap: new Uint8Array(0), width: 0, height: 0, left: 0, top: -baselineOrigin, advance };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const left = Math.floor(minX);
  const top = Math.floor(minY);
  const width = Math.ceil(maxX) - left;
  const height = Math.ceil(maxY) - top;
  const bitmap = distanceField(rings, left - glyphBorder, top - glyphBorder, width + 2 * glyphBorder, height + 2 * glyphBorder, 1, "nonzero");
  return { id: codePoint, bitmap, width, height, left, top: -top - baselineOrigin, advance };
}

function buildGlyphs() {
  for (const { stack, file } of fonts) {
    const buffer = readFileSync(require.resolve(file));
    const font = opentype.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    const directory = join(output, "glyphs", stack);
    mkdirSync(directory, { recursive: true });
    let written = 0;
    for (const start of ranges) {
      const glyphs = [];
      for (let codePoint = start; codePoint < start + 256; codePoint += 1) {
        const index = font.charToGlyphIndex(String.fromCodePoint(codePoint));
        if (index === 0 && codePoint !== 0) continue;
        glyphs.push(renderGlyph(font, font.glyphs.get(index), codePoint));
      }
      if (glyphs.length <= 1) continue;
      writeFileSync(join(directory, `${start}-${start + 255}.pbf`), encodeRange(stack, start, glyphs));
      written += 1;
    }
    console.log(`glyphs ${stack}: ${written} ranges`);
  }
}

/* Icons are drawn on a 16 x 16 logical pixel grid, y down, and filled even-odd so inner rings cut holes. */

function circle(cx, cy, r, steps = 48) {
  return Array.from({ length: steps }, (_, index) => {
    const angle = (index / steps) * Math.PI * 2;
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  });
}

function roundedRect(x, y, width, height, r) {
  const corners = [
    [x + width - r, y + r, -Math.PI / 2],
    [x + width - r, y + height - r, 0],
    [x + r, y + height - r, Math.PI / 2],
    [x + r, y + r, Math.PI],
  ];
  return corners.flatMap(([cx, cy, from]) => Array.from({ length: 9 }, (_, index) => [cx + r * Math.cos(from + (index / 8) * (Math.PI / 2)), cy + r * Math.sin(from + (index / 8) * (Math.PI / 2))]));
}

function drop() {
  const points = [[8, 1.5]];
  for (let index = 0; index <= 32; index += 1) {
    const angle = -Math.PI / 5 + (index / 32) * (Math.PI + (2 * Math.PI) / 5);
    points.push([8 + 4.6 * Math.cos(angle), 10 + 4.6 * Math.sin(angle)]);
  }
  return points.reverse();
}

function saddle() {
  const right = [];
  const left = [];
  for (let index = 0; index <= 16; index += 1) {
    const y = 2.5 + (index / 16) * 11;
    const pinch = 2.6 * Math.cos(((y - 8) / 5.5) * (Math.PI / 2));
    right.push([12.5 - pinch, y]);
    left.push([3.5 + pinch, 2.5 + 11 - (index / 16) * 11]);
  }
  return [...right, ...left];
}

/** @type {ReadonlyArray<{ name: string; size: number; rings: ReadonlyArray<ReadonlyArray<[number, number]>> }>} */
const icons = [
  { name: "peak", size: 16, rings: [[[8, 2.5], [14, 13], [2, 13]]] },
  { name: "saddle", size: 16, rings: [saddle()] },
  {
    name: "hut",
    size: 16,
    rings: [
      [[8, 1.8], [14.5, 7.6], [13, 7.6], [13, 14], [3, 14], [3, 7.6], [1.5, 7.6]],
      [[6.6, 14], [6.6, 10], [9.4, 10], [9.4, 14]],
    ],
  },
  { name: "shelter", size: 16, rings: [[[8, 2.5], [15, 10.5], [12.6, 10.5], [8, 5.4], [3.4, 10.5], [1, 10.5]], [[4.5, 11.5], [11.5, 11.5], [11.5, 13.5], [4.5, 13.5]]] },
  { name: "water", size: 16, rings: [drop()] },
  { name: "badge", size: 16, rings: [roundedRect(1.5, 1.5, 13, 13, 3.5)] },
  { name: "dot", size: 16, rings: [circle(8, 8, 3.2)] },
];

/** Overlay icons are added at runtime by the map components, so they work over any base style, including remote ones. */
const overlayIcons = [{ name: "heading", size: 16, rings: [[[8, 1], [13.5, 13], [8, 10.2], [2.5, 13]]] }];

/** Space around each icon so halos up to 2 px keep a full ramp. */
const iconBorder = 4;

function buildOverlay(icon) {
  const directory = join(output, "overlay");
  mkdirSync(directory, { recursive: true });
  for (const pixelRatio of [1, 2, 3]) {
    const cell = Math.ceil((icon.size + 2 * iconBorder) * pixelRatio);
    const field = distanceField(icon.rings, -iconBorder, -iconBorder, cell, cell, pixelRatio, "evenodd");
    const rgba = new Uint8Array(cell * cell * 4);
    for (let pixel = 0; pixel < cell * cell; pixel += 1) {
      rgba.fill(255, pixel * 4, pixel * 4 + 3);
      rgba[pixel * 4 + 3] = field[pixel];
    }
    writeFileSync(join(directory, `${icon.name}${pixelRatio === 1 ? "" : `@${pixelRatio}x`}.png`), encodePng(cell, cell, rgba));
  }
  console.log(`overlay ${icon.name}`);
}

function buildSprite(pixelRatio) {
  const cells = icons.map((icon) => ({ ...icon, cell: Math.ceil((icon.size + 2 * iconBorder) * pixelRatio) }));
  const width = cells.reduce((sum, { cell }) => sum + cell, 0);
  const height = Math.max(...cells.map(({ cell }) => cell));
  const rgba = new Uint8Array(width * height * 4);
  const index = {};
  let x = 0;
  for (const icon of cells) {
    const field = distanceField(icon.rings, -iconBorder, -iconBorder, icon.cell, icon.cell, pixelRatio, "evenodd");
    for (let row = 0; row < icon.cell; row += 1) {
      for (let column = 0; column < icon.cell; column += 1) {
        const target = (row * width + x + column) * 4;
        rgba[target] = 255;
        rgba[target + 1] = 255;
        rgba[target + 2] = 255;
        rgba[target + 3] = field[row * icon.cell + column];
      }
    }
    index[icon.name] = { x, y: 0, width: icon.cell, height: icon.cell, pixelRatio, sdf: true };
    x += icon.cell;
  }
  const suffix = pixelRatio === 1 ? "" : `@${pixelRatio}x`;
  const directory = join(output, "sprites");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `obnixe${suffix}.json`), `${JSON.stringify(index, null, 2)}\n`);
  writeFileSync(join(directory, `obnixe${suffix}.png`), encodePng(width, height, rgba));
  console.log(`sprite ${suffix || "@1x"}: ${width}x${height}`);
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(6, 9);
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let row = 0; row < height; row += 1) {
    rows[row * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, row * width * 4, width * 4).copy(rows, row * (width * 4 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(rows, { level: 9 })), pngChunk("IEND", Buffer.alloc(0))]);
}

rmSync(output, { recursive: true, force: true });
buildGlyphs();
buildSprite(1);
buildSprite(2);
for (const icon of overlayIcons) buildOverlay(icon);
