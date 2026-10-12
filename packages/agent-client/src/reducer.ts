export const REPLAY_WINDOW = 100;
export const MAX_BUFFER = 32;

export interface RoomEvent {
  v: 1;
  type: string;
  event_id: string;
  seq: number;
  data: Record<string, string | number | boolean | null>;
}

export interface RoomReducerState {
  status: "idle" | "ready" | "resync" | "revoked";
  headSeq: number;
  events: RoomEvent[];
  buffer: RoomEvent[];
  pendingKeys: string[];
  deliveredKeys: string[];
  errorCode: string | null;
}

export function createRoomState(): RoomReducerState {
  return {
    status: "idle",
    headSeq: 0,
    events: [],
    buffer: [],
    pendingKeys: [],
    deliveredKeys: [],
    errorCode: null,
  };
}

export function noteOutgoing(state: RoomReducerState, key: string): RoomReducerState {
  if (state.pendingKeys.includes(key) || state.deliveredKeys.includes(key)) {
    return state;
  }
  return { ...state, pendingKeys: [...state.pendingKeys, key] };
}

export function parseRoomEvent(value: unknown): RoomEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || typeof record.type !== "string" || typeof record.event_id !== "string") {
    return null;
  }
  if (typeof record.seq !== "number" || !Number.isInteger(record.seq) || record.seq < 0) {
    return null;
  }
  const data = record.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(data)) {
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
    ) {
      if (typeof item === "string" && item.length > 8000) {
        return null;
      }
      safe[key] = item;
    }
  }
  return {
    v: 1,
    type: record.type,
    event_id: record.event_id,
    seq: record.seq,
    data: safe,
  };
}

export function reduceRoomEvent(state: RoomReducerState, event: RoomEvent): RoomReducerState {
  if (event.type === "session.revoked") {
    return {
      ...state,
      status: "revoked",
      errorCode: textCode(event.data.reason) ?? "SESSION_REVOKED",
    };
  }
  if (event.type === "error") {
    const code = textCode(event.data.code) ?? textCode(event.data.reason) ?? "ERROR";
    if (code === "RESYNC_REQUIRED" || code === "INVALID_SEQUENCE") {
      return { ...state, status: "resync", buffer: [], errorCode: code };
    }
    return { ...state, errorCode: code };
  }
  if (event.type === "session.ready" || event.type === "pong") {
    return {
      ...state,
      status: state.status === "revoked" ? "revoked" : "ready",
      headSeq: Math.max(state.headSeq, event.seq),
      errorCode: null,
    };
  }
  if (event.seq <= state.headSeq) {
    return state;
  }
  if (event.seq - state.headSeq >= REPLAY_WINDOW) {
    return { ...state, status: "resync", buffer: [], errorCode: "RESYNC_REQUIRED" };
  }
  const buffered = state.buffer.some((item) => item.seq === event.seq)
    ? state.buffer
    : [...state.buffer, event].sort((left, right) => left.seq - right.seq);
  if (buffered.length > MAX_BUFFER) {
    return { ...state, status: "resync", buffer: [], errorCode: "RESYNC_REQUIRED" };
  }
  return drain({ ...state, buffer: buffered });
}

export function applyResync(state: RoomReducerState, events: RoomEvent[]): RoomReducerState {
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  let next: RoomReducerState = {
    ...state,
    status: "idle",
    buffer: [],
    errorCode: null,
  };
  for (const event of ordered) {
    next = reduceRoomEvent(next, event);
    if (next.status === "resync") {
      return next;
    }
  }
  if (next.buffer.length > 0) {
    return { ...next, status: "resync", buffer: [], errorCode: "RESYNC_REQUIRED" };
  }
  return { ...next, status: "ready", errorCode: null };
}

function drain(state: RoomReducerState): RoomReducerState {
  let next = state;
  const pending = [...state.buffer];
  while (pending.length > 0 && pending[0]?.seq === next.headSeq + 1) {
    const event = pending.shift();
    if (!event) {
      break;
    }
    next = applyOrdered(next, event);
  }
  return { ...next, buffer: pending };
}

function applyOrdered(state: RoomReducerState, event: RoomEvent): RoomReducerState {
  const key = typeof event.data.idempotency_key === "string" ? event.data.idempotency_key : null;
  const delivered =
    key && state.pendingKeys.includes(key) && !state.deliveredKeys.includes(key)
      ? [...state.deliveredKeys, key]
      : state.deliveredKeys;
  const pending = key ? state.pendingKeys.filter((item) => item !== key) : state.pendingKeys;
  return {
    ...state,
    status: "ready",
    headSeq: event.seq,
    events: [...state.events, event],
    pendingKeys: pending,
    deliveredKeys: delivered,
    errorCode: null,
  };
}

function textCode(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 80 ? value : null;
}
