import { deliverPairingRequest, inviteLink, readInvite } from "@/features/agent/invites";

interface SystemPath {
  readonly path: string;
  readonly initial: boolean;
}

/** Opens the Agent screen on a scanned `obnixe://pair` link and hands it the invite; every other link goes through unchanged. */
export function redirectSystemPath({ path }: SystemPath): string {
  const link = inviteLink(path);
  if (link === null) return path;
  deliverPairingRequest(readInvite(link));
  return "/agent";
}
