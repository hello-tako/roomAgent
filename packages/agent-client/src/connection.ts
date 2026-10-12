import {
  createRoomState,
  noteOutgoing,
  parseRoomEvent,
  reduceRoomEvent,
  type RoomEvent,
  type RoomReducerState,
} from "./reducer";

export interface HumanHello {
  kind: "human";
  token: string;
}

export interface EmployeeHello {
  kind: "employee";
  token: string;
  employeeId: string;
}

export type RoomHello = HumanHello | EmployeeHello;

export interface RoomSnapshot {
  status: "connecting" | "ready" | "resyncing" | "revoked" | "closed" | "failed";
  headSeq: number;
  events: RoomEvent[];
  errorCode: string | null;
  pendingKeys: string[];
  deliveredKeys: string[];
}

export interface RoomConnectionOptions {
  url: string;
  hello: RoomHello;
  socketFactory?: (url: string) => WebSocket;
  heartbeatMs?: number;
  reconnect?: boolean;
  maxAttempts?: number;
  initialSeq?: number;
  onChange?: (snapshot: RoomSnapshot) => void;
  resync?: (afterSeq: number) => Promise<RoomEvent[]>;
}

const MAX_ATTEMPTS = 6;

export function reconnectDelayMs(attempt: number): number {
  const step = Math.min(Math.max(attempt, 0), 5);
  return 500 * 2 ** step;
}

export class RoomConnection {
  private socket: WebSocket | null = null;
  private state: RoomReducerState = createRoomState();
  private status: RoomSnapshot["status"] = "closed";
  private stopped = false;
  private attempt = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: RoomConnectionOptions) {
    const initial = options.initialSeq;
    if (initial !== undefined && Number.isInteger(initial) && initial >= 0) {
      this.state = { ...createRoomState(), headSeq: initial };
    }
  }

  start(): void {
    this.stopped = false;
    this.attempt = 0;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
    this.status = "closed";
    this.emit();
  }

  snapshot(): RoomSnapshot {
    return {
      status: this.status,
      headSeq: this.state.headSeq,
      events: this.state.events,
      errorCode: this.state.errorCode,
      pendingKeys: this.state.pendingKeys,
      deliveredKeys: this.state.deliveredKeys,
    };
  }

  sendMessage(body: string, idempotencyKey: string): boolean {
    return this.send(
      {
        v: 1,
        type: "message.send",
        data: { body, idempotency_key: idempotencyKey },
      },
      idempotencyKey,
    );
  }

  sendTask(
    command: "task.ack" | "task.start" | "task.submit",
    taskId: string,
    idempotencyKey: string,
  ): boolean {
    return this.send(
      {
        v: 1,
        type: command,
        data: { task_id: taskId, idempotency_key: idempotencyKey },
      },
      idempotencyKey,
    );
  }

  private send(payload: unknown, idempotencyKey: string): boolean {
    if (
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN ||
      this.state.status !== "ready"
    ) {
      return false;
    }
    this.socket.send(JSON.stringify(payload));
    this.state = noteOutgoing(this.state, idempotencyKey);
    this.emit();
    return true;
  }

  private open(): void {
    if (this.stopped) {
      return;
    }
    this.status = "connecting";
    this.emit();
    const factory = this.options.socketFactory ?? ((url: string) => new WebSocket(url));
    const socket = factory(this.options.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.stopped) {
        return;
      }
      this.attempt = 0;
      socket.send(JSON.stringify(this.helloPayload()));
      this.armHeartbeat(socket);
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) {
        return;
      }
      this.onMessage(String(event.data));
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      this.clearTimers();
      if (this.stopped || this.status === "revoked") {
        return;
      }
      this.scheduleReconnect();
    });
  }

  private helloPayload(): Record<string, unknown> {
    const hello = this.options.hello;
    if (hello.kind === "human") {
      return {
        v: 1,
        type: "session.hello",
        last_seen_seq: this.state.headSeq,
        data: { actor_type: "human", token: hello.token },
      };
    }
    return {
      v: 1,
      type: "session.hello",
      last_seen_seq: this.state.headSeq,
      data: { employee_id: hello.employeeId, token: hello.token },
    };
  }

  private onMessage(raw: string): void {
    if (raw.length > 8000) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const event = parseRoomEvent(parsed);
    if (!event) {
      return;
    }
    const before = this.state.status;
    this.state = reduceRoomEvent(this.state, event);
    if (this.state.status === "revoked") {
      this.status = "revoked";
      this.stopped = true;
      this.clearTimers();
      this.socket?.close();
      this.emit();
      return;
    }
    if (this.state.status === "resync" && before !== "resync") {
      void this.recover();
      return;
    }
    if (this.state.status === "ready") {
      this.status = "ready";
    }
    this.emit();
  }

  private async recover(): Promise<void> {
    this.status = "resyncing";
    this.emit();
    const resync = this.options.resync;
    if (!resync) {
      this.status = "failed";
      this.stopped = true;
      this.emit();
      return;
    }
    try {
      const events = await resync(this.state.headSeq);
      let next = this.state;
      next = { ...next, status: "idle", buffer: [], errorCode: null };
      for (const event of events) {
        next = reduceRoomEvent(next, event);
        if (next.status === "resync") {
          this.state = next;
          this.status = "failed";
          this.stopped = true;
          this.emit();
          return;
        }
      }
      this.state = { ...next, status: "ready", errorCode: null };
      this.status = "ready";
      this.emit();
    } catch {
      this.status = "failed";
      this.stopped = true;
      this.emit();
    }
  }

  private scheduleReconnect(): void {
    if (this.options.reconnect === false) {
      this.status = "closed";
      this.emit();
      return;
    }
    const limit = this.options.maxAttempts ?? MAX_ATTEMPTS;
    if (this.attempt >= limit) {
      this.status = "failed";
      this.stopped = true;
      this.emit();
      return;
    }
    const delay = reconnectDelayMs(this.attempt);
    this.attempt += 1;
    this.status = "connecting";
    this.emit();
    this.reconnectTimer = setTimeout(() => {
      this.open();
    }, delay);
  }

  private armHeartbeat(socket: WebSocket): void {
    const interval = this.options.heartbeatMs ?? 20_000;
    if (interval <= 0) {
      return;
    }
    this.heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ v: 1, type: "ping", data: {} }));
      }
    }, interval);
  }

  private clearTimers(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private emit(): void {
    this.options.onChange?.(this.snapshot());
  }
}
