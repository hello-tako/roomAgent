import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  copyFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  ACCESS_AUDIENCE,
  ACCESS_CERTS_URL,
  ACCESS_ISSUER,
  validateAccessJwt,
  verifyAccessJwt,
} from "./attest-access-identity.mjs";

const NOW_SECONDS = Math.floor(Date.now() / 1000);
const EMAIL = "owner@example.test";
const SUBJECT = "private-subject-canary";
const EMAIL_SHA256 = createHash("sha256").update(EMAIL).digest("hex");
const PRIMARY_PAIR = generateKeyPairSync("rsa", { modulusLength: 2048 });
const OTHER_PAIR = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIMARY_JWK = {
  ...PRIMARY_PAIR.publicKey.export({ format: "jwk" }),
  alg: "RS256",
  kid: "test-key-primary",
  use: "sig",
};
const JWKS = { keys: [PRIMARY_JWK] };
const SCRIPT_PATH = fileURLToPath(new URL("./attest-access-identity.mjs", import.meta.url));

function b64url(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString(
    "base64url",
  );
}

function validPayload(overrides = {}) {
  return {
    iss: ACCESS_ISSUER,
    aud: [ACCESS_AUDIENCE],
    exp: NOW_SECONDS + 600,
    nbf: NOW_SECONDS - 60,
    iat: NOW_SECONDS - 60,
    type: "app",
    email: ` ${EMAIL.toUpperCase()} `,
    sub: SUBJECT,
    ...overrides,
  };
}

function expectedIdentityRecord(overrides = {}) {
  return {
    issuer: ACCESS_ISSUER,
    subject: SUBJECT,
    email: EMAIL,
    verificationSource: "cloudflare-access-operator-record",
    attestationRef: `c1att-${"1".repeat(32)}`,
    emailBinding: "MATCHED",
    verifiedAt: new Date((NOW_SECONDS - 60) * 1000).toISOString(),
    expiresAt: new Date((NOW_SECONDS + 600) * 1000).toISOString(),
    verificationMethod: "cloudflare-access-application-jwt-rs256",
    ...overrides,
  };
}

function signedToken({
  payload = validPayload(),
  header = {},
  signer = PRIMARY_PAIR.privateKey,
} = {}) {
  const jwtHeader = {
    alg: "RS256",
    kid: PRIMARY_JWK.kid,
    typ: "JWT",
    ...header,
  };
  const headerPart = b64url(jwtHeader);
  const payloadPart = b64url(payload);
  const signingInput = `${headerPart}.${payloadPart}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput, "ascii"), signer).toString(
    "base64url",
  );
  return `${signingInput}.${signature}`;
}

function assertCode(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

function validate(token, options = {}) {
  return validateAccessJwt(token, {
    jwks: JWKS,
    nowSeconds: NOW_SECONDS,
    ...options,
  });
}

function response(status, body, options = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    redirected: options.redirected ?? false,
    url: options.url ?? ACCESS_CERTS_URL,
    text: options.text ?? (async () => body),
  };
}

function makeCliFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "access-attestation-test-"));
  const operatorDir = join(root, "operator");
  const privateDir = join(operatorDir, "private");
  const scriptPath = join(operatorDir, "attest-access-identity.mjs");
  const preloadPath = join(root, "mock-fetch.mjs");
  const tracePath = join(root, "fetch-trace.json");
  mkdirSync(operatorDir, { recursive: true });
  copyFileSync(SCRIPT_PATH, scriptPath);
  writeFileSync(
    preloadPath,
    `import { writeFileSync } from "node:fs";
const expectedUrl = ${JSON.stringify(ACCESS_CERTS_URL)};
const tracePath = ${JSON.stringify(tracePath)};
const body = ${JSON.stringify(JSON.stringify(JWKS))};
globalThis.fetch = async (url, options) => {
  const request = { url: String(url), options };
  writeFileSync(tracePath, JSON.stringify(request), { mode: 0o600 });
  if (String(url) !== expectedUrl) throw new Error("unapproved endpoint");
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
};
`,
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, operatorDir, privateDir, scriptPath, preloadPath, tracePath };
}

function runCli(fixture, args, input) {
  return spawnSync(
    process.execPath,
    ["--import", fixture.preloadPath, fixture.scriptPath, ...args],
    {
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
      input,
      timeout: 15_000,
    },
  );
}

function createExpectedEmailFile(fixture) {
  mkdirSync(fixture.privateDir, { recursive: true, mode: 0o700 });
  const path = join(fixture.privateDir, "expected-email.sha256");
  writeFileSync(path, `${EMAIL_SHA256}\n`, { mode: 0o600 });
  return path;
}

function createExpectedIdentityFile(fixture, record = expectedIdentityRecord()) {
  mkdirSync(fixture.privateDir, { recursive: true, mode: 0o700 });
  const path = join(fixture.privateDir, "c1-access-attestation.json");
  writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return path;
}

test("validates RS256 and binds the normalized email hash and exact subject", () => {
  const identity = validate(signedToken(), {
    expectedEmailSha256: EMAIL_SHA256,
    expectedSubject: SUBJECT,
  });
  assert.deepEqual(identity, {
    issuer: ACCESS_ISSUER,
    subject: SUBJECT,
    email: EMAIL,
    emailSha256: EMAIL_SHA256,
    expiresAt: new Date((NOW_SECONDS + 600) * 1000).toISOString(),
    emailBinding: "MATCHED",
  });
});

test("audience membership accepts the pinned audience and rejects malformed audience lists", () => {
  assert.equal(
    validate(signedToken({ payload: validPayload({ aud: ["other-app", ACCESS_AUDIENCE] }) })).email,
    EMAIL,
  );
  for (const aud of ["other-app", [], [ACCESS_AUDIENCE, 7], null]) {
    assertCode(
      () => validate(signedToken({ payload: validPayload({ aud }) })),
      "AUDIENCE_MISMATCH",
    );
  }
});

test("rejects malformed token segments, base64url, JSON, and JWT headers", async (t) => {
  const payloadPart = b64url(validPayload());
  const cases = [
    ["wrong part count", "one.two"],
    ["bad header alphabet", `*.${payloadPart}.AQ`],
    [
      "non-canonical signature encoding",
      `${b64url({ alg: "RS256", kid: PRIMARY_JWK.kid, typ: "JWT" })}.${payloadPart}.AR`,
    ],
    ["invalid header JSON", `${b64url("{")}.${payloadPart}.AQ`],
    ["header array", `${b64url([])}.${payloadPart}.AQ`],
    [
      "invalid payload JSON",
      `${b64url({ alg: "RS256", kid: PRIMARY_JWK.kid, typ: "JWT" })}.${b64url("{")}.AQ`,
    ],
    [
      "payload array",
      `${b64url({ alg: "RS256", kid: PRIMARY_JWK.kid, typ: "JWT" })}.${b64url([])}.AQ`,
    ],
    [
      "empty signature",
      `${b64url({ alg: "RS256", kid: PRIMARY_JWK.kid, typ: "JWT" })}.${payloadPart}.`,
    ],
    [
      "unsupported header extension",
      signedToken({ header: { jku: "https://attacker.invalid/keys" } }),
    ],
    ["missing JWT type", signedToken({ header: { typ: undefined } })],
    ["invalid key id", signedToken({ header: { kid: "bad.kid" } })],
  ];
  for (const [name, token] of cases) {
    await t.test(name, () =>
      assertCode(
        () => validate(token),
        name === "unsupported algorithm" ? "ALG_REJECTED" : "TOKEN_MALFORMED",
      ),
    );
  }
  await t.test("unsupported algorithm", () =>
    assertCode(() => validate(signedToken({ header: { alg: "HS256" } })), "ALG_REJECTED"),
  );
});

test("pins issuer and rejects service or missing token types", async (t) => {
  const cases = [
    ["wrong issuer", { iss: `${ACCESS_ISSUER}/` }, "ISSUER_MISMATCH"],
    ["service token", { type: "org" }, "TOKEN_TYPE_REJECTED"],
    ["missing token type", { type: undefined }, "TOKEN_TYPE_REJECTED"],
  ];
  for (const [name, claims, code] of cases) {
    await t.test(name, () =>
      assertCode(() => validate(signedToken({ payload: validPayload(claims) })), code),
    );
  }
});

test("enforces expiration, not-before, issued-at, and the bounded clock skew", async (t) => {
  const cases = [
    ["expired at the current second", { exp: NOW_SECONDS }, "TOKEN_EXPIRED"],
    ["non-numeric expiration", { exp: String(NOW_SECONDS + 60) }, "TOKEN_EXPIRY_INVALID"],
    ["invalid not-before", { nbf: "later" }, "TOKEN_NOT_YET_VALID"],
    ["not-before beyond skew", { nbf: NOW_SECONDS + 61 }, "TOKEN_NOT_YET_VALID"],
    ["not-before at expiration", { nbf: NOW_SECONDS + 600 }, "TOKEN_NOT_YET_VALID"],
    ["invalid issued-at", { iat: "later" }, "TOKEN_ISSUED_AT_INVALID"],
    ["issued-at beyond skew", { iat: NOW_SECONDS + 61 }, "TOKEN_ISSUED_AT_INVALID"],
    ["issued-at at expiration", { iat: NOW_SECONDS + 600 }, "TOKEN_ISSUED_AT_INVALID"],
  ];
  for (const [name, claims, code] of cases) {
    await t.test(name, () =>
      assertCode(() => validate(signedToken({ payload: validPayload(claims) })), code),
    );
  }
  await t.test("accepts not-before and issued-at exactly within skew", () => {
    const identity = validate(
      signedToken({ payload: validPayload({ nbf: NOW_SECONDS + 60, iat: NOW_SECONDS + 60 }) }),
    );
    assert.equal(identity.subject, SUBJECT);
  });
});

test("requires a human email and exact subject/hash binding", async (t) => {
  const missingEmail = validPayload();
  delete missingEmail.email;
  const missingSubject = validPayload();
  delete missingSubject.sub;
  const cases = [
    ["missing email", missingEmail, "IDENTITY_FIELDS_MISSING"],
    ["missing subject", missingSubject, "IDENTITY_FIELDS_MISSING"],
    ["invalid email", validPayload({ email: "not-an-email" }), "EMAIL_INVALID"],
    ["empty subject", validPayload({ sub: "" }), "SUBJECT_INVALID"],
    ["long subject", validPayload({ sub: "s".repeat(129) }), "SUBJECT_INVALID"],
  ];
  for (const [name, claims, code] of cases) {
    await t.test(name, () => assertCode(() => validate(signedToken({ payload: claims })), code));
  }
  await t.test("compares subject without normalization", () =>
    assertCode(
      () => validate(signedToken(), { expectedSubject: SUBJECT.toUpperCase() }),
      "SUBJECT_MISMATCH",
    ),
  );
  await t.test("compares email hashes after normalization", () =>
    assertCode(
      () => validate(signedToken(), { expectedEmailSha256: "0".repeat(64) }),
      "EMAIL_MISMATCH",
    ),
  );
  await t.test("rejects an invalid expected email digest", () =>
    assertCode(
      () => validate(signedToken(), { expectedEmailSha256: "not-a-digest" }),
      "EXPECTED_EMAIL_HASH_INVALID",
    ),
  );
});

test("rejects unknown and mismatched signing keys or invalid signatures", async (t) => {
  await t.test("unknown kid", () =>
    assertCode(() => validate(signedToken({ header: { kid: "unknown-key" } })), "KID_UNKNOWN"),
  );
  await t.test("same kid with another RSA public key", () =>
    assertCode(
      () =>
        validate(signedToken({ signer: OTHER_PAIR.privateKey }), {
          jwks: { keys: [PRIMARY_JWK] },
        }),
      "SIGNATURE_INVALID",
    ),
  );
  await t.test("tampered signature", () => {
    const token = signedToken();
    const [header, payload] = token.split(".");
    assertCode(
      () => validate(`${header}.${payload}.${b64url("not-a-signature")}`),
      "SIGNATURE_INVALID",
    );
  });
});

test("fails closed on untrusted or malformed JWKS entries", async (t) => {
  const leadingZeroModulus = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(PRIMARY_JWK.n, "base64url"),
  ]).toString("base64url");
  const evenModulusBytes = Buffer.from(PRIMARY_JWK.n, "base64url");
  evenModulusBytes[evenModulusBytes.length - 1] &= 0xfe;
  const invalidSets = [
    ["missing keys", {}],
    ["non-array keys", { keys: {} }],
    ["empty keys", { keys: [] }],
    ["wrong algorithm", { keys: [{ ...PRIMARY_JWK, alg: "PS256" }] }],
    ["missing algorithm", { keys: [{ ...PRIMARY_JWK, alg: undefined }] }],
    ["wrong key type", { keys: [{ ...PRIMARY_JWK, kty: "EC" }] }],
    ["wrong key use", { keys: [{ ...PRIMARY_JWK, use: "enc" }] }],
    ["missing key use", { keys: [{ ...PRIMARY_JWK, use: undefined }] }],
    ["invalid kid", { keys: [{ ...PRIMARY_JWK, kid: "bad.kid" }] }],
    ["malformed modulus", { keys: [{ ...PRIMARY_JWK, n: "%%" }] }],
    ["leading-zero modulus", { keys: [{ ...PRIMARY_JWK, n: leadingZeroModulus }] }],
    ["even modulus", { keys: [{ ...PRIMARY_JWK, n: evenModulusBytes.toString("base64url") }] }],
    ["invalid exponent", { keys: [{ ...PRIMARY_JWK, e: b64url(Buffer.from([2])) }] }],
    ["private key material", { keys: [{ ...PRIMARY_JWK, d: "private-canary" }] }],
    ["wrong key operations", { keys: [{ ...PRIMARY_JWK, key_ops: ["sign"] }] }],
    ["duplicate kid", { keys: [PRIMARY_JWK, PRIMARY_JWK] }],
    ["unknown response property", { ...JWKS, unexpected: true }],
    [
      "malformed public certificate metadata",
      { ...JWKS, public_cert: { kid: "test-key-primary", cert: 3 } },
    ],
  ];
  for (const [name, jwks] of invalidSets) {
    await t.test(name, () =>
      assertCode(() => validate(signedToken(), { jwks }), "CERTS_INVALID_SCHEMA"),
    );
  }
});

test("fetches only the pinned issuer certs endpoint without transmitting the JWT", async () => {
  const token = signedToken();
  const calls = [];
  const identity = await verifyAccessJwt(token, {
    fetchImpl: async (...args) => {
      calls.push(args);
      return response(200, JSON.stringify(JWKS));
    },
    now: () => NOW_SECONDS * 1000,
    expectedEmailSha256: EMAIL_SHA256,
  });
  assert.equal(identity.emailBinding, "MATCHED");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    ACCESS_CERTS_URL,
    { method: "GET", headers: { accept: "application/json" }, redirect: "error" },
  ]);
  assert.ok(!JSON.stringify(calls[0]).includes(token));
});

test("rejects certificate HTTP failures", async (t) => {
  for (const status of [401, 403, 404, 409, 429, 500]) {
    await t.test(`HTTP ${status}`, async () => {
      await assert.rejects(
        verifyAccessJwt(signedToken(), {
          fetchImpl: async () => response(status, "private-response-canary"),
          now: () => NOW_SECONDS * 1000,
        }),
        (error) =>
          error.code === "CERTS_UNAVAILABLE" && !error.message.includes("private-response-canary"),
      );
    });
  }
});

test("rejects certificate redirects and sanitizes network errors", async (t) => {
  await t.test("HTTP redirect", async () => {
    await assert.rejects(
      verifyAccessJwt(signedToken(), {
        fetchImpl: async () => response(302, "", { url: "https://attacker.invalid/certs" }),
        now: () => NOW_SECONDS * 1000,
      }),
      (error) => error.code === "CERTS_REDIRECT_REJECTED",
    );
  });
  await t.test("redirected successful response", async () => {
    await assert.rejects(
      verifyAccessJwt(signedToken(), {
        fetchImpl: async () => response(200, JSON.stringify(JWKS), { redirected: true }),
        now: () => NOW_SECONDS * 1000,
      }),
      (error) => error.code === "CERTS_REDIRECT_REJECTED",
    );
  });
  await t.test("response URL mismatch", async () => {
    await assert.rejects(
      verifyAccessJwt(signedToken(), {
        fetchImpl: async () =>
          response(200, JSON.stringify(JWKS), { url: "https://attacker.invalid/certs" }),
        now: () => NOW_SECONDS * 1000,
      }),
      (error) => error.code === "CERTS_REDIRECT_REJECTED",
    );
  });
  await t.test("fetch exception text is not exposed", async () => {
    await assert.rejects(
      verifyAccessJwt(signedToken(), {
        fetchImpl: async () => {
          throw new Error("network-private-canary");
        },
        now: () => NOW_SECONDS * 1000,
      }),
      (error) =>
        error.code === "CERTS_UNAVAILABLE" && !error.message.includes("network-private-canary"),
    );
  });
});

test("rejects malformed certificate JSON and schemas", async (t) => {
  const cases = [
    ["malformed JSON", "{", "CERTS_INVALID_JSON"],
    ["oversized JSON", " ".repeat(64 * 1024 + 1), "CERTS_INVALID_JSON"],
    ["unexpected JSON shape", "[]", "CERTS_INVALID_SCHEMA"],
    ["missing key list", JSON.stringify({ public_certs: [] }), "CERTS_INVALID_SCHEMA"],
    [
      "bad JWK schema",
      JSON.stringify({ keys: [{ kid: "key", kty: "RSA" }] }),
      "CERTS_INVALID_SCHEMA",
    ],
  ];
  for (const [name, body, code] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        verifyAccessJwt(signedToken(), {
          fetchImpl: async () => response(200, body),
          now: () => NOW_SECONDS * 1000,
        }),
        (error) => error.code === code,
      );
    });
  }
});

test("rejects an untrusted JWT key URL without making a request", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    verifyAccessJwt(signedToken({ header: { jku: "https://attacker.invalid/keys" } }), {
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("unexpected request");
      },
      now: () => NOW_SECONDS * 1000,
    }),
    (error) => error.code === "TOKEN_MALFORMED",
  );
  assert.equal(fetchCalls, 0);
});

test("CLI reads JWT from stdin, writes a 0600 private record, and emits only the receipt", (t) => {
  const fixture = makeCliFixture(t);
  const expectedFile = createExpectedEmailFile(fixture);
  const identityFile = createExpectedIdentityFile(fixture);
  const outputPath = join(fixture.privateDir, "c1-access-attestation-fresh.json");
  const token = signedToken();
  const result = runCli(
    fixture,
    [
      "--private-out",
      outputPath,
      "--expected-email-sha256-file",
      expectedFile,
      "--expected-identity-file",
      identityFile,
    ],
    `${token}\n`,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.identity_attestation_status, "VERIFIED");
  assert.equal(receipt.email_binding, "MATCHED");
  assert.equal(receipt.verification_method, "cloudflare-access-application-jwt-rs256");
  assert.ok(!result.stdout.includes(token));
  assert.ok(!result.stdout.includes(EMAIL));
  assert.ok(!result.stdout.includes(SUBJECT));

  const stat = lstatSync(outputPath);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.mode & 0o777, 0o600);
  const record = JSON.parse(readFileSync(outputPath, "utf8"));
  assert.deepEqual(Object.keys(record), [
    "issuer",
    "subject",
    "email",
    "verificationSource",
    "attestationRef",
    "emailBinding",
    "verifiedAt",
    "expiresAt",
    "verificationMethod",
  ]);
  assert.equal(record.issuer, ACCESS_ISSUER);
  assert.equal(record.subject, SUBJECT);
  assert.equal(record.email, EMAIL);
  assert.equal(record.emailBinding, "MATCHED");
  assert.equal(record.attestationRef, receipt.attestation_reference);

  const trace = readFileSync(fixture.tracePath, "utf8");
  assert.ok(!trace.includes(token));
  assert.ok(!trace.includes(EMAIL));
  assert.ok(!trace.includes(SUBJECT));
  assert.deepEqual(JSON.parse(trace), {
    url: ACCESS_CERTS_URL,
    options: { method: "GET", headers: { accept: "application/json" }, redirect: "error" },
  });
});

test("CLI binds subject and normalized email to the private baseline identity record", (t) => {
  const fixture = makeCliFixture(t);
  const outputPath = join(fixture.privateDir, "fresh.json");
  const baseline = createExpectedIdentityFile(
    fixture,
    expectedIdentityRecord({ subject: "other-subject" }),
  );
  let result = runCli(
    fixture,
    ["--private-out", outputPath, "--expected-identity-file", baseline],
    signedToken(),
  );
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), { identity_attestation_status: "SUBJECT_MISMATCH" });
  assert.ok(!result.stdout.includes(SUBJECT));
  assert.equal(lstatSync(outputPath, { throwIfNoEntry: false }), undefined);

  rmSync(fixture.tracePath, { force: true });
  const otherFixture = makeCliFixture(t);
  const emailMismatchBaseline = createExpectedIdentityFile(
    otherFixture,
    expectedIdentityRecord({ email: "different@example.test" }),
  );
  result = runCli(
    otherFixture,
    [
      "--private-out",
      join(otherFixture.privateDir, "fresh.json"),
      "--expected-identity-file",
      emailMismatchBaseline,
    ],
    signedToken(),
  );
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), { identity_attestation_status: "EMAIL_MISMATCH" });
  assert.ok(!result.stdout.includes(EMAIL));
});

test("CLI rejects malformed, untrusted, or overly permissive expected identity records", (t) => {
  const fixture = makeCliFixture(t);
  const outputPath = join(fixture.privateDir, "fresh.json");
  const malformed = createExpectedIdentityFile(fixture, { issuer: ACCESS_ISSUER });
  let result = runCli(
    fixture,
    ["--private-out", outputPath, "--expected-identity-file", malformed],
    signedToken(),
  );
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), {
    identity_attestation_status: "EXPECTED_IDENTITY_INVALID",
  });
  assert.ok(!result.stdout.includes(EMAIL));
  assert.equal(lstatSync(fixture.tracePath, { throwIfNoEntry: false }), undefined);

  const permissive = createExpectedIdentityFile(fixture, expectedIdentityRecord());
  chmodSync(permissive, 0o644);
  result = runCli(
    fixture,
    ["--private-out", outputPath, "--expected-identity-file", permissive],
    signedToken(),
  );
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), {
    identity_attestation_status: "EXPECTED_IDENTITY_INVALID",
  });

  const target = join(fixture.root, "baseline.json");
  writeFileSync(target, JSON.stringify(expectedIdentityRecord()), { mode: 0o600 });
  const link = join(fixture.privateDir, "linked-baseline.json");
  symlinkSync(target, link);
  result = runCli(
    fixture,
    ["--private-out", outputPath, "--expected-identity-file", link],
    signedToken(),
  );
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), {
    identity_attestation_status: "EXPECTED_IDENTITY_INVALID",
  });
  assert.equal(lstatSync(outputPath, { throwIfNoEntry: false }), undefined);

  const outside = join(fixture.root, "outside-baseline.json");
  writeFileSync(outside, JSON.stringify(expectedIdentityRecord()), { mode: 0o600 });
  result = runCli(
    fixture,
    ["--private-out", outputPath, "--expected-identity-file", outside],
    signedToken(),
  );
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), {
    identity_attestation_status: "EXPECTED_IDENTITY_INVALID",
  });
});

test("CLI reports a non-zero sanitized status for invalid stdin JWT", (t) => {
  const fixture = makeCliFixture(t);
  const outputPath = join(fixture.privateDir, "invalid.json");
  const result = runCli(fixture, ["--private-out", outputPath], "jwt-private-canary");

  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { identity_attestation_status: "TOKEN_MALFORMED" });
  assert.ok(!result.stdout.includes("jwt-private-canary"));
  assert.equal(lstatSync(fixture.tracePath, { throwIfNoEntry: false }), undefined);
});

test("CLI sanitizes claim failures and does not leave a private record", (t) => {
  const fixture = makeCliFixture(t);
  const expectedFile = createExpectedEmailFile(fixture);
  const outputPath = join(fixture.privateDir, "rejected.json");
  const token = signedToken({ payload: validPayload({ aud: ["wrong-audience"] }) });
  const result = runCli(
    fixture,
    ["--private-out", outputPath, "--expected-email-sha256-file", expectedFile],
    token,
  );

  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { identity_attestation_status: "AUDIENCE_MISMATCH" });
  assert.ok(!result.stdout.includes(token));
  assert.ok(!result.stdout.includes(EMAIL));
  assert.equal(lstatSync(outputPath, { throwIfNoEntry: false }), undefined);
});

test("CLI rejects outside paths, symlinks, and existing files without removing them", (t) => {
  const fixture = makeCliFixture(t);
  const outsidePath = join(fixture.root, "outside.json");
  let result = runCli(fixture, ["--private-out", outsidePath], "unused");
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), {
    identity_attestation_status: "PRIVATE_PATH_REJECTED",
  });

  createExpectedEmailFile(fixture);
  const existingPath = join(fixture.privateDir, "existing.json");
  result = runCli(fixture, ["--private-out", existingPath], signedToken());
  assert.equal(result.status, 0, result.stderr);
  const original = readFileSync(existingPath, "utf8");
  result = runCli(fixture, ["--private-out", existingPath], "unused");
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), {
    identity_attestation_status: "PRIVATE_PATH_EXISTS",
  });
  assert.equal(readFileSync(existingPath, "utf8"), original);

  const target = join(fixture.root, "symlink-target.txt");
  const link = join(fixture.privateDir, "linked.json");
  writeFileSync(target, "private-target-canary");
  symlinkSync(target, link);
  result = runCli(fixture, ["--private-out", link], "unused");
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), {
    identity_attestation_status: "PRIVATE_PATH_REJECTED",
  });
  assert.equal(readFileSync(target, "utf8"), "private-target-canary");
});

test("CLI rejects a symlinked private directory", (t) => {
  const fixture = makeCliFixture(t);
  const target = join(fixture.root, "external-private");
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, fixture.privateDir);
  const result = runCli(
    fixture,
    ["--private-out", join(fixture.privateDir, "record.json")],
    "unused",
  );

  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), {
    identity_attestation_status: "PRIVATE_PATH_REJECTED",
  });
  assert.equal(lstatSync(join(target, "record.json"), { throwIfNoEntry: false }), undefined);
});
