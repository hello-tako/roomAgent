import {
  applyStagingBootstrap,
  bootstrapPlanDigest,
  PUBLIC_D1_DATABASE_ID,
  PUBLIC_DATABASE_NAME,
  PLACEHOLDER_D1_DATABASE_ID,
  STAGING_ACCOUNT_ID,
  STAGING_D1_DATABASE_ID,
  type BootstrapPlan,
} from "@ai-company/db";
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { stagingBootstrapEnabled } from "../src/staging-bootstrap-route";
import { createStudio } from "./helpers";

const TEAM = "https://roomagent-test.cloudflareaccess.com";
const AUD = "a".repeat(64);
const KID = "stage-c-key";
const SHA = "3528f923692b53c80559ba55a7101773e9a8bd1b";

let signer: CryptoKey;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function accessToken(claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: KID })));
  const payload = base64Url(
    new TextEncoder().encode(
      JSON.stringify({
        iss: TEAM,
        aud: [AUD],
        iat: now - 5,
        nbf: now - 5,
        exp: now + 300,
        type: "app",
        ...claims,
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signer,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  signer = pair.privateKey;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${TEAM}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [{ ...publicJwk, kid: KID, alg: "RS256", use: "sig" }] });
    }
    return realFetch(input, init);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

function plan(name: string, overrides: Partial<BootstrapPlan> = {}): BootstrapPlan {
  return {
    environment: "staging",
    execution: "local-simulator",
    accountId: STAGING_ACCOUNT_ID,
    databaseId: "11111111-2222-4333-8444-555555555555",
    databaseName: "local-simulator",
    schemaVersion: "0015",
    repositorySha: SHA,
    orgName: name,
    ownerDisplayName: `${name} owner`,
    operatorIdentityRef: `operator-record:${name.replaceAll(" ", "-")}`,
    issuer: TEAM,
    subject: `sub-${name.replaceAll(" ", "-")}`,
    email: `${name.replaceAll(" ", ".").toLowerCase()}@roomagent.test`,
    verificationSource: "cloudflare-access-operator-record",
    attestationRef: `ATTEST-${name.replaceAll(" ", "-")}`,
    approvalRef: `APPROVAL-${name.replaceAll(" ", "-")}`,
    expectedPreState: "uninitialized",
    ...overrides,
  };
}

async function orgCount(name: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM organizations WHERE name = ?`)
    .bind(name)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("staging owner bootstrap", () => {
  it("provisions one owner organization and does not duplicate it", async () => {
    const firstPlan = plan("roomAgent Staging Smoke");
    const digest = await bootstrapPlanDigest(firstPlan);
    const created = await applyStagingBootstrap(env.DB, firstPlan, {
      approvalDigest: digest,
      allowLocalSimulator: true,
    });
    expect(created.state).toBe("VERIFIED");
    expect(created.writes).toBeGreaterThan(0);
    expect(created.userId).toMatch(/^usr_[0-9a-f]{32}$/);
    expect(created.orgId).toMatch(/^org_[0-9a-f]{32}$/);
    expect(created.identityId).toMatch(/^hid_[0-9a-f]{32}$/);
    const roles = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM roles WHERE org_id = ? AND system_role = 1`,
    )
      .bind(created.orgId)
      .first<{ n: number }>();
    expect(roles?.n).toBe(7);

    const again = await applyStagingBootstrap(env.DB, firstPlan, {
      approvalDigest: digest,
      allowLocalSimulator: true,
    });
    expect(again).toMatchObject({
      state: "VERIFIED",
      writes: 0,
      userId: created.userId,
      orgId: created.orgId,
      identityId: created.identityId,
    });
    expect(await orgCount("roomAgent Staging Smoke")).toBe(1);
  });

  it("stops on a partial or conflicting organization and does not attach a new owner", async () => {
    const studio = await createStudio("Stage C partial");
    const conflicting = plan("Stage C partial");
    const before = await orgCount("Stage C partial");
    const outcome = await applyStagingBootstrap(env.DB, conflicting, {
      approvalDigest: await bootstrapPlanDigest(conflicting),
      allowLocalSimulator: true,
    });
    expect(outcome.state).toBe("BOOTSTRAP_STATE_CONFLICT");
    expect(outcome.writes).toBe(0);
    expect(await orgCount("Stage C partial")).toBe(before);
    expect(studio.org.createdByUserId).toMatch(/^usr_/);
  });

  it("rejects the public database, a placeholder, a missing attestation, and a changed subject", async () => {
    const publicTarget = plan("Stage C public", { databaseId: PUBLIC_D1_DATABASE_ID });
    expect(
      (
        await applyStagingBootstrap(env.DB, publicTarget, {
          approvalDigest: await bootstrapPlanDigest(publicTarget),
          allowLocalSimulator: true,
        })
      ).reason,
    ).toBe("TARGET_REJECTED");
    const placeholder = plan("Stage C placeholder", { databaseId: PLACEHOLDER_D1_DATABASE_ID });
    expect(
      (
        await applyStagingBootstrap(env.DB, placeholder, {
          approvalDigest: await bootstrapPlanDigest(placeholder),
          allowLocalSimulator: true,
        })
      ).reason,
    ).toBe("TARGET_REJECTED");
    const publicName = plan("Stage C public name", { databaseName: PUBLIC_DATABASE_NAME });
    expect(
      (
        await applyStagingBootstrap(env.DB, publicName, {
          approvalDigest: await bootstrapPlanDigest(publicName),
          allowLocalSimulator: true,
        })
      ).reason,
    ).toBe("TARGET_REJECTED");
    const missing = plan("Stage C missing", { attestationRef: "short" });
    expect(
      (
        await applyStagingBootstrap(env.DB, missing, {
          approvalDigest: await bootstrapPlanDigest(missing),
          allowLocalSimulator: true,
        })
      ).reason,
    ).toBe("ATTESTATION_MISSING");
    expect(await orgCount("Stage C public")).toBe(0);

    const original = plan("Stage C subject");
    const created = await applyStagingBootstrap(env.DB, original, {
      approvalDigest: await bootstrapPlanDigest(original),
      allowLocalSimulator: true,
    });
    expect(created.state).toBe("VERIFIED");
    const moved = plan("Stage C subject moved", {
      email: original.email,
      subject: "sub-other-person",
    });
    const denied = await applyStagingBootstrap(env.DB, moved, {
      approvalDigest: await bootstrapPlanDigest(moved),
      allowLocalSimulator: true,
    });
    expect(denied).toMatchObject({ state: "DENIED", reason: "IDENTITY_MISMATCH", writes: 0 });
    expect(await orgCount("Stage C subject moved")).toBe(0);
  });

  it("does not rewrite a disabled identity or authorize remote without the worker gate", async () => {
    const original = plan("Stage C disabled");
    const created = await applyStagingBootstrap(env.DB, original, {
      approvalDigest: await bootstrapPlanDigest(original),
      allowLocalSimulator: true,
    });
    expect(created.state).toBe("VERIFIED");
    await env.DB.prepare(`UPDATE human_identities SET status = 'disabled' WHERE id = ?`)
      .bind(created.identityId)
      .run();
    const disabled = await applyStagingBootstrap(env.DB, original, {
      approvalDigest: await bootstrapPlanDigest(original),
      allowLocalSimulator: true,
    });
    expect(disabled).toMatchObject({ state: "DENIED", reason: "IDENTITY_DISABLED", writes: 0 });

    const remote = plan("roomAgent Staging Smoke remote", {
      execution: "remote-staging",
      databaseId: STAGING_D1_DATABASE_ID,
      databaseName: "ai-company-os-staging",
      orgName: "roomAgent Staging Smoke",
    });
    const blocked = await applyStagingBootstrap(env.DB, remote, {
      approvalDigest: await bootstrapPlanDigest(remote),
    });
    expect(blocked.reason).toBe("REMOTE_NOT_AUTHORIZED");
    expect(stagingBootstrapEnabled(undefined)).toBe(false);
    expect(stagingBootstrapEnabled("enabled")).toBe(true);
  });

  it("issues a human session only for the mapped verified owner", async () => {
    const bodyPlan = plan("Stage C http");
    const digest = await bootstrapPlanDigest(bodyPlan);
    const response = await exports.default.fetch(
      "https://company.local/operator/staging-bootstrap",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-access-jwt-assertion": await accessToken({
            email: bodyPlan.email,
            sub: bodyPlan.subject,
          }),
          "x-bootstrap-approval-digest": digest,
        },
        body: JSON.stringify({ plan: bodyPlan }),
      },
    );
    expect(response.status).toBe(200);
    const created = await response.json<{ org_id: string; user_id: string; writes: number }>();
    expect(created.writes).toBeGreaterThan(0);

    const emailOnly = await exports.default.fetch(
      "https://company.local/operator/staging-bootstrap",
      {
        method: "POST",
        headers: { "cf-access-authenticated-user-email": bodyPlan.email },
        body: JSON.stringify({ plan: bodyPlan }),
      },
    );
    expect(emailOnly.status).toBe(401);

    const claimedOwner = await exports.default.fetch(
      "https://company.local/operator/staging-bootstrap",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-access-jwt-assertion": await accessToken({
            email: bodyPlan.email,
            sub: bodyPlan.subject,
          }),
          "x-bootstrap-approval-digest": digest,
        },
        body: JSON.stringify({ plan: bodyPlan, user_id: created.user_id }),
      },
    );
    expect(claimedOwner.status).toBe(400);

    const session = await exports.default.fetch(
      `https://company.local/orgs/${created.org_id}/human-sessions`,
      {
        method: "POST",
        headers: {
          "cf-access-jwt-assertion": await accessToken({
            email: bodyPlan.email,
            sub: bodyPlan.subject,
          }),
        },
      },
    );
    expect(session.status).toBe(201);
    const issued = await session.json<{ token: string; expires_at: string }>();
    expect(issued.token).toMatch(/^hum_[0-9a-f]{64}$/);
    expect(Date.parse(issued.expires_at) - Date.now()).toBeLessThanOrEqual(900_000);
    const stored = await env.DB.prepare(
      `SELECT token_hash FROM human_sessions WHERE org_id = ? AND user_id = ?`,
    )
      .bind(created.org_id, created.user_id)
      .first<{ token_hash: string }>();
    expect(stored?.token_hash).not.toBe(issued.token);

    const other = await createStudio("Stage C wrong org");
    const wrongOrg = await exports.default.fetch(
      `https://company.local/orgs/${other.org.id}/human-sessions`,
      {
        method: "POST",
        headers: {
          "cf-access-jwt-assertion": await accessToken({
            email: bodyPlan.email,
            sub: bodyPlan.subject,
          }),
        },
      },
    );
    expect(wrongOrg.status).toBe(403);
  });
});
