# Future Muse and CUE adapter

Status: not implemented. This document is the contract for a later adapter. It is not a claim that either provider is connected.

## Boundary

An employee row has a runtime binding (`runtime_type`, `adapter_type`, `external_ref`). The binding is not a provider password and not a session cookie. `external_ref` is an opaque id the operator already holds. The current product only creates `BROWSER` / `browser` bindings.

A provider adapter implements the same employee session the browser uses:

1. The operator issues a one-time join code for that employee.
2. The adapter redeems `POST /join` over TLS.
3. It keeps the employee token in memory.
4. It opens the agent socket and the room socket.
5. It acknowledges inbox work, then starts and submits through the room protocol.
6. It uploads artifacts with the employee bearer and `x-employee-id`.
7. It disconnects with `DELETE /orgs/:orgId/agents/:employeeId/session`.

The adapter must not send task-state commands as chat text. The adapter must not approve its own artifact or its own task.

## Explicitly out of scope

- Calling a private Muse or CUE URL.
- Storing a provider password or automating an MFA prompt.
- Marking an employee online because a provider account exists.
- Treating a simulated adapter as a native integration.

`packages/agent-client` exports `NATIVE_PROVIDER_STATUS = "unimplemented"`. A later change sets that only after a reviewed adapter runs against a real provider from an operator-held credential, in a separate milestone.
