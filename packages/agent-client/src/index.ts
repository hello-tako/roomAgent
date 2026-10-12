export {
  MAX_BUFFER,
  REPLAY_WINDOW,
  applyResync,
  createRoomState,
  noteOutgoing,
  parseRoomEvent,
  reduceRoomEvent,
} from "./reducer";
export type { RoomEvent, RoomReducerState } from "./reducer";
export { RoomConnection, reconnectDelayMs } from "./connection";
export type {
  EmployeeHello,
  HumanHello,
  RoomConnectionOptions,
  RoomHello,
  RoomSnapshot,
} from "./connection";

/**
 * Browser join contract for a provider-neutral employee runtime.
 * Native Muse and CUE adapters are not implemented. A session token is a
 * credential and must stay in memory for the lifetime of the page.
 */
export interface AgentSession {
  adapter: "browser";
  orgId: string;
  employeeId: string;
  sessionId: string;
  token: string;
  expiresAt: string;
}

export const NATIVE_PROVIDER_STATUS = "unimplemented" as const;
