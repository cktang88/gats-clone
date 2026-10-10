import type { ServerMsg } from '../shared/protocol.ts';

/**
 * The server's messages as the page takes them in a match: one handler for every message type, so the compiler refuses a
 * type the server sends but no handler takes (the `progress` and `equipped` messages once went nowhere, so the XP card after
 * a life, the challenge toasts and the equipped set the server confirmed never reached the page).
 */
export type ServerMsgHandlers = { [K in ServerMsg['t']]: (msg: Extract<ServerMsg, { t: K }>) => void };

/** Every message type the page accepts off the socket. */
export const SERVER_MSG_TYPES: ReadonlySet<string> = new Set<ServerMsg['t']>(['welcome', 'walls', 'snap', 'chat', 'emote', 'radio', 'badge', 'error', 'progress', 'equipped', 'friendInvite', 'friends', 'friendNote']);

export function parseServerMsg(data: unknown): ServerMsg | null {
  if (typeof data !== 'string') return null;
  try {
    const v: unknown = JSON.parse(data);
    return typeof v === 'object' && v !== null && SERVER_MSG_TYPES.has((v as { t: string }).t) ? (v as ServerMsg) : null;
  } catch {
    return null;
  }
}

/** Hands `msg` to its type's handler. */
export function routeServerMsg(msg: ServerMsg, handlers: ServerMsgHandlers): void {
  (handlers[msg.t] as (m: ServerMsg) => void)(msg);
}
