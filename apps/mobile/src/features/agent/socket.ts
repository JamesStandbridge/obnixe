/**
 * Text transport a PhoneSession runs over: a WebSocket dialed straight to the bridge (openDirectSocket) or a peer the
 * relay paired with the bridge (dialRelay in relay.ts). `onclose` fires once the transport is gone, unless the handler
 * was cleared before calling `close`.
 */
export interface LinkSocket {
  onmessage: ((text: string) => void) | null;
  onclose: (() => void) | null;
  send(text: string): void;
  close(): void;
}

/** Dials the bridge at `url`; `onopen` reports the WebSocket handshake, before any bridge frame. */
export function openDirectSocket(url: string, onopen: () => void): LinkSocket {
  const socket = new WebSocket(url);
  socket.onopen = onopen;
  const link: LinkSocket = {
    onmessage: null,
    onclose: null,
    send: (text) => socket.send(text),
    close: () => socket.close(),
  };
  socket.onmessage = (event: MessageEvent) => link.onmessage?.(String(event.data));
  socket.onclose = () => link.onclose?.();
  return link;
}
