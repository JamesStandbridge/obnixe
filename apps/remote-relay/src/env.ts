import type { PhoneLink } from "./phone.ts";

export interface Env {
  readonly PHONES: DurableObjectNamespace<PhoneLink>;
}
