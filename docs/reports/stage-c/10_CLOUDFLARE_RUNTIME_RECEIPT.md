# Stage C Cloudflare runtime receipt

Evidence level: NOT_DEPLOYED. NOT_TESTED for remote bootstrap and business smoke.

This branch did not deploy a Worker, did not apply a migration, did not write D1, did not write R2, did not publish a queue message, and did not start a workflow.

| Item                           | Value                                                      | Evidence                       |
| ------------------------------ | ---------------------------------------------------------- | ------------------------------ |
| Account                        | `ef250a88911fd24073cb73d1c07e0218`                         | pinned, not re-mutated         |
| Public Worker                  | `ai-company-os-api` `a7acb953-ebae-46f8-9757-841100e121be` | untouched                      |
| Public hostname                | `ai.tungjp.store`                                          | untouched                      |
| Public D1                      | `a4b622e6-978b-4ce2-ad82-cd0eb1cc4387`                     | rejected by code               |
| Staging Worker                 | `ai-company-os-api-staging`                                | not deployed by this branch    |
| Staging version before Stage C | `3aeb3cbc-0f44-470c-af2c-30ab64d1bc55`                     | previous upload, still current |
| Staging hostname               | `api-staging.tungjp.store`                                 | unchanged                      |
| Staging D1                     | `a6b8c2f6-d697-442b-8374-5006246324b2`                     | no remote write                |
| Access application             | `8a141d2f-91a5-4cfc-bc8d-33aedfcec070`                     | unchanged                      |
| Local dry-run                  | Wrangler 4.148.0 `--dry-run: exiting now`                  | LOCALLY_TESTED                 |

`ROOMAGENT_STAGE_C_WORKER_DEPLOYED_VERIFIED` is not issued.
`ROOMAGENT_STAGE_C1_SYNTHETIC_BOOTSTRAP_VERIFIED` is not issued.
`ROOMAGENT_STAGE_C2_BUSINESS_SMOKE_VERIFIED` is not issued.
