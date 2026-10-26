export type RestAlertPermission = "granted" | "denied" | "ask";

export interface RestAlert {
  readonly endsAt: number;
  readonly body: string;
}

export async function restAlertPermission(): Promise<RestAlertPermission> {
  return "denied";
}

export async function requestRestAlerts(): Promise<RestAlertPermission> {
  return "denied";
}

export async function scheduleRestAlert(_alert: RestAlert): Promise<string> {
  return "";
}

export async function cancelRestAlert(_id: string): Promise<void> {}
