export interface Random {
  /** Uniform in [0, 1). */
  readonly uniform: () => number;
  /** Uniform in [min, max). */
  readonly between: (min: number, max: number) => number;
  /** Standard normal. */
  readonly gaussian: () => number;
}

/** Seeded mulberry32 generator with Box-Muller normals: identical sequences on every engine. */
export function createRandom(seed: number): Random {
  let state = seed >>> 0;
  const uniform = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  let spare: number | null = null;
  const gaussian = (): number => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    const radius = Math.sqrt(-2 * Math.log(1 - uniform()));
    const angle = 2 * Math.PI * uniform();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
  return { uniform, between: (min: number, max: number): number => min + (max - min) * uniform(), gaussian };
}
