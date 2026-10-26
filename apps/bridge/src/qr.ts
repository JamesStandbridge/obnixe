import { encode, renderSVG } from "uqr";

const quietZone = 2;

/** Draws the QR code with explicit black on white ANSI colours, two modules per character, so it scans on any terminal theme. */
export function terminalQr(text: string): string {
  const { data } = encode(text, { ecc: "M", border: quietZone });
  const lines: string[] = [];
  for (let row = 0; row < data.length; row += 2) {
    let line = "";
    for (let column = 0; column < data.length; column += 1) {
      const top = data[row]?.[column] === true;
      const bottom = data[row + 1]?.[column] === true;
      line += `\u001b[${top ? 30 : 97};${bottom ? 40 : 107}m\u2580`;
    }
    lines.push(`${line}\u001b[0m`);
  }
  return lines.join("\n");
}

export function svgQr(text: string): string {
  return renderSVG(text, { ecc: "M", border: quietZone, pixelSize: 8, whiteColor: "#ffffff", blackColor: "#0c1013" });
}
