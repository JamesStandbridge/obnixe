import { dueWeather, fetchWeather, planWeather, readSettings, recordWeatherFailure, settleWeather, weatherBatchSize, weatherRequest, weatherRetryAt, weatherStored } from "@obnixe/core";
import type { DueWeather, WeatherFetchResult, WeatherTransport } from "@obnixe/core";
import type { EpochMs } from "@obnixe/schema";
import { db } from "@/data/database";
import type { RecorderWriter } from "@/features/tracking/recorderHost";

export interface WeatherQueueOptions {
  readonly writer: Pick<RecorderWriter, "write">;
  readonly transport: WeatherTransport;
  /** Whether the phone has a connection that reaches the internet: offline, nothing is attempted nor counted. */
  readonly online: () => Promise<boolean>;
  /** `PRV-020`: true while an activity is prepared or recorded, when no request may leave the phone. */
  readonly recording: () => boolean;
  readonly now: () => EpochMs;
  readonly report: (error: unknown) => void;
}

const requestTimeoutMs = 20_000;

/** `fetch` with a timeout, which the weather client reports as a network failure. */
export const timedFetch: WeatherTransport = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The deferred weather requests of saved activities (`DEC-13`, `WTH-001` to `WTH-003`): after a save or an import once the
 * derivation knows the start, and at launch, return to the foreground or reconnection, while the setting allows it and the
 * phone is online. A failed request waits for its backoff and is given up after three retries.
 */
export class WeatherQueue {
  private again = false;
  private current: Promise<void> | null = null;

  constructor(private readonly options: WeatherQueueOptions) {}

  /** Starts a pass, or queues one after the running pass so an activity saved meanwhile is seen. */
  request(): Promise<void> {
    if (this.current !== null) {
      this.again = true;
      return this.current;
    }
    this.current = this.loop()
      .catch(this.options.report)
      .finally(() => {
        this.current = null;
      });
    return this.current;
  }

  private async loop(): Promise<void> {
    do {
      this.again = false;
      await this.pass();
    } while (this.again);
  }

  private allowed(): boolean {
    return !this.options.recording() && readSettings(db()).weatherEnabled;
  }

  private async pass(): Promise<void> {
    for (;;) {
      if (!this.allowed()) return;
      const due = dueWeather(db(), this.options.now(), weatherBatchSize);
      if (due.length === 0 || !(await this.options.online())) return;
      for (const item of due) {
        if (!this.allowed()) return;
        const result = await fetchWeather(weatherRequest(item.activity, this.options.now()), this.options.transport, this.options.now);
        this.settle(item, result);
        if (result.status === "failed" && result.failure === "network") return;
      }
    }
  }

  private settle(item: DueWeather, result: WeatherFetchResult): void {
    const settlement = settleWeather(item.failedAttempts, result);
    switch (settlement.action) {
      case "store": {
        const plan = planWeather(db(), item.sessionId, settlement.weather);
        if (plan === null) return;
        this.options.writer.write("Météo de l'activité", plan.mutations);
        weatherStored(db(), plan);
        return;
      }
      case "retry":
        recordWeatherFailure(db(), item.sessionId, settlement.failedAttempts, weatherRetryAt(settlement.failedAttempts, this.options.now()));
        return;
      case "abandon":
        recordWeatherFailure(db(), item.sessionId, item.failedAttempts + 1, null);
        return;
      default: {
        const unreachable: never = settlement;
        throw new Error(`Unhandled weather settlement ${String(unreachable)}`);
      }
    }
  }
}
