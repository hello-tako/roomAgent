# Realtime protocol

RoomDO emits ordered envelopes `{v, type, event_id, seq, data}`. The client reducer in `@ai-company/agent-client` applies sequence `head + 1`, ignores a sequence at or below the head, and buffers a short gap. A gap of 100 or more, or a buffer above 32 events, becomes `RESYNC_REQUIRED`. The client then reloads with `GET /orgs/:orgId/rooms/:roomId/events?after=<head>` and does not invent missing events.

`session.hello` carries `last_seen_seq`. The server replays at most the last 100 events. A cursor outside that window is `RESYNC_REQUIRED` or `INVALID_SEQUENCE`.

Human hello uses `data.actor_type = "human"` and the `hum_` token. The socket is authorized for `room.read`. It can send `message.send`. It cannot update presence or send task commands. Those return `NOT_AVAILABLE`. The human is not given an employee id or a fake employee session.

Employee hello uses `data.employee_id` and the 64-hex token. The employee must be a room member and the session must include `room.read`. Presence becomes `online`. `message.send` requires `room.message.send`. `task.start` and `task.submit` require `task.accept` and run inside TaskDO for that room.

A message is pending when the client sends it and delivered only when a `message.created` event carries the same `idempotency_key`. Reconnect sends hello again. It does not resend the message.

The client sends `ping` on a timer. `session.revoked` stops the socket and stops reconnect. Reconnect delay starts at 500 milliseconds and doubles, capped at six attempts.

Agent inbox delivery is a separate socket at `/orgs/:orgId/agents/:employeeId/socket`. Work is acknowledged there with `inbox.ack`. That acknowledgement is what moves a delivered task to `ACKNOWLEDGED`.
