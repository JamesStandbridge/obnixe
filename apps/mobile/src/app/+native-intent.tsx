import { environment } from "@/data/database";
import { deliverPairingRequest, hasPairingListener, inviteLink, readInvite } from "@/features/agent/invites";

interface SystemPath {
  readonly path: string;
  readonly initial: boolean;
}

/**
 * Hands a scanned `obnixe://pair` link to the Agent screen, which asks for confirmation before anything changes. When an
 * Agent screen is already open the app stays where it is, so no second screen and no second link appear. Every other link
 * goes through unchanged.
 */
export function redirectSystemPath({ path }: SystemPath): string | null {
  const link = inviteLink(path);
  if (link === null) return path;
  const mounted = hasPairingListener();
  deliverPairingRequest(readInvite(link, environment.now()));
  return mounted ? null : "/agent";
}
