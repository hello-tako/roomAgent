import { describe, expect, it } from "vitest";
import {
  REPLAY_WINDOW,
  applyResync,
  createRoomState,
  noteOutgoing,
  parseRoomEvent,
  reduceRoomEvent,
  type RoomEvent,
} from "../src/reducer";

function event(seq: number, type = "message.created", data: RoomEvent["data"] = {}): RoomEvent {
  return { v: 1, type, event_id: `evt_${seq}`, seq, data };
}

describe("room event reducer", () => {
  it("applies ordered events and ignores duplicates", () => {
    let state = createRoomState();
    state = reduceRoomEvent(state, event(1, "message.created", { body: "one" }));
    state = reduceRoomEvent(state, event(1, "message.created", { body: "one" }));
    state = reduceRoomEvent(state, event(2, "message.created", { body: "two" }));
    expect(state.headSeq).toBe(2);
    expect(state.events.map((item) => item.seq)).toEqual([1, 2]);
    expect(state.status).toBe("ready");
  });

  it("buffers a limited gap and drains it in order", () => {
    let state = createRoomState();
    state = reduceRoomEvent(state, event(2, "message.created", { body: "two" }));
    expect(state.events).toHaveLength(0);
    expect(state.buffer).toHaveLength(1);
    state = reduceRoomEvent(state, event(1, "message.created", { body: "one" }));
    expect(state.events.map((item) => item.data.body)).toEqual(["one", "two"]);
    expect(state.buffer).toHaveLength(0);
    expect(state.headSeq).toBe(2);
  });

  it("requires resync when the gap meets the replay window", () => {
    let state = createRoomState();
    state = reduceRoomEvent(state, event(REPLAY_WINDOW, "message.created", { body: "far" }));
    expect(state.status).toBe("resync");
    expect(state.events).toHaveLength(0);
    expect(state.errorCode).toBe("RESYNC_REQUIRED");
  });

  it("marks a message delivered only after the server event carries the same key", () => {
    let state = noteOutgoing(createRoomState(), "message-key-1");
    expect(state.deliveredKeys).toEqual([]);
    state = reduceRoomEvent(
      state,
      event(1, "message.created", { body: "hello", idempotency_key: "message-key-1" }),
    );
    expect(state.pendingKeys).toEqual([]);
    expect(state.deliveredKeys).toEqual(["message-key-1"]);
  });

  it("stops on revocation and replaces a broken prefix from a contiguous resync", () => {
    let state = reduceRoomEvent(createRoomState(), event(1));
    state = reduceRoomEvent(state, event(2, "session.revoked", { reason: "SESSION_REVOKED" }));
    expect(state.status).toBe("revoked");
    const repaired = applyResync(createRoomState(), [event(1), event(2)]);
    expect(repaired.status).toBe("ready");
    expect(repaired.headSeq).toBe(2);
    const gapped = applyResync(createRoomState(), [event(2)]);
    expect(gapped.status).toBe("resync");
  });

  it("rejects an event that is not an envelope", () => {
    expect(
      parseRoomEvent({ v: 2, type: "message.created", event_id: "evt_1", seq: 1, data: {} }),
    ).toBeNull();
    expect(
      parseRoomEvent({
        v: 1,
        type: "message.created",
        event_id: "evt_1",
        seq: 1,
        data: { body: "ok" },
      })?.data.body,
    ).toBe("ok");
  });
});
