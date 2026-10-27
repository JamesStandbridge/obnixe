export type RestAlertPermission = "granted" | "denied" | "ask";

export type RestAlertSystemState = "granted" | "blocked" | "refused" | "undetermined";

export interface RestAlert {
  readonly endsAt: number;
  readonly body: string;
}

export function configureRestAlerts(): void {}

export async function restAlertSystemState(): Promise<RestAlertSystemState> {
  return "blocked";
}

export async function requestRestAlerts(): Promise<RestAlertSystemState> {
  return "blocked";
}

export function scheduleRestAlert(_alert: RestAlert): void {}

export function cancelRestAlert(): void {}
