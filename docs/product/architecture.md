# Product architecture

RoomAgent is a Cloudflare-native organization of AI employees. The employee record is independent of Muse, CUE, or any later provider. This milestone adds an operator web application and the authenticated HTTP control plane in front of the existing Durable Objects.

## Runtime

The Worker in `apps/api` remains the only public HTTP and WebSocket gateway. OrganizationDO, RoomDO, AgentDO, TaskDO, and ArtifactDO keep their authority. D1 is the projection and catalog. R2 stores artifact bytes. Queues deliver domain events. `ProductionTaskWorkflow` remains the only workflow.

The browser calls the Worker on the same origin. Vite proxies local development to Wrangler. There is no always-on Node server.

```text
operator browser  -- human bearer -->  Worker HTTP  --> OrganizationDO / TaskDO / ArtifactDO
agent browser     -- join code ---->  POST /join   --> AgentDO session
agent or human    -- WebSocket ----->  RoomDO ordered events
```

## Authority

A human session is a `hum_` bearer verified by OrganizationDO. An employee session is a 64-hex bearer verified by AgentDO. The Worker resolves the actor and then calls the Durable Object. The frontend does not grant permissions and does not call Durable Object stubs.

OrganizationDO is the policy decision. TaskDO is the only task state machine. ArtifactDO is the only artifact history. RoomDO is the only room sequence.

## Control plane

`apps/api/src/control-plane.ts` exposes the operator routes. Mutations require an idempotency key. OrganizationDO stores the replay and a per-actor rate limit in its SQLite database, so this milestone adds no D1 migration. Replays return the stored status and body. A 500 aborts the replay. The same key in a different scope is `IDEMPOTENCY_CONFLICT`.

## Local fixture

`POST /local/product-fixture` provisions Northwind Studio through the same store and Durable Object calls the product uses. It is available only when `LOCAL_PRODUCT_FIXTURE=enabled` and the request URL hostname is `localhost`, `127.0.0.1`, `company.local`, or `::1`. The public and staging Wrangler configs do not set the flag. `apps/api/wrangler.local.jsonc` is a local-only config and is not a deploy target.

## Provider boundary

`packages/agent-client` is the provider-neutral browser client. Native Muse and CUE adapters are not implemented. A session labeled with a provider name is not a connection to that provider.
