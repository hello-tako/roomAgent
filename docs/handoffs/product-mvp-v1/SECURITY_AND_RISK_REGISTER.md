# Security and risk register

This pause does not accept open risks. F3 remains `UNRESOLVED_MEDIUM`.
F4 manifest consistency is not external owner trust. F5 heuristic credential
scanning is not full DLP.

No Cloudflare mutation, remote D1 write, secret change, Access change, or
deploy was performed.

## C1 baseline

Reviewed implementation `1c606c45cd397097cf3c951c4c07da0befb0affa` is the
second parent of main `11a1cab441462cc6087bae2f903dc2b5f1a49b56`.
Worker source pin `3909fada8747ae27ea71daf6da9481a7eb8d9eff` was not changed.
`handoff/c1-a2/operator/` and `BUNDLE_SHA256SUMS` have no diff on this branch.
Do not regenerate those manifests.

The worktree `/private/tmp/roomagent-pr9` is still the reviewed C1 checkout
`1c606c45`. Do not move it. `/private/tmp/roomagent-main-3909fada` stays
detached at the historical Worker SHA. The Documents checkout stays on
`feat/stage-c-bootstrap-smoke-v1`.

## Boundaries that the new code keeps

- Gateway authorization is server-side. The unfinished UI is not the policy
  source.
- Cross-organization human tokens are rejected. The company test covers a
  foreign token, a raw 64-hex bearer used as a human, role conflict, join
  scope escalation, second redeem, owner self-approval, employee approve
  without scope, foreign room membership, and revoked sessions.
- Those cases passed in the local control-plane run recorded in the evidence
  file. They are not a complete threat-model pass.
- Fixture enablement uses the request URL hostname plus an env flag that is
  absent from public and staging Wrangler configs.
- Idempotency keys and control-plane bodies are bounded. Replay stores the
  status and a bounded JSON body. Status >= 500 is not stored as success.
- Audit list omits the raw body column. Timeline details use a short
  whitelist.
- Join codes are not logged by the new routes. `POST /j/:token` still accepts
  a code in the URL for older clients. Prefer `POST /join`.

## Unresolved or incomplete

| Item                               | State                                                                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F3 operator trust                  | `UNRESOLVED_MEDIUM`. Not accepted.                                                                                                                               |
| Second human operator              | Blocked by trigger `human_session_owner` and the `runtime.bind` gate. No migration was added.                                                                    |
| Owner self-approval                | Still denied. Custom role path is the intended exception and needs review.                                                                                       |
| Browser XSS                        | No rendered chat yet, so no browser proof.                                                                                                                       |
| Cookie CSRF                        | New design uses memory bearers, not cookies. Not yet present in a built UI.                                                                                      |
| Expired join in the browser        | Not tested in Playwright. TTL rules exist on the server.                                                                                                         |
| WebSocket resync beyond 100 events | `RESYNC_REQUIRED` exists. `initialSeq` is the client escape hatch and is lightly tested.                                                                         |
| Replay of a failed mutation        | Same idempotency key returns the stored 403. Callers must use a new key.                                                                                         |
| Rate limits                        | Per isolate for anonymous join and fixture. Per actor inside OrganizationDO for control-plane mutations. Not an account-wide limiter.                            |
| `r2_key` on create responses       | Still returned by the existing artifact route. List responses omit it. The UI must not display it.                                                               |
| Native Muse/CUE                    | Unimplemented. Do not simulate a provider session.                                                                                                               |
| Lockfile and new packages          | Playwright and React are now dependencies even though the UI is unfinished. Review the lockfile diff. No deploy credentials were added.                          |
| CI dry-run                         | Existing `check` job may run `wrangler deploy --dry-run` on push. That is not permission to deploy.                                                              |
| Full secret scan                   | Pause scan looked for token shapes in the new trees. Header name `cf-access-jwt-assertion` appears in source and docs. No live token was found. This is not DLP. |

## Deployment risk

This branch must not be merged or deployed. Staging and production Workers,
D1 databases, Access, and release pins stay as they were. Successful local
tests are not runtime certification.

## Technical debt

- `apps/api/src/control-plane.ts` is large. Split it only when behavior is
  covered by tests.
- `docs/product/` was written before the UI and over-claims screens.
- `taskCommand` in the company test no longer attaches the response body to
  the assertion. Keep it that way so failures do not print tokens.
- Debug logging of join codes or bearers must not be reintroduced.
