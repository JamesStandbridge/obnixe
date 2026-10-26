export type RestAlertPermission = "granted" | "denied" | "ask";

export interface RestAlert {
  readonly endsAt: number;
  readonly body: string;
}

export function configureRestAlerts(): void {}

export async function restAlertPermission(): Promise<RestAlertPermission> {
  return "denied";
}

export async function requestRestAlerts(): Promise<RestAlertPermission> {
  return "denied";
}

export function scheduleRestAlert(_alert: RestAlert): void {}

export function cancelRestAlert(): void {}
