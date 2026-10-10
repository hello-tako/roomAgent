# Stage C identity attestation

Evidence level: LOCALLY_TESTED for JWT verification and the mapping rules. The real operator subject is NOT_TESTED. No JWT, email, or subject is stored in this repository.

## Flow that already existed

```text
Access login
  -> RS256 JWT in Cf-Access-Jwt-Assertion
  -> verifyAccessJwt
  -> human_identities lookup by issuer and subject
  -> email must match
  -> status must be active
  -> OrganizationDO owner session
  -> token hash and an append-only audit row
```

The bootstrap route uses the same `verifyAccessJwt`. The plan issuer, subject, and lower-case email must equal the verified token. A body field `user_id`, `owner_id`, or `userId` is rejected. The client does not choose the owner id.

## Attestation fields

The plan carries `issuer`, `subject`, `email`, `verificationSource`, `attestationRef`, and `approvalRef`. `verificationSource` must be `cloudflare-access-operator-record`. The issuer must be an `https://*.cloudflareaccess.com` team host. References match an operator-record pattern and must not be an email address. `operatorIdentityRef` must not equal the Access subject. The email must already be lower case.

The database stores issuer, subject, email, and `attestation_ref`. It does not store the JWT. Public receipts in the operator script do not print a subject or an email. Tests use `@roomagent.test` addresses and synthetic subjects.

## Session rules covered locally

- Missing or email-header-only assertion: 401 `ACCESS_IDENTITY_INVALID`
- Mapped owner: 201, token prefix `hum_`, expiry within 900 seconds, stored `token_hash` differs from the token
- Same token against another organization: 403
- Disabled identity: `IDENTITY_DISABLED`, no rewrite
- Revocation of an issued session: existing `apps/api/test/human-bootstrap.test.ts` expects the audit pair `issued`, `revoked`

The real Cloudflare operator attestation is a later C1 input. It is not hardcoded here. MFA stays as the human owner left it. This branch does not change Access policy.
