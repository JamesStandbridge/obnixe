const groupSeparator = "\u00a0";

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, groupSeparator);
}

/** French decimal comma, grouped thousands, trailing zeros dropped down to `minDecimals`. */
export function formatNumber(value: number, maxDecimals = 1, minDecimals = 0): string {
  const factor = 10 ** maxDecimals;
  const rounded = Math.round(Math.abs(value) * factor) / factor;
  let [whole = "0", fraction = ""] = rounded.toFixed(maxDecimals).split(".");
  fraction = fraction.replace(/0+$/, "");
  while (fraction.length < minDecimals) fraction += "0";
  const sign = value < 0 && rounded !== 0 ? "−" : "";
  return `${sign}${groupThousands(whole)}${fraction.length > 0 ? `,${fraction}` : ""}`;
}

export function formatInteger(value: number): string {
  const rounded = Math.round(value);
  return `${rounded < 0 ? "−" : ""}${groupThousands(String(Math.abs(rounded)))}`;
}

/** Explicit "+" or "−"; a value that rounds to zero carries no sign. */
export function formatSigned(value: number, maxDecimals = 1): string {
  const factor = 10 ** maxDecimals;
  const rounded = Math.round(Math.abs(value) * factor) / factor;
  if (rounded === 0) return formatNumber(0, maxDecimals);
  return `${value > 0 ? "+" : "−"}${formatNumber(rounded, maxDecimals)}`;
}
