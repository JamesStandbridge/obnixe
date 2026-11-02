import { parseRemotePublicKey, remoteDomain, remotePhoneId, remotePhoneIdPattern, remoteRelayHost } from "@obnixe/core/agent/remote-relay";
import type { Env } from "./env.ts";
import { plainResponse } from "./responses.ts";

export { PhoneLink } from "./phone.ts";

const phoneSuffix = `.${remoteDomain}`;

function connect(request: Request, env: Env, url: URL): Promise<Response> | Response {
  if (url.pathname !== "/connect") return plainResponse(404, "Unknown relay path");
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return plainResponse(426, "Expected a WebSocket upgrade");
  const key = parseRemotePublicKey(url.searchParams.get("key") ?? "");
  if (key === null) return plainResponse(400, "Expected the phone's public key");
  return env.PHONES.get(env.PHONES.idFromName(remotePhoneId(key))).fetch(request);
}

export default {
  fetch(request, env): Promise<Response> | Response {
    const url = new URL(request.url);
    if (url.hostname === remoteRelayHost) return connect(request, env, url);
    const id = url.hostname.endsWith(phoneSuffix) ? url.hostname.slice(0, -phoneSuffix.length) : "";
    if (!remotePhoneIdPattern.test(id)) return plainResponse(404, "Unknown Obnixe address");
    return env.PHONES.get(env.PHONES.idFromName(id)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
