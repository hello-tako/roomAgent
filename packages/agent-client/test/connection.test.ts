import { describe, expect, it, vi } from "vitest";
import { RoomConnection, reconnectDelayMs } from "../src/connection";

class FakeSocket extends EventTarget {
  static sockets: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.sockets.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  receive(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

describe("room connection", () => {
  it("sends hello, tracks delivery, and does not replay a message after reconnect", () => {
    vi.useFakeTimers();
    FakeSocket.sockets = [];
    const seen: string[] = [];
    const connection = new RoomConnection({
      url: "ws://company.local/room",
      hello: { kind: "human", token: "hum_" + "ab".repeat(32) },
      heartbeatMs: 0,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
      onChange: (snapshot) => {
        seen.push(snapshot.status);
      },
    });
    connection.start();
    const socket = FakeSocket.sockets[0];
    if (!socket) {
      throw new Error("Missing socket");
    }
    socket.open();
    const hello = JSON.parse(socket.sent[0] ?? "{}") as { data: { actor_type: string } };
    expect(hello.data.actor_type).toBe("human");
    expect(JSON.stringify(hello)).not.toContain("employee_id");
    socket.receive({
      v: 1,
      type: "session.ready",
      event_id: "evt_ready",
      seq: 0,
      data: { actor_type: "human", replayed: 0 },
    });
    expect(connection.sendMessage("Hello operator", "message-key-2")).toBe(true);
    expect(connection.snapshot().deliveredKeys).toEqual([]);
    socket.receive({
      v: 1,
      type: "message.created",
      event_id: "evt_1",
      seq: 1,
      data: { body: "Hello operator", idempotency_key: "message-key-2", actor_type: "human" },
    });
    expect(connection.snapshot().deliveredKeys).toEqual(["message-key-2"]);
    socket.close();
    vi.advanceTimersByTime(reconnectDelayMs(0));
    const next = FakeSocket.sockets[1];
    expect(next).toBeDefined();
    next?.open();
    const again = JSON.parse(next?.sent[0] ?? "{}") as { type: string };
    expect(again.type).toBe("session.hello");
    expect(next?.sent.some((item) => item.includes("message.send"))).toBe(false);
    connection.stop();
    vi.useRealTimers();
  });

  it("stops when the server revokes the session", () => {
    FakeSocket.sockets = [];
    const connection = new RoomConnection({
      url: "ws://company.local/room",
      hello: { kind: "employee", employeeId: "emp_abc", token: "cd".repeat(32) },
      heartbeatMs: 0,
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    connection.start();
    const socket = FakeSocket.sockets[0];
    socket?.open();
    socket?.receive({
      v: 1,
      type: "session.revoked",
      event_id: "evt_revoke",
      seq: 4,
      data: { reason: "SESSION_REVOKED" },
    });
    expect(connection.snapshot().status).toBe("revoked");
    expect(connection.sendMessage("later", "message-key-3")).toBe(false);
  });
});
