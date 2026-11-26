export interface MetricSize {
  readonly size: number;
  /** Smallest size, in points, a value shrinks to when it does not fit. */
  readonly minimum: number;
}

/** `UX-001`: the main metric, or the step remaining in a guided workout, never goes below 64 pt, every other live metric below 32 pt. */
export const metricSizes = {
  main: { size: 120, minimum: 66 },
  guided: { size: 104, minimum: 64 },
  secondary: { size: 56, minimum: 40 },
  compact: { size: 40, minimum: 32 },
} as const satisfies Readonly<Record<string, MetricSize>>;

export type MetricSizeKey = keyof typeof metricSizes;

/** The `adjustsFontSizeToFit` bounds of each platform: iOS reads a scale, Android a size in pixels and 4 dp without one. */
export interface FitBounds {
  readonly minimumFontScale: number;
  readonly minimumFontSize: number;
}

export function fitBounds(metric: MetricSize, pixelRatio: number): FitBounds {
  return { minimumFontScale: metric.minimum / metric.size, minimumFontSize: Math.ceil(metric.minimum * pixelRatio) };
}
