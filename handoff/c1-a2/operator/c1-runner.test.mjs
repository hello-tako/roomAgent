// Local tests for c1-runner.mjs. Every endpoint is mocked. No network, no real secret.
// Run: node --test operator/c1-runner.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  cpSync,
  chmodSync,
  symlinkSync,
  readdirSync,
  renameSync,
  truncateSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readPrivateFile, writePrivateExclusive } from "./runtime-io.mjs";
import {
  ACCESS_AUDIENCE,
  MAX_ATTESTATION_AGE_SECONDS,
  validateAccessJwt,
} from "./attest-access-identity.mjs";
import {
  REAL_CONFIG,
  Redactor,
  Stop,
  run,
  makeCf,
  d1State,
  canonicalPlan,
  sha256hex,
  bindingsHash,
  buildW1Body,
  assertReadOnlySql,
  parseApproval,
  validatePlan,
} from "./c1-runner.mjs";

const BIND18 = JSON.parse(
  readFileSync(new URL("./fixtures/bindings18.json", import.meta.url), "utf8"),
);
const MODULE_B64 = "ZHVtbXktbW9kdWxlLWNvbnRlbnQ="; // dummy, not the real bundle
const FAKE = {
  issuer: REAL_CONFIG.issuer,
  subject: "test-subject-0001",
  email: "operator@example.test",
};
const API_TOKEN = "TESTAPITOKEN_abcdefghijklmnopqrstuvwxyz012345";
const NOW_SECONDS = 1_800_000_000;
const TOKEN_PAIR = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TOKEN_JWK = {
  ...TOKEN_PAIR.publicKey.export({ format: "jwk" }),
  alg: "RS256",
  kid: "runner-test-key",
  use: "sig",
};
function signedAccessJwt(overrides = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: TOKEN_JWK.kid, typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: FAKE.issuer,
      aud: [ACCESS_AUDIENCE],
      type: "app",
      sub: FAKE.subject,
      email: FAKE.email,
      iat: NOW_SECONDS - 60,
      nbf: NOW_SECONDS - 60,
      exp: NOW_SECONDS + 3600,
      ...overrides,
    }),
  ).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), TOKEN_PAIR.privateKey).toString("base64url")}`;
}
const JWT = signedAccessJwt();
const IMPLEMENTATION_SHA = "a".repeat(40);
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function regenerateManifests(bundle) {
  const files = [];
  const visit = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (relative === "operator/private") continue;
      if (entry.isDirectory()) visit(join(directory, entry.name), `${relative}/`);
      else files.push(relative);
    }
  };
  visit(bundle);
  const manifest = (paths) =>
    paths
      .sort()
      .map((path) => `${sha256hex(readFileSync(join(bundle, path)))}  ${path}\n`)
      .join("");
  const operator = files.filter(
    (path) => path.startsWith("operator/") && path !== "operator/SHA256SUMS",
  );
  writeFileSync(
    join(bundle, "operator/SHA256SUMS"),
    manifest([...operator, "19_W1_REQUEST_BODY_PLACEHOLDER.json"]),
  );
  writeFileSync(
    join(bundle, "BUNDLE_SHA256SUMS"),
    manifest(files.filter((path) => path !== "BUNDLE_SHA256SUMS")),
  );
  return sha256hex(readFileSync(join(bundle, "BUNDLE_SHA256SUMS")));
}

function approvalText(cfg, bundleDigest) {
  return [
    `action=${cfg.action}`,
    `approval_request_ref=${cfg.approvalRef}`,
    `canonical_plan_digest=${cfg.digest}`,
    `source_sha=${cfg.sourceSha}`,
    `base_version=${cfg.baseVersion}`,
    `base_deployment=${cfg.baseDeployment}`,
    `account_id=${cfg.accountId}`,
    `worker_id=${cfg.workerId}`,
    `worker=${cfg.worker}`,
    `d1=${cfg.d1}`,
    "secret_transport=A2",
    "human_owner_approval=APPROVED",
    `implementation_sha=${IMPLEMENTATION_SHA}`,
    `operator_bundle_sha256=${bundleDigest}`,
    `node_path=${process.execPath}`,
    `node_sha256=${"1".repeat(64)}`,
    `node_version=${process.version}`,
    "git_path=/usr/bin/git",
    `git_sha256=${"2".repeat(64)}`,
    "git_version=2.51.0",
    "cloudflared_path=/usr/local/bin/cloudflared",
    `cloudflared_sha256=${"3".repeat(64)}`,
    "cloudflared_version=2026.10.0",
  ].join("\n");
}

function makePlan(cfg) {
  return {
    environment: "staging",
    execution: "remote-staging",
    accountId: cfg.accountId,
    databaseId: cfg.d1,
    databaseName: cfg.databaseName,
    schemaVersion: "0015",
    repositorySha: cfg.sourceSha,
    orgName: cfg.orgName,
    ownerDisplayName: cfg.ownerDisplayName,
    operatorIdentityRef: cfg.operatorIdentityRef,
    issuer: FAKE.issuer,
    subject: FAKE.subject,
    email: FAKE.email,
    verificationSource: "cloudflare-access-operator-record",
    attestationRef: cfg.attestationRef,
    approvalRef: cfg.approvalRef,
    expectedPreState: "uninitialized",
  };
}

function testConfig() {
  const base = {
    ...REAL_CONFIG,
    api: "https://mock.invalid/client/v4",
    appUrl: "https://app.mock.invalid",
    moduleB64Sha256: sha256hex(MODULE_B64),
  };
  base.digest = sha256hex(canonicalPlan(makePlan(base)));
  return Object.freeze(base);
}

function setup(cfg, { approval = true, approvalOverride = null } = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "c1test-"));
  roots.push(root);
  const bundle = join(root, "bundle");
  const source = dirname(dirname(fileURLToPath(import.meta.url)));
  cpSync(source, bundle, {
    recursive: true,
    filter: (path) => !path.endsWith("/operator/private") && !path.includes("/operator/private/"),
  });
  const dir = join(bundle, "operator");
  const priv = join(dir, "private");
  require_mkdir(priv);
  writeFileSync(
    join(priv, "c1-access-attestation.json"),
    JSON.stringify({
      ...FAKE,
      attestationRef: cfg.attestationRef,
      verificationSource: "cloudflare-access-operator-record",
    }),
    { mode: 0o600 },
  );
  writeFileSync(join(priv, "c1-canonical-plan.json"), JSON.stringify({ plan: makePlan(cfg) }), {
    mode: 0o600,
  });
  const tpl = join(bundle, "19_W1_REQUEST_BODY_PLACEHOLDER.json");
  writeFileSync(
    tpl,
    JSON.stringify({
      bindings: [
        ...BIND18,
        { name: "BOOTSTRAP_APPROVAL_TOKEN", type: "secret_text", text: "<P>" },
        { name: "BOOTSTRAP_APPROVAL_DIGEST", type: "secret_text", text: "<P>" },
        { name: "STAGING_RELEASE_SHA", type: "secret_text", text: "<P>" },
      ],
    }),
  );
  const bundleDigest = regenerateManifests(bundle);
  if (approval)
    writeFileSync(
      join(priv, "c1-owner-approval.txt"),
      approvalOverride ?? approvalText(cfg, bundleDigest),
      { mode: 0o600 },
    );
  return { root, bundle, bundleDigest, dir, priv, tpl };
}
import { mkdirSync } from "node:fs";
function require_mkdir(p) {
  mkdirSync(p, { recursive: true, mode: 0o700 });
}

// Mock Cloudflare + app. faults: { latest, bindingsDrift, secrets, moduleMismatchNew, w1NetworkError, w1NoDeployCheck, postStatus, postNetworkError, d1Wrote }
function mockWorld(cfg, faults = {}) {
  const calls = [];
  const s = {
    versions: [
      {
        id: cfg.baseVersion,
        bindings: BIND18,
        modules: [{ name: "index.js", content_base64: MODULE_B64 }],
      },
    ],
    deployments: [
      { id: cfg.baseDeployment, versions: [{ version_id: cfg.baseVersion, percentage: 100 }] },
    ],
    secrets: faults.secrets ? [{ name: "X", type: "secret_text" }] : [],
    db: { ...cfg.prestate },
  };
  const ok = (result) => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, errors: [], result }),
  });
  const versionView = (v) => ({
    id: v.id,
    main_module: "index.js",
    compatibility_date: cfg.compatibilityDate,
    bindings: v.bindings.map((b) =>
      b.type === "secret_text" ? { name: b.name, type: b.type } : b,
    ),
    modules: v.modules,
  });
  async function fetch(url, init = {}) {
    const u = new URL(url);
    const method = init.method || "GET";
    const headers = init.headers || {};
    calls.push({ method, path: u.pathname, query: u.search, body: init.body, headers });
    if (u.origin === new URL(cfg.appUrl).origin) {
      if (u.pathname === "/health" && method === "GET")
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "ok", service: "ai-company-os-api" }),
        };
      if (faults.postNetworkError)
        throw new Error("socket hang up " + headers["x-bootstrap-approval-token"]);
      if (faults.postStatus)
        return {
          ok: false,
          status: faults.postStatus,
          json: async () => ({ error: { code: "X" } }),
        };
      s.db = { ...cfg.poststate };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          state: "VERIFIED",
          reason: "PROVISIONED",
          writes: 76,
          user_id: "usr_x",
          org_id: "org_x",
          identity_id: "hid_x",
        }),
      };
    }
    assert.equal(headers.authorization, `Bearer ${API_TOKEN}`);
    const p = u.pathname.replace("/client/v4", "");
    const W = `/accounts/${cfg.accountId}/workers/workers/${cfg.worker}`;
    const S = `/accounts/${cfg.accountId}/workers/scripts/${cfg.worker}`;
    const latest = s.versions[s.versions.length - 1];
    if (method === "GET" && p === `${S}/deployments`)
      return ok({ deployments: [...s.deployments].reverse() });
    if (method === "GET" && p === `${W}/versions/latest`) {
      if (faults.latest)
        return ok({ ...versionView(latest), id: "11111111-2222-3333-4444-555555555555" });
      const v = versionView(latest);
      if (faults.bindingsDrift) v.bindings = v.bindings.slice(1);
      return ok(v);
    }
    if (method === "GET" && p.startsWith(`${W}/versions/`)) {
      const id = p.split("/").pop();
      const v = s.versions.find((x) => x.id === id);
      return ok(versionView(v));
    }
    if (method === "GET" && p === `${S}/secrets`) return ok(s.secrets);
    if (method === "PATCH" && p === `${W}/versions/latest`) {
      if (faults.w1NetworkError) throw new Error("ECONNRESET");
      const body = JSON.parse(init.body);
      const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const mods = faults.moduleMismatchNew
        ? [{ name: "index.js", content_base64: "b3RoZXI=" }]
        : latest.modules;
      s.versions.push({ id, bindings: body.bindings, modules: mods });
      if (u.searchParams.get("deploy") === "true")
        s.deployments.push({ id: "dep-auto", versions: [{ version_id: id, percentage: 100 }] });
      return ok({ id });
    }
    if (method === "POST" && p === `${S}/deployments`) {
      const body = JSON.parse(init.body);
      s.deployments.push({ id: "bbbbbbbb-0000-0000-0000-000000000002", versions: body.versions });
      return ok({ id: "bbbbbbbb-0000-0000-0000-000000000002", versions: body.versions });
    }
    if (method === "POST" && p === `/accounts/${cfg.accountId}/d1/database/${cfg.d1}/query`) {
      const { sql } = JSON.parse(init.body);
      const meta = { changed_db: Boolean(faults.d1Wrote), rows_written: faults.d1Wrote ? 1 : 0 };
      if (sql.startsWith("SELECT id, name FROM d1_migrations"))
        return ok([{ results: cfg.migrations.map((name, i) => ({ id: i + 1, name })), meta }]);
      if (sql.startsWith("PRAGMA foreign_key_check")) return ok([{ results: [], meta }]);
      return ok([{ results: [{ ...s.db }], meta }]);
    }
    throw new Error(`unmocked ${method} ${p}`);
  }
  return { fetch, calls, s };
}

function deps(
  cfg,
  env,
  world,
  { confirm = true, tty = true, now = () => NOW_SECONDS * 1000, accessToken = JWT } = {},
) {
  const outLines = [];
  const red = new Redactor();
  return {
    outLines,
    d: {
      redactor: red,
      operatorDir: env.dir,
      templatePath: env.tpl,
      out: (l) => outLines.push(l),
      readFile: (p) => (dirname(p) === env.priv ? readPrivateFile(p) : readFileSync(p, "utf8")),
      exists: (p) => existsSync(p),
      isTTY: () => tty,
      writeExclusive: writePrivateExclusive,
      getImplementationSha: async () => IMPLEMENTATION_SHA,
      assertCommittedBundle: async () => {},
      validateTools: async () => {},
      readSecret: async () => API_TOKEN,
      prompt: async (label) =>
        label.includes("independent owner")
          ? `${IMPLEMENTATION_SHA} ${env.bundleDigest}`
          : confirm
            ? label.includes("DEPLOY")
              ? `DEPLOY aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`
              : `BOOTSTRAP ${cfg.approvalRef}`
            : "no",
      fetch: world.fetch,
      now,
      getAccessJwt: async () => accessToken,
      attest: async (jwt, outPath) => {
        assert.equal(jwt, accessToken);
        validateAccessJwt(jwt, {
          jwks: { keys: [TOKEN_JWK] },
          nowSeconds: now() / 1000,
          expectedSubject: FAKE.subject,
          expectedEmailSha256: sha256hex(FAKE.email),
        });
        writeFileSync(outPath, JSON.stringify({ ...FAKE, attestationRef: "c1att-fresh" }), {
          mode: 0o600,
        });
        return JSON.stringify({
          identity_attestation_status: "VERIFIED",
          email_binding: "MATCHED",
          attestation_reference: "c1att-fresh",
        });
      },
    },
  };
}

const mutating = (calls) =>
  calls
    .filter((c) => c.method !== "GET" && !c.path.endsWith("/query"))
    .map((c) => `${c.method} ${c.path.replace("/client/v4", "")}`);
const allOutput = (outLines, e) => outLines.join("\n") + (e ? `\n${e.code} ${e.detail}` : "");

test("dry-run validates offline and makes zero network calls", async () => {
  const cfg = testConfig();
  const env = setup(cfg, { approval: false });
  const w = mockWorld(cfg);
  const { d } = deps(cfg, env, w);
  d.fetch = async () => {
    throw new Error("network must not be used");
  };
  const r = await run([], d, cfg);
  assert.equal(r.status, "DRY_RUN_OK");
  assert.equal(w.calls.length, 0);
});

test("execute refuses without approval file / with wrong digest / with wrong ref / without TTY", async () => {
  const cfg = testConfig();
  for (const [opts, code] of [
    [{ approval: false }, "APPROVAL_FILE_ABSENT_OR_UNSAFE"],
    [
      {
        approvalOverride: `action=${cfg.action}\napproval_request_ref=${cfg.approvalRef}\ncanonical_plan_digest=${"f".repeat(64)}`,
      },
      "APPROVAL_FILE_INVALID",
    ],
    [
      {
        approvalOverride: `action=${cfg.action}\napproval_request_ref=c1req-wrong000000000000\ncanonical_plan_digest=${cfg.digest}`,
      },
      "APPROVAL_FILE_INVALID",
    ],
  ]) {
    const env = setup(cfg, opts);
    const w = mockWorld(cfg);
    const { d } = deps(cfg, env, w);
    await assert.rejects(run(["--execute"], d, cfg), (e) => e.code === code);
    assert.equal(w.calls.length, 0);
  }
  const env = setup(cfg);
  const w = mockWorld(cfg);
  const { d } = deps(cfg, env, w, { tty: false });
  await assert.rejects(run(["--execute"], d, cfg), (e) => e.code === "TTY_REQUIRED");
  assert.equal(w.calls.length, 0);
});

test("happy path: exactly W1, W2, one POST; W1 has no deploy param; W2 is [{NEW,100}] without force; no secret in output", async () => {
  const cfg = testConfig();
  const env = setup(cfg);
  const w = mockWorld(cfg);
  const { d, outLines } = deps(cfg, env, w);
  const r = await run(["--execute"], d, cfg);
  assert.equal(r.status, "C1_BOOTSTRAP_VERIFIED");
  const W = `/accounts/${cfg.accountId}/workers/workers/${cfg.worker}`;
  const S = `/accounts/${cfg.accountId}/workers/scripts/${cfg.worker}`;
  assert.deepEqual(mutating(w.calls), [
    `PATCH ${W}/versions/latest`,
    `POST ${S}/deployments`,
    "POST /operator/staging-bootstrap",
  ]);
  const w1 = w.calls.find((c) => c.method === "PATCH");
  assert.equal(w1.query, "");
  const body = JSON.parse(w1.body);
  assert.equal(body.bindings.length, 21);
  assert.equal(bindingsHash(body.bindings.slice(0, 18)), cfg.bindings18Sha256);
  assert.deepEqual(
    body.bindings.slice(18).map((b) => [b.name, b.type]),
    cfg.secretNames.map((n) => [n, "secret_text"]),
  );
  const token = readFileSync(join(env.priv, "c1-bootstrap-approval-token"), "utf8").trim();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.notEqual(token, cfg.digest);
  const w2 = w.calls.find((c) => c.method === "POST" && c.path.endsWith("/deployments"));
  assert.equal(w2.query, "");
  assert.deepEqual(JSON.parse(w2.body).versions, [
    { version_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", percentage: 100 },
  ]);
  const post = w.calls.find((c) => c.path === "/operator/staging-bootstrap");
  assert.equal(post.headers["x-bootstrap-approval-digest"], cfg.digest);
  assert.equal(post.headers["x-bootstrap-approval-token"], token);
  assert.deepEqual(Object.keys(JSON.parse(post.body)), ["plan"]);
  const text = allOutput(outLines) + JSON.stringify(r.receipt);
  for (const secret of [token, API_TOKEN, JWT, FAKE.subject, FAKE.email])
    assert.ok(!text.includes(secret), "secret leaked to output/receipt");
});

test("pre-W1 drift stops before any mutation (latest, bindings, secrets)", async () => {
  const cfg = testConfig();
  for (const [fault, code] of [
    ["latest", "DRIFT_LATEST"],
    ["bindingsDrift", "DRIFT_BINDINGS"],
    ["secrets", "DRIFT_SECRETS"],
  ]) {
    const env = setup(cfg);
    const w = mockWorld(cfg, { [fault]: true });
    const { d } = deps(cfg, env, w);
    await assert.rejects(run(["--execute"], d, cfg), (e) => e.code === code);
    assert.deepEqual(mutating(w.calls), []);
  }
});

test("post-W1 code mismatch stops before W2", async () => {
  const cfg = testConfig();
  const env = setup(cfg);
  const w = mockWorld(cfg, { moduleMismatchNew: true });
  const { d } = deps(cfg, env, w);
  await assert.rejects(run(["--execute"], d, cfg), (e) => e.code === "POST_W1_CODE_MISMATCH");
  assert.equal(mutating(w.calls).length, 1);
});

test("W1 network error = UNKNOWN_OUTCOME, exactly one PATCH, rerun refused", async () => {
  const cfg = testConfig();
  const env = setup(cfg);
  const w = mockWorld(cfg, { w1NetworkError: true });
  const { d } = deps(cfg, env, w);
  await assert.rejects(run(["--execute"], d, cfg), (e) => e.code === "UNKNOWN_OUTCOME");
  assert.equal(w.calls.filter((c) => c.method === "PATCH").length, 1);
  const w2 = mockWorld(cfg);
  const { d: d2 } = deps(cfg, env, w2);
  await assert.rejects(run(["--execute"], d2, cfg), (e) => e.code === "ALREADY_ATTEMPTED_W1");
  assert.equal(w2.calls.length, 0);
});

test("W2 not confirmed = stop, no deployment", async () => {
  const cfg = testConfig();
  const env = setup(cfg);
  const w = mockWorld(cfg);
  const { d } = deps(cfg, env, w, { confirm: false });
  await assert.rejects(run(["--execute"], d, cfg), (e) => e.code === "W2_NOT_CONFIRMED");
  assert.equal(mutating(w.calls).length, 1);
});

test("bootstrap POST failure or network error = stop, never retried; secrets scrubbed from error", async () => {
  const cfg = testConfig();
  for (const [fault, code] of [
    [{ postStatus: 500 }, "UNKNOWN_OUTCOME"],
    [{ postNetworkError: true }, "UNKNOWN_OUTCOME"],
  ]) {
    const env = setup(cfg);
    const w = mockWorld(cfg, fault);
    const { d, outLines } = deps(cfg, env, w);
    let err;
    await assert.rejects(run(["--execute"], d, cfg), (e) => {
      err = e;
      return e.code === code;
    });
    assert.equal(w.calls.filter((c) => c.path === "/operator/staging-bootstrap").length, 1);
    assert.ok(existsSync(join(env.priv, "c1-b1-attempted")));
    const token = readFileSync(join(env.priv, "c1-bootstrap-approval-token"), "utf8").trim();
    const text = d.redactor.scrub(allOutput(outLines, err));
    assert.ok(!text.includes(token) && !text.includes(JWT) && !text.includes(API_TOKEN));
  }
});

test("D1 prestate binds the organization name without interpolating SQL", async () => {
  for (const orgName of [REAL_CONFIG.orgName, "Smoke'; DROP TABLE organizations; --"]) {
    const cfg = { ...testConfig(), orgName };
    const world = mockWorld(cfg);
    const cf = makeCf({
      cfg,
      deps: { fetch: world.fetch },
      state: { mutationsEnabled: false, allowNext: null, apiToken: API_TOKEN },
    });
    assert.deepEqual(await d1State(cf, cfg, cfg.prestate, "PRE"), cfg.prestate);
    const count = world.calls
      .filter((call) => call.path.endsWith("/query"))
      .map((call) => JSON.parse(call.body))
      .find((body) => body.sql.includes("AS org_named"));
    assert.ok(count.sql.includes("WHERE name = ?"));
    assert.ok(!count.sql.includes(orgName));
    assert.deepEqual(count.params, [orgName]);
    assertReadOnlySql(count.sql);
    assert.deepEqual(mutating(world.calls), []);
  }
});

test("D1 rejects unsupported parameter values before making a request", async () => {
  const cf = makeCf({
    cfg: testConfig(),
    deps: { fetch: async () => assert.fail("must not be called") },
    state: { mutationsEnabled: false, allowNext: null, apiToken: API_TOKEN },
  });
  for (const params of [null, "name", {}, [null], [42], [{}], new Array(1)]) {
    await assert.rejects(cf.d1("SELECT ?", params), { code: "D1_PARAMS_INVALID" });
  }
});

test("D1 read that reports a write stops", async () => {
  const cfg = testConfig();
  const env = setup(cfg);
  const w = mockWorld(cfg, { d1Wrote: true });
  const { d } = deps(cfg, env, w);
  await assert.rejects(run(["--execute"], d, cfg), (e) => e.code === "D1_READ_WROTE");
  assert.deepEqual(mutating(w.calls), []);
});

test("guards: public worker, public D1, foreign account, non-allowlisted mutation, write SQL", async () => {
  const cfg = testConfig();
  const state = { mutationsEnabled: false, allowNext: null, apiToken: API_TOKEN };
  const cf = makeCf({
    cfg,
    deps: {
      fetch: async () => {
        throw new Error("must not be called");
      },
    },
    state,
  });
  await assert.rejects(
    cf.request("GET", `/accounts/${cfg.accountId}/workers/scripts/${cfg.publicWorker}/deployments`),
    (e) => e.code === "PUBLIC_TARGET_REJECTED",
  );
  await assert.rejects(
    cf.request("GET", `/accounts/${cfg.accountId}/d1/database/${cfg.publicD1}`),
    (e) => e.code === "PUBLIC_TARGET_REJECTED",
  );
  await assert.rejects(
    cf.request("GET", "/accounts/0000/workers/scripts/x"),
    (e) => e.code === "PATH_REJECTED",
  );
  await assert.rejects(
    cf.request("PATCH", `/accounts/${cfg.accountId}/workers/workers/${cfg.worker}/versions/latest`),
    (e) => e.code === "MUTATION_DISABLED_IN_PREPARATION_MODE",
  );
  state.mutationsEnabled = true;
  await assert.rejects(
    cf.request("DELETE", `/accounts/${cfg.accountId}/workers/scripts/${cfg.worker}/secrets/X`),
    (e) => e.code === "MUTATION_NOT_ALLOWLISTED",
  );
  for (const sql of [
    "INSERT INTO x VALUES (1)",
    "SELECT 1; DELETE FROM x",
    "UPDATE x SET y=1",
    "PRAGMA writable_schema=1",
  ])
    assert.throws(
      () => assertReadOnlySql(sql),
      (e) => e.code === "SQL_NOT_READ_ONLY",
    );
  assertReadOnlySql("SELECT id, name FROM d1_migrations ORDER BY id");
  assertReadOnlySql("PRAGMA foreign_key_check");
});

test("real config: template bindings hash and W1 body shape match the live read", () => {
  assert.equal(bindingsHash(BIND18), REAL_CONFIG.bindings18Sha256);
  const b = buildW1Body(BIND18, { token: "1".repeat(64) }, REAL_CONFIG);
  assert.equal(b.bindings.length, 21);
  assert.throws(
    () => buildW1Body(BIND18, { token: REAL_CONFIG.digest }, REAL_CONFIG),
    (e) => e.code === "APPROVAL_TOKEN_INVALID",
  );
  assert.throws(
    () => buildW1Body(BIND18.slice(1), { token: "1".repeat(64) }, REAL_CONFIG),
    (e) => e.code === "BINDINGS_DRIFT",
  );
});

test("redactor scrubs registered secrets, JWT shapes and bearer headers", () => {
  const r = new Redactor();
  r.add("supersecretvalue123");
  const s = r.scrub(`x supersecretvalue123 y ${JWT} Authorization: Bearer abc.def`);
  assert.ok(!s.includes("supersecretvalue123") && !s.includes(JWT) && !s.includes("abc.def"));
});

test("plan/approval validators reject tampering", () => {
  const cfg = testConfig();
  const plan = makePlan(cfg);
  const rec = { ...FAKE, attestationRef: cfg.attestationRef };
  assert.equal(validatePlan(plan, rec, cfg), cfg.digest);
  assert.throws(
    () => validatePlan({ ...plan, ownerDisplayName: "X" }, rec, cfg),
    (e) => e.code === "PLAN_FIELD_MISMATCH",
  );
  assert.throws(
    () => validatePlan({ ...plan, extra: "1" }, rec, cfg),
    (e) => e.code === "PLAN_FIELDS_INVALID",
  );
  assert.throws(
    () => validatePlan(plan, { ...rec, subject: "other" }, cfg),
    (e) => e.code === "PLAN_IDENTITY_MISMATCH",
  );
  assert.throws(
    () => parseApproval("action=x", cfg),
    (e) => e instanceof Stop,
  );
});

function changeApproval(env, key, value) {
  const path = join(env.priv, "c1-owner-approval.txt");
  const text = readFileSync(path, "utf8").replace(
    new RegExp(`^${key}=.*$`, "m"),
    `${key}=${value}`,
  );
  writeFileSync(path, text, { mode: 0o600 });
}

function instrumentSecrets(d) {
  const counters = { api: 0, jwt: 0 };
  const read = d.readSecret;
  const access = d.getAccessJwt;
  d.readSecret = async (...args) => {
    counters.api++;
    return read(...args);
  };
  d.getAccessJwt = async (...args) => {
    counters.jwt++;
    return access(...args);
  };
  return counters;
}

for (const [label, key, value, code] of [
  ["plan digest", "canonical_plan_digest", "f".repeat(64), "APPROVAL_FILE_INVALID"],
  ["approval reference", "approval_request_ref", "unapproved-reference", "APPROVAL_FILE_INVALID"],
  ["Worker source SHA", "source_sha", "b".repeat(40), "APPROVAL_FILE_INVALID"],
  ["Cloudflare account", "account_id", "b".repeat(32), "APPROVAL_FILE_INVALID"],
  ["D1 UUID", "d1", "11111111-2222-3333-4444-555555555555", "APPROVAL_FILE_INVALID"],
  ["Worker", "worker", "another-staging-worker", "APPROVAL_FILE_INVALID"],
  [
    "base deployment",
    "base_deployment",
    "11111111-2222-3333-4444-555555555555",
    "APPROVAL_FILE_INVALID",
  ],
  ["ungranted approval", "human_owner_approval", "PENDING", "APPROVAL_FILE_INVALID"],
  ["missing trusted digest", "operator_bundle_sha256", "", "APPROVAL_INTEGRITY_BINDING_INVALID"],
  ["wrong trusted digest", "operator_bundle_sha256", "f".repeat(64), "BUNDLE_INTEGRITY_FAILED"],
  ["wrong implementation SHA", "implementation_sha", "b".repeat(40), "BUNDLE_INTEGRITY_FAILED"],
  [
    "untrusted PATH executable",
    "cloudflared_path",
    "cloudflared",
    "APPROVAL_EXECUTABLE_PIN_INVALID",
  ],
]) {
  test(`authorization rejects ${label} before credentials or network`, async () => {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    const { d } = deps(cfg, env, w);
    changeApproval(env, key, value);
    const counters = instrumentSecrets(d);
    await assert.rejects(run(["--execute"], d, cfg), { code });
    assert.equal(w.calls.length, 0);
    assert.deepEqual(counters, { api: 0, jwt: 0 });
  });
}

for (const text of ["not an approval record", "action=x\naction=y", "action=x\nmalformed", "{}"])
  test(`malformed approval is rejected (${text.length} bytes)`, async () => {
    const cfg = testConfig();
    const env = setup(cfg, { approvalOverride: text });
    const w = mockWorld(cfg);
    const { d } = deps(cfg, env, w);
    const counters = instrumentSecrets(d);
    await assert.rejects(run(["--execute"], d, cfg), (error) =>
      error.code.startsWith("APPROVAL_FILE_"),
    );
    assert.equal(w.calls.length, 0);
    assert.equal(counters.api, 0);
  });

for (const path of [
  "operator/c1-runner.mjs",
  "operator/attest-access-identity.mjs",
  "operator/fixtures/bindings18.json",
  "19_W1_REQUEST_BODY_PLACEHOLDER.json",
  "operator/SHA256SUMS",
  "BUNDLE_SHA256SUMS",
])
  test(`one-byte integrity drift in ${path} blocks all credential and network access`, async () => {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    const { d } = deps(cfg, env, w);
    const file = join(env.bundle, path);
    writeFileSync(file, readFileSync(file, "utf8") + "\n");
    const counters = instrumentSecrets(d);
    await assert.rejects(run(["--execute"], d, cfg), { code: "BUNDLE_INTEGRITY_FAILED" });
    assert.equal(w.calls.length, 0);
    assert.equal(counters.api, 0);
  });

test("recomputing both manifests does not replace independent owner approval", async () => {
  const cfg = testConfig();
  const env = setup(cfg);
  const w = mockWorld(cfg);
  const { d } = deps(cfg, env, w);
  const file = join(env.dir, "c1-runner.mjs");
  writeFileSync(file, readFileSync(file, "utf8") + "\n");
  regenerateManifests(env.bundle);
  const counters = instrumentSecrets(d);
  await assert.rejects(run(["--execute"], d, cfg), { code: "BUNDLE_INTEGRITY_FAILED" });
  assert.equal(w.calls.length, 0);
  assert.equal(counters.api, 0);
});

for (const [name, code] of [
  ["c1-w1-attempted", "ALREADY_ATTEMPTED_W1"],
  ["c1-w2-attempted", "ALREADY_ATTEMPTED_W2"],
  ["c1-b1-attempted", "ALREADY_ATTEMPTED_B1"],
  ["c1-post-attempted", "LEGACY_ALREADY_ATTEMPTED"],
])
  test(`existing ${name} blocks a new execution without reading credentials`, async () => {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    const { d } = deps(cfg, env, w);
    writeFileSync(join(env.priv, name), "partial-attempt", { mode: 0o600 });
    const counters = instrumentSecrets(d);
    await assert.rejects(run(["--execute"], d, cfg), { code });
    assert.equal(w.calls.length, 0);
    assert.equal(counters.api, 0);
    assert.equal(readFileSync(join(env.priv, name), "utf8"), "partial-attempt");
  });

test("uncommitted bundle, unapproved executable and missing independent digest confirmation fail before API token", async () => {
  for (const [fault, code] of [
    ["commit", "UNCOMMITTED_OPERATOR_BUNDLE"],
    ["binary", "EXECUTABLE_PIN_INVALID"],
    ["confirm", "TRUSTED_DIGEST_NOT_CONFIRMED"],
  ]) {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    const { d } = deps(cfg, env, w);
    if (fault === "commit")
      d.assertCommittedBundle = async () => {
        throw new Stop(code);
      };
    if (fault === "binary")
      d.validateTools = async () => {
        throw new Stop(code);
      };
    if (fault === "confirm") d.prompt = async () => "unapproved-digest";
    const counters = instrumentSecrets(d);
    await assert.rejects(run(["--execute"], d, cfg), { code });
    assert.equal(w.calls.length, 0);
    assert.equal(counters.api, 0);
  }
});

test("invalid API token format and unsupported flags stop without network", async () => {
  for (const argv of [["--force"], ["--execute", "--dry-run"], ["--execute"]]) {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    const { d } = deps(cfg, env, w);
    d.readSecret = async () => "invalid token format";
    await assert.rejects(run(argv, d, cfg), {
      code:
        argv.length === 1 && argv[0] === "--execute"
          ? "API_TOKEN_FORMAT_INVALID"
          : "ARGUMENTS_INVALID",
    });
    assert.equal(w.calls.length, 0);
  }
});

test("an existing persisted approval token is never overwritten or reused", async () => {
  const cfg = testConfig();
  const env = setup(cfg);
  const w = mockWorld(cfg);
  const { d } = deps(cfg, env, w);
  writeFileSync(join(env.priv, "c1-bootstrap-approval-token"), "fake-existing-secret", {
    mode: 0o600,
  });
  const counters = instrumentSecrets(d);
  await assert.rejects(run(["--execute"], d, cfg), { code: "BOOTSTRAP_TOKEN_ALREADY_EXISTS" });
  assert.equal(w.calls.length, 0);
  assert.equal(counters.api, 0);
  assert.equal(
    readFileSync(join(env.priv, "c1-bootstrap-approval-token"), "utf8"),
    "fake-existing-secret",
  );
});

function intercept(d, edit) {
  const fetch = d.fetch;
  d.fetch = async (url, init = {}) => edit(new URL(url), init, await fetch(url, init));
}
const response = (result, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => result,
});
const outsider = "99999999-9999-4999-8999-999999999999";
function assertTransportSafe(outLines, error, extra = []) {
  const text =
    allOutput(outLines, error) + JSON.stringify(error?.receipt || {}) + String(error || "");
  for (const canary of [API_TOKEN, JWT, FAKE.subject, FAKE.email, ...extra])
    assert.ok(!text.includes(canary), "canary leaked from operator transport");
}

for (const status of [401, 403, 404, 409, 429, 500])
  test(`Cloudflare HTTP ${status} stops before W1 and suppresses raw error contents`, async () => {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    const { d, outLines } = deps(cfg, env, w);
    intercept(d, (url, init, res) =>
      url.origin === new URL(cfg.api).origin && init.method === "GET"
        ? response(
            { success: false, errors: [{ code: API_TOKEN, message: JWT + FAKE.email }] },
            status,
          )
        : res,
    );
    let error;
    await assert.rejects(run(["--execute"], d, cfg), (e) => {
      error = e;
      return e.code === "CF_READ_FAILED";
    });
    assert.deepEqual(mutating(w.calls), []);
    assert.ok(!existsSync(join(env.priv, "c1-w1-attempted")));
    assertTransportSafe(outLines, error);
  });

for (const [label, body, code] of [
  ["null JSON", null, "CF_READ_FAILED"],
  ["missing result", { success: true }, "CF_READ_FAILED"],
  ["wrong success type", { success: "true", result: {} }, "CF_READ_FAILED"],
  ["malformed errors", { success: true, errors: "not-array", result: {} }, "CF_READ_FAILED"],
  ["null result", { success: true, result: null }, "CF_RESPONSE_INVALID"],
  [
    "unexpected deployment schema",
    { success: true, result: { deployments: "not-array" } },
    "CF_RESPONSE_INVALID",
  ],
  ["empty deployments", { success: true, result: { deployments: [] } }, "CF_RESPONSE_INVALID"],
  [
    "wrong percentage type",
    {
      success: true,
      result: {
        deployments: [{ id: outsider, versions: [{ version_id: outsider, percentage: "100" }] }],
      },
    },
    "CF_RESPONSE_INVALID",
  ],
])
  test(`Cloudflare ${label} fails closed despite HTTP success`, async () => {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    const { d } = deps(cfg, env, w);
    intercept(d, (url, init, res) =>
      url.origin === new URL(cfg.api).origin && init.method === "GET" ? response(body) : res,
    );
    await assert.rejects(run(["--execute"], d, cfg), { code });
    assert.deepEqual(mutating(w.calls), []);
  });

test("malformed Cloudflare JSON and D1 read network failures never authorize mutations", async () => {
  for (const fault of ["json", "d1-network"]) {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    const { d, outLines } = deps(cfg, env, w);
    const fetch = d.fetch;
    d.fetch = async (url, init) => {
      if (fault === "d1-network" && url.endsWith("/query")) throw new Error(API_TOKEN + JWT);
      const res = await fetch(url, init);
      if (fault === "json" && init.method === "GET")
        res.json = async () => {
          throw new Error(API_TOKEN + JWT);
        };
      return res;
    };
    let error;
    await assert.rejects(run(["--execute"], d, cfg), (e) => {
      error = e;
      return e.code === (fault === "json" ? "CF_READ_FAILED" : "NETWORK_ERROR_READ");
    });
    assert.deepEqual(mutating(w.calls), []);
    assertTransportSafe(outLines, error);
  }
});

for (const [label, path, code] of [
  [
    "arbitrary Worker",
    (c) => `/accounts/${c.accountId}/workers/scripts/another-worker/deployments`,
    "WORKER_TARGET_REJECTED",
  ],
  [
    "arbitrary D1",
    (c) => `/accounts/${c.accountId}/d1/database/${outsider}/query`,
    "D1_TARGET_REJECTED",
  ],
  [
    "foreign account",
    (c) => `/accounts/00000000000000000000000000000000/workers/scripts/${c.worker}/deployments`,
    "PATH_REJECTED",
  ],
  [
    "public Worker",
    (c) => `/accounts/${c.accountId}/workers/scripts/${c.publicWorker}/deployments`,
    "PUBLIC_TARGET_REJECTED",
  ],
  [
    "public D1",
    (c) => `/accounts/${c.accountId}/d1/database/${c.publicD1}/query`,
    "PUBLIC_TARGET_REJECTED",
  ],
  [
    "encoded path",
    (c) => `/accounts/${c.accountId}/workers/scripts/${c.worker}/%2e%2e`,
    "PATH_REJECTED",
  ],
  [
    "extra path after valid Worker",
    (c) => `/accounts/${c.accountId}/workers/scripts/${c.worker}/unexpected`,
    "ENDPOINT_NOT_ALLOWLISTED",
  ],
])
  test(`target guard blocks ${label} without issuing a request`, async () => {
    const cfg = testConfig();
    let calls = 0;
    const cf = makeCf({
      cfg,
      state: { mutationsEnabled: false, allowNext: null, apiToken: API_TOKEN },
      deps: {
        fetch: async () => {
          calls++;
          throw new Error("must not call");
        },
      },
    });
    await assert.rejects(cf.request("GET", path(cfg)), { code });
    assert.equal(calls, 0);
  });

test("W1 deploy queries and W2 force queries are rejected even with a mutation permit", async () => {
  const cfg = testConfig();
  let calls = 0;
  for (const [method, path, query] of [
    [
      "PATCH",
      `/accounts/${cfg.accountId}/workers/workers/${cfg.worker}/versions/latest`,
      { deploy: true },
    ],
    [
      "POST",
      `/accounts/${cfg.accountId}/workers/scripts/${cfg.worker}/deployments`,
      { force: true },
    ],
  ]) {
    const cf = makeCf({
      cfg,
      state: { mutationsEnabled: true, allowNext: { method, path }, apiToken: API_TOKEN },
      deps: {
        fetch: async () => {
          calls++;
        },
      },
    });
    await assert.rejects(cf.request(method, path, { query }), { code: "QUERY_REJECTED" });
  }
  assert.equal(calls, 0);
});

for (const [label, change, code] of [
  [
    "deployment mismatch",
    (w) => {
      w.s.deployments[0].id = outsider;
    },
    "DRIFT_DEPLOYMENT",
  ],
  [
    "source module hash",
    (w) => {
      w.s.versions[0].modules[0].content_base64 = "Y2hhbmdlZA==";
    },
    "DRIFT_MODULE",
  ],
  [
    "split traffic",
    (w) => {
      w.s.deployments[0].versions[0].percentage = 50;
    },
    "DRIFT_TRAFFIC",
  ],
])
  test(`pre-W1 ${label} stops before any mutation`, async () => {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    change(w);
    const { d } = deps(cfg, env, w);
    await assert.rejects(run(["--execute"], d, cfg), { code });
    assert.deepEqual(mutating(w.calls), []);
  });

test("live binding drift between preflights is detected, not replaced by the frozen template", async () => {
  const cfg = testConfig();
  const env = setup(cfg);
  const w = mockWorld(cfg);
  const { d } = deps(cfg, env, w);
  let latestReads = 0;
  intercept(d, async (url, init, res) => {
    if (init.method === "GET" && url.pathname.endsWith("/versions/latest") && ++latestReads === 2) {
      const json = await res.json();
      json.result.bindings = json.result.bindings.slice(1);
      return response(json);
    }
    return res;
  });
  await assert.rejects(run(["--execute"], d, cfg), { code: "DRIFT_BINDINGS" });
  assert.deepEqual(mutating(w.calls), []);
  assert.ok(!existsSync(join(env.priv, "c1-w1-attempted")));
});

for (const stage of ["W1", "W2"])
  for (const status of [401, 403, 404, 409, 429, 500])
    test(`${stage} HTTP ${status} preserves durable marker and never retries an unknown outcome`, async () => {
      const cfg = testConfig();
      const env = setup(cfg);
      const w = mockWorld(cfg);
      const { d, outLines } = deps(cfg, env, w);
      const matches = (init, url) =>
        stage === "W1"
          ? init.method === "PATCH"
          : init.method === "POST" && url.pathname.endsWith("/deployments");
      intercept(d, (url, init, res) =>
        matches(init, url)
          ? response({ success: false, errors: [{ code: API_TOKEN, message: JWT }] }, status)
          : res,
      );
      let error;
      await assert.rejects(run(["--execute"], d, cfg), (e) => {
        error = e;
        return e.code === "UNKNOWN_OUTCOME";
      });
      assert.ok(existsSync(join(env.priv, stage === "W1" ? "c1-w1-attempted" : "c1-w2-attempted")));
      assert.equal(
        w.calls.filter((c) =>
          stage === "W1"
            ? c.method === "PATCH"
            : c.method === "POST" && c.path.endsWith("/deployments"),
        ).length,
        1,
      );
      assert.equal(w.calls.filter((c) => c.path === "/operator/staging-bootstrap").length, 0);
      const other = mockWorld(cfg);
      const { d: restart } = deps(cfg, env, other);
      await assert.rejects(run(["--execute"], restart, cfg), { code: "ALREADY_ATTEMPTED_W1" });
      assert.equal(other.calls.length, 0);
      assertTransportSafe(outLines, error);
    });

for (const stage of ["W1", "W2"])
  for (const fault of ["malformed-json", "missing-result", "unexpected-id"])
    test(`${stage} ${fault} is UNKNOWN_OUTCOME and blocks later stages`, async () => {
      const cfg = testConfig();
      const env = setup(cfg);
      const w = mockWorld(cfg);
      const { d, outLines } = deps(cfg, env, w);
      intercept(d, (url, init, res) => {
        if (
          !(stage === "W1"
            ? init.method === "PATCH"
            : init.method === "POST" && url.pathname.endsWith("/deployments"))
        )
          return res;
        if (fault === "malformed-json")
          return {
            ok: true,
            status: 200,
            json: async () => {
              throw new Error(API_TOKEN);
            },
          };
        return response(
          fault === "missing-result"
            ? { success: true }
            : { success: true, result: { id: API_TOKEN } },
        );
      });
      let error;
      await assert.rejects(run(["--execute"], d, cfg), (e) => {
        error = e;
        return e.code === "UNKNOWN_OUTCOME";
      });
      assert.equal(w.calls.filter((c) => c.path === "/operator/staging-bootstrap").length, 0);
      assertTransportSafe(outLines, error);
    });

test("W2 network interruption is reconciled read-only and never replayed after restart", async () => {
  const cfg = testConfig();
  const env = setup(cfg);
  const w = mockWorld(cfg);
  const { d } = deps(cfg, env, w);
  const fetch = d.fetch;
  d.fetch = async (url, init) => {
    const res = await fetch(url, init);
    if (init.method === "POST" && url.endsWith("/deployments")) throw new Error(API_TOKEN + JWT);
    return res;
  };
  await assert.rejects(run(["--execute"], d, cfg), { code: "UNKNOWN_OUTCOME" });
  const marker = join(env.priv, "c1-w2-attempted");
  const beforeMarker = readFileSync(marker, "utf8");
  const { d: restart } = deps(cfg, env, w);
  const before = w.calls.length;
  await assert.rejects(run(["--execute"], restart, cfg), { code: "ALREADY_ATTEMPTED_W1" });
  assert.equal(w.calls.length, before);
  w.s.deployments.at(-1).versions[0].private_response_canary = API_TOKEN;
  const result = await run(["--reconcile"], restart, cfg);
  assert.equal(result.status, "RECONCILIATION_READ_ONLY");
  assert.deepEqual(mutating(w.calls.slice(before)), []);
  assert.equal(readFileSync(marker, "utf8"), beforeMarker);
  assert.ok(!JSON.stringify(result.receipt).includes(API_TOKEN));
  assert.ok(!existsSync(join(env.priv, "c1-b1-attempted")));
});

for (const [field, value] of [
  ["issuer", "https://untrusted.invalid"],
  ["subject", "different-test-subject"],
  ["email", "different@example.test"],
])
  test(`fresh Access ${field} mismatch blocks B1`, async () => {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    const { d, outLines } = deps(cfg, env, w);
    d.attest = async (_jwt, path) => {
      writeFileSync(
        path,
        JSON.stringify({ ...FAKE, [field]: value, attestationRef: "c1att-fresh" }),
        { mode: 0o600 },
      );
      return JSON.stringify({
        identity_attestation_status: "VERIFIED",
        email_binding: "MATCHED",
        attestation_reference: "c1att-fresh",
      });
    };
    let error;
    await assert.rejects(run(["--execute"], d, cfg), (e) => {
      error = e;
      return e.code === "FRESH_IDENTITY_MISMATCH";
    });
    assert.equal(w.calls.filter((c) => c.path === "/operator/staging-bootstrap").length, 0);
    assert.ok(!existsSync(join(env.priv, "c1-b1-attempted")));
    assertTransportSafe(outLines, error, [value]);
  });

for (const fault of [
  "child-exit",
  "malformed-output",
  "wrong-email-binding",
  "expired-after-confirmation",
])
  test(`attestation ${fault} is fail-closed and suppresses child contents`, async () => {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    const { d, outLines } = deps(cfg, env, w);
    const attest = d.attest;
    let calls = 0;
    d.attest = async (...args) => {
      calls++;
      if (fault === "child-exit" || (fault === "expired-after-confirmation" && calls === 2))
        throw new Error(API_TOKEN + JWT + FAKE.email);
      if (fault === "malformed-output") return API_TOKEN + JWT;
      if (fault === "wrong-email-binding")
        return JSON.stringify({
          identity_attestation_status: "VERIFIED",
          email_binding: "MISMATCH",
          attestation_reference: "c1att-fresh",
          raw: API_TOKEN,
        });
      return attest(...args);
    };
    let error;
    await assert.rejects(run(["--execute"], d, cfg), (e) => {
      error = e;
      return e.code === "FRESH_ATTESTATION_FAILED";
    });
    assert.equal(w.calls.filter((c) => c.path === "/operator/staging-bootstrap").length, 0);
    assert.ok(!existsSync(join(env.priv, "c1-b1-attempted")));
    if (fault === "expired-after-confirmation") assert.equal(calls, 2);
    assertTransportSafe(outLines, error);
  });

test("malformed JWT and cloudflared failure block B1 without publishing captured credentials", async () => {
  for (const fault of ["malformed", "child-failure"]) {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    const { d, outLines } = deps(cfg, env, w);
    d.getAccessJwt = async () => {
      if (fault === "child-failure") throw new Error(API_TOKEN + JWT);
      return "not-a-jwt";
    };
    let error;
    await assert.rejects(run(["--execute"], d, cfg), (e) => {
      error = e;
      return e.code === (fault === "malformed" ? "ACCESS_JWT_ABSENT" : "LOCAL_GATE_FAILED");
    });
    assert.equal(w.calls.filter((c) => c.path === "/operator/staging-bootstrap").length, 0);
    assertTransportSafe(outLines, error);
  }
});

for (const fault of ["HTTP", "JSON", "schema"])
  test(`runtime health ${fault} failure blocks B1`, async () => {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    const { d, outLines } = deps(cfg, env, w);
    intercept(d, (url, _init, res) => {
      if (url.pathname !== "/health") return res;
      if (fault === "HTTP") return response({ raw: API_TOKEN }, 403);
      if (fault === "JSON")
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error(API_TOKEN);
          },
        };
      return response({ status: "ok", service: API_TOKEN });
    });
    let error;
    await assert.rejects(run(["--execute"], d, cfg), (e) => {
      error = e;
      return e.code === "RUNTIME_HEALTH_FAILED";
    });
    assert.equal(w.calls.filter((c) => c.path === "/operator/staging-bootstrap").length, 0);
    assertTransportSafe(outLines, error);
  });

for (const status of [401, 403, 404, 409, 429, 500])
  test(`B1 HTTP ${status} retains durable marker, never retries and omits raw response`, async () => {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    const { d, outLines } = deps(cfg, env, w);
    const sessionCanary = "s".repeat(48);
    intercept(d, (url, init, res) =>
      url.pathname === "/operator/staging-bootstrap" && init.method === "POST"
        ? response(
            {
              state: API_TOKEN,
              reason: JWT,
              error: { code: sessionCanary },
              user_id: FAKE.subject,
              org_id: FAKE.email,
            },
            status,
          )
        : res,
    );
    let error;
    await assert.rejects(run(["--execute"], d, cfg), (e) => {
      error = e;
      return e.code === "UNKNOWN_OUTCOME";
    });
    const token = readFileSync(join(env.priv, "c1-bootstrap-approval-token"), "utf8").trim();
    assert.equal(w.calls.filter((c) => c.path === "/operator/staging-bootstrap").length, 1);
    assert.ok(existsSync(join(env.priv, "c1-b1-attempted")));
    const other = mockWorld(cfg);
    const { d: restart } = deps(cfg, env, other);
    await assert.rejects(run(["--execute"], restart, cfg), { code: "ALREADY_ATTEMPTED_W1" });
    assert.equal(other.calls.length, 0);
    assertTransportSafe(outLines, error, [token, sessionCanary]);
  });

for (const fault of [
  "malformed-json",
  "missing-state",
  "wrong-writes",
  "unexpected-state",
  "redirect",
])
  test(`B1 ${fault} reports UNKNOWN_OUTCOME without a second POST`, async () => {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    const { d, outLines } = deps(cfg, env, w);
    intercept(d, (url, _init, res) => {
      if (url.pathname !== "/operator/staging-bootstrap") return res;
      if (fault === "malformed-json")
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error(API_TOKEN + JWT);
          },
        };
      if (fault === "redirect") return response({ raw: API_TOKEN }, 302);
      const body = {
        state: "VERIFIED",
        reason: "PROVISIONED",
        writes: 76,
        session_token: API_TOKEN,
      };
      if (fault === "missing-state") delete body.state;
      if (fault === "wrong-writes") body.writes = "76";
      if (fault === "unexpected-state") body.state = JWT;
      return response(body);
    });
    let error;
    await assert.rejects(run(["--execute"], d, cfg), (e) => {
      error = e;
      return e.code === "UNKNOWN_OUTCOME";
    });
    assert.equal(w.calls.filter((c) => c.path === "/operator/staging-bootstrap").length, 1);
    assert.ok(existsSync(join(env.priv, "c1-b1-attempted")));
    assertTransportSafe(outLines, error);
  });

test("B1 requires its own typed confirmation and a final unchanged D1 prestate", async () => {
  for (const fault of ["confirmation", "d1-drift"]) {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    const { d } = deps(cfg, env, w);
    const prompt = d.prompt;
    d.prompt = async (label) => {
      const answer = await prompt(label);
      if (label.includes("BOOTSTRAP")) {
        if (fault === "confirmation") return "not-confirmed";
        w.s.db.org_total = 1;
      }
      return answer;
    };
    await assert.rejects(run(["--execute"], d, cfg), {
      code: fault === "confirmation" ? "POST_NOT_CONFIRMED" : "PRE_B1_FINAL_D1_COUNT_MISMATCH",
    });
    assert.equal(w.calls.filter((c) => c.path === "/operator/staging-bootstrap").length, 0);
    assert.ok(!existsSync(join(env.priv, "c1-b1-attempted")));
  }
});

test("an unexpected new version after W2 confirmation prevents deployment", async () => {
  const cfg = testConfig();
  const env = setup(cfg);
  const w = mockWorld(cfg);
  const { d } = deps(cfg, env, w);
  const prompt = d.prompt;
  d.prompt = async (label) => {
    const answer = await prompt(label);
    if (label.includes("DEPLOY")) w.s.versions.push({ ...w.s.versions.at(-1), id: outsider });
    return answer;
  };
  await assert.rejects(run(["--execute"], d, cfg), { code: "POST_W1_LATEST_MISMATCH" });
  assert.equal(mutating(w.calls).length, 1);
  assert.ok(!existsSync(join(env.priv, "c1-w2-attempted")));
});

for (const [fault, code] of [
  ["deployment", "POST_W2_TRAFFIC_MISMATCH"],
  ["latest", "POST_W2_LATEST_MISMATCH"],
  ["module", "POST_W2_CODE_MISMATCH"],
  ["bindings", "POST_W2_BINDINGS_MISMATCH"],
])
  test(`post-W2 ${fault} drift blocks B1`, async () => {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    const { d } = deps(cfg, env, w);
    const fetch = d.fetch;
    d.fetch = async (url, init) => {
      const res = await fetch(url, init);
      if (init.method === "POST" && url.endsWith("/deployments")) {
        if (fault === "latest") w.s.versions.push({ ...w.s.versions.at(-1), id: outsider });
        if (fault === "module")
          w.s.versions.at(-1).modules = [{ name: "index.js", content_base64: "bW9kaWZpZWQ=" }];
        if (fault === "bindings")
          w.s.versions.at(-1).bindings = w.s.versions.at(-1).bindings.slice(1);
        if (fault === "deployment") {
          const body = await res.json();
          body.result.id = outsider;
          return response(body);
        }
      }
      return res;
    };
    await assert.rejects(run(["--execute"], d, cfg), { code });
    assert.equal(w.calls.filter((c) => c.path === "/operator/staging-bootstrap").length, 0);
    assert.ok(existsSync(join(env.priv, "c1-w2-attempted")));
  });

test("private input permissions and source/marker symlinks fail before credentials", async () => {
  for (const fault of [
    "approval-mode",
    "plan-mode",
    "directory-mode",
    "source-symlink",
    "marker-symlink",
  ]) {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    const { d } = deps(cfg, env, w);
    if (fault === "approval-mode") chmodSync(join(env.priv, "c1-owner-approval.txt"), 0o644);
    if (fault === "plan-mode") chmodSync(join(env.priv, "c1-canonical-plan.json"), 0o644);
    if (fault === "directory-mode") chmodSync(env.priv, 0o755);
    if (fault === "source-symlink") {
      const source = join(env.dir, "c1-runner.mjs");
      const target = join(env.root, "target");
      writeFileSync(target, readFileSync(source));
      rmSync(source);
      symlinkSync(target, source);
    }
    if (fault === "marker-symlink")
      symlinkSync(join(env.priv, "c1-canonical-plan.json"), join(env.priv, "c1-w1-attempted"));
    const counters = instrumentSecrets(d);
    await assert.rejects(run(["--execute"], d, cfg));
    assert.equal(w.calls.length, 0);
    assert.equal(counters.api, 0);
  }
});

test("Access client sends cf-access-token, never a caller-supplied JWT assertion or email header", async () => {
  const cfg = testConfig();
  const env = setup(cfg);
  const w = mockWorld(cfg);
  const { d } = deps(cfg, env, w);
  await run(["--execute"], d, cfg);
  for (const call of w.calls.filter((c) =>
    ["/health", "/operator/staging-bootstrap"].includes(c.path),
  )) {
    assert.equal(call.headers["cf-access-token"], JWT);
    assert.equal(call.headers["cf-access-jwt-assertion"], undefined);
    assert.equal(call.headers["cf-access-authenticated-user-email"], undefined);
    assert.equal(call.headers.authorization, undefined);
  }
});

for (const field of ["text", "value"])
  test(`unexpected secret binding ${field} from Cloudflare stops before W2 without leakage`, async () => {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    const { d, outLines } = deps(cfg, env, w);
    intercept(d, async (url, init, res) => {
      if (init.method === "GET" && url.pathname.includes("/versions/") && w.s.versions.length > 1) {
        const json = await res.json();
        json.result.bindings.find((b) => b.type === "secret_text")[field] = API_TOKEN;
        return response(json);
      }
      return res;
    });
    let error;
    await assert.rejects(run(["--execute"], d, cfg), (e) => {
      error = e;
      return e.code === "CF_RESPONSE_INVALID";
    });
    assert.equal(mutating(w.calls).length, 1);
    assert.ok(!existsSync(join(env.priv, "c1-w2-attempted")));
    assertTransportSafe(outLines, error);
  });

test("unknown approval fields cannot silently expand execution authority", async () => {
  const cfg = testConfig();
  const env = setup(cfg);
  const w = mockWorld(cfg);
  const { d } = deps(cfg, env, w);
  const path = join(env.priv, "c1-owner-approval.txt");
  writeFileSync(path, readFileSync(path, "utf8") + "\nforce=true\n", { mode: 0o600 });
  await assert.rejects(run(["--execute"], d, cfg), { code: "APPROVAL_FILE_MALFORMED" });
  assert.equal(w.calls.length, 0);
});

test("CLI non-interactive execution, public verification and unsupported flags use sanitized exits", () => {
  const cfg = testConfig();
  const env = setup(cfg);
  const entry = join(env.dir, "c1-runner.mjs");
  for (const [flag, status, expected] of [
    ["--execute", 3, "STOP TTY_REQUIRED"],
    ["--force", 3, "STOP ARGUMENTS_INVALID"],
    ["--verify-bundle", 0, "BUNDLE_CONSISTENT_NOT_APPROVED"],
    ["--help", 0, "Usage:"],
  ]) {
    const child = spawnSync(process.execPath, [entry, flag], {
      input: API_TOKEN + JWT,
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    });
    assert.equal(child.status, status);
    assert.ok(child.stdout.includes(expected));
    for (const canary of [API_TOKEN, JWT, FAKE.subject, FAKE.email])
      assert.ok(!(child.stdout + child.stderr).includes(canary));
  }
  assert.ok(!existsSync(join(env.priv, "c1-w1-attempted")));
  assert.ok(!existsSync(join(env.priv, "c1-bootstrap-approval-token")));
});

for (const stage of ["independent owner", "DEPLOY", "BOOTSTRAP"])
  test(`bundle tampering during ${stage} confirmation blocks the next privileged operation`, async () => {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    const { d } = deps(cfg, env, w);
    const prompt = d.prompt;
    d.prompt = async (label) => {
      const answer = await prompt(label);
      if (label.includes(stage)) {
        const path = join(env.dir, "attest-access-identity.mjs");
        writeFileSync(path, readFileSync(path, "utf8") + "\n");
      }
      return answer;
    };
    const counters = instrumentSecrets(d);
    await assert.rejects(run(["--execute"], d, cfg), { code: "BUNDLE_INTEGRITY_FAILED" });
    const mutations = mutating(w.calls);
    assert.equal(mutations.length, stage === "independent owner" ? 0 : stage === "DEPLOY" ? 1 : 2);
    if (stage === "independent owner") {
      assert.equal(counters.api, 0);
      assert.equal(w.calls.length, 0);
    }
    assert.ok(
      !existsSync(join(env.priv, stage === "DEPLOY" ? "c1-w2-attempted" : "c1-b1-attempted")),
    );
  });

for (const [label, claims] of [
  ["cached stale JWT", { iat: NOW_SECONDS - MAX_ATTESTATION_AGE_SECONDS - 1 }],
  ["JWT without issued-at", { iat: undefined }],
])
  test(`${label} fails production attestation before health or B1 and is not reacquired`, async () => {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    const accessToken = signedAccessJwt(claims);
    const { d, outLines } = deps(cfg, env, w, { accessToken });
    const counters = instrumentSecrets(d);
    let error;
    await assert.rejects(run(["--execute"], d, cfg), (e) => {
      error = e;
      return e.code === "FRESH_ATTESTATION_FAILED";
    });
    assert.equal(counters.jwt, 1);
    assert.equal(
      w.calls.filter((c) => ["/health", "/operator/staging-bootstrap"].includes(c.path)).length,
      0,
    );
    assert.ok(!existsSync(join(env.priv, "c1-b1-attempted")));
    assertTransportSafe(outLines, error, [accessToken]);
  });

for (const reason of ["stale", "expired"])
  test(`token ${reason} during human confirmation blocks B1`, async () => {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    let nowSeconds = NOW_SECONDS;
    const accessToken = signedAccessJwt({
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + (reason === "expired" ? 600 : 3600),
    });
    const { d, outLines } = deps(cfg, env, w, { accessToken, now: () => nowSeconds * 1000 });
    const counters = instrumentSecrets(d);
    const prompt = d.prompt;
    d.prompt = async (label) => {
      const answer = await prompt(label);
      if (label.includes("BOOTSTRAP"))
        nowSeconds += reason === "expired" ? 600 : MAX_ATTESTATION_AGE_SECONDS + 1;
      return answer;
    };
    let error;
    await assert.rejects(run(["--execute"], d, cfg), (e) => {
      error = e;
      return e.code === "FRESH_ATTESTATION_FAILED";
    });
    assert.equal(counters.jwt, 1);
    assert.equal(w.calls.filter((c) => c.path === "/health").length, 1);
    assert.equal(w.calls.filter((c) => c.path === "/operator/staging-bootstrap").length, 0);
    assert.ok(!existsSync(join(env.priv, "c1-b1-attempted")));
    assertTransportSafe(outLines, error, [accessToken]);
  });

test("B1 accepts the inclusive maximum age after human confirmation", async () => {
  const cfg = testConfig();
  const env = setup(cfg);
  const w = mockWorld(cfg);
  let nowSeconds = NOW_SECONDS;
  const { d } = deps(cfg, env, w, {
    accessToken: signedAccessJwt({ iat: NOW_SECONDS }),
    now: () => nowSeconds * 1000,
  });
  const prompt = d.prompt;
  d.prompt = async (label) => {
    const answer = await prompt(label);
    if (label.includes("BOOTSTRAP")) nowSeconds += MAX_ATTESTATION_AGE_SECONDS;
    return answer;
  };
  assert.equal((await run(["--execute"], d, cfg)).status, "C1_BOOTSTRAP_VERIFIED");
  assert.equal(w.calls.filter((c) => c.path === "/operator/staging-bootstrap").length, 1);
});

for (const reason of ["stale", "expired"])
  test(`token ${reason} during final network preflights blocks B1 after a successful attestation`, async () => {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    let nowSeconds = NOW_SECONDS;
    const accessToken = signedAccessJwt({
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + (reason === "expired" ? 600 : 3600),
    });
    const { d, outLines } = deps(cfg, env, w, { accessToken, now: () => nowSeconds * 1000 });
    const attest = d.attest;
    let attestations = 0;
    d.attest = async (...args) => {
      const result = await attest(...args);
      attestations++;
      return result;
    };
    intercept(d, (_url, _init, res) => {
      if (attestations === 2)
        nowSeconds = NOW_SECONDS + (reason === "expired" ? 600 : MAX_ATTESTATION_AGE_SECONDS + 1);
      return res;
    });
    let error;
    await assert.rejects(run(["--execute"], d, cfg), (e) => {
      error = e;
      return e.code === "FRESH_ATTESTATION_FAILED";
    });
    assert.equal(attestations, 2);
    assert.equal(w.calls.filter((c) => c.path === "/operator/staging-bootstrap").length, 0);
    assert.ok(!existsSync(join(env.priv, "c1-b1-attempted")));
    assertTransportSafe(outLines, error, [accessToken]);
  });

test("time passing while the B1 marker is persisted blocks dispatch and retains the marker", async () => {
  const cfg = testConfig();
  const env = setup(cfg);
  const w = mockWorld(cfg);
  const marker = join(env.priv, "c1-b1-attempted");
  const accessToken = signedAccessJwt({ iat: NOW_SECONDS });
  const { d, outLines } = deps(cfg, env, w, {
    accessToken,
    now: () => (NOW_SECONDS + (existsSync(marker) ? MAX_ATTESTATION_AGE_SECONDS + 1 : 0)) * 1000,
  });
  let error;
  await assert.rejects(run(["--execute"], d, cfg), (e) => {
    error = e;
    return e.code === "FRESH_ATTESTATION_FAILED";
  });
  assert.equal(w.calls.filter((c) => c.path === "/operator/staging-bootstrap").length, 0);
  assert.ok(existsSync(marker));
  const restartWorld = mockWorld(cfg);
  const { d: restart } = deps(cfg, env, restartWorld);
  await assert.rejects(run(["--execute"], restart, cfg), { code: "ALREADY_ATTEMPTED_W1" });
  assert.equal(restartWorld.calls.length, 0);
  assertTransportSafe(outLines, error, [accessToken]);
});

for (const elapsedMilliseconds of [900000, 900001])
  test(`B1 uses millisecond production clock after ${elapsedMilliseconds}ms confirmation`, async () => {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    let nowMilliseconds = NOW_SECONDS * 1000;
    const { d } = deps(cfg, env, w, {
      accessToken: signedAccessJwt({ iat: NOW_SECONDS }),
      now: () => nowMilliseconds,
    });
    const prompt = d.prompt;
    d.prompt = async (label) => {
      const answer = await prompt(label);
      if (label.includes("BOOTSTRAP")) nowMilliseconds += elapsedMilliseconds;
      return answer;
    };
    if (elapsedMilliseconds === MAX_ATTESTATION_AGE_SECONDS * 1000) {
      assert.equal((await run(["--execute"], d, cfg)).status, "C1_BOOTSTRAP_VERIFIED");
      assert.equal(w.calls.filter((c) => c.path === "/operator/staging-bootstrap").length, 1);
    } else {
      await assert.rejects(run(["--execute"], d, cfg), { code: "FRESH_ATTESTATION_FAILED" });
      assert.equal(w.calls.filter((c) => c.path === "/operator/staging-bootstrap").length, 0);
      assert.ok(!existsSync(join(env.priv, "c1-b1-attempted")));
    }
  });

for (const fault of [
  "symlink-replacement",
  "regular-replacement",
  "device-change",
  "inode-change",
  "directory-replacement",
  "truncation",
  "unreadable",
  "unsupported-open",
  "missing-open-primitive",
  "descriptor-read",
  "descriptor-close",
  "ancestor-replacement",
])
  test(`descriptor integrity ${fault} blocks all credentials, network and mutations`, async () => {
    const cfg = testConfig();
    const env = setup(cfg);
    const w = mockWorld(cfg);
    const { d, outLines } = deps(cfg, env, w);
    const counters = instrumentSecrets(d);
    const target =
      fault === "ancestor-replacement"
        ? join(env.dir, "c1-runner.mjs")
        : join(env.bundle, "BUNDLE_SHA256SUMS");
    const saved = join(env.root, "saved-public-object");
    const outside = join(env.root, "outside-public-file");
    const replacementBytes = readFileSync(target);
    writeFileSync(outside, "outside-public-canary");
    const originals = Object.fromEntries(
      ["openSync", "fstatSync", "readFileSync", "closeSync"].map((name) => [name, fs[name]]),
    );
    const descriptors = new Set();
    let injected = false;
    let injecting = false;
    let error;
    const failIo = (code) => {
      injected = true;
      const failure = new Error(API_TOKEN + JWT + FAKE.email);
      failure.code = code;
      throw failure;
    };
    try {
      fs.openSync =
        fault === "missing-open-primitive"
          ? undefined
          : (path, ...args) => {
              if (path === target && !injected && !injecting) {
                if (fault === "unreadable") failIo("EACCES");
                if (fault === "unsupported-open") failIo("ENOTSUP");
                if (
                  ["symlink-replacement", "regular-replacement", "directory-replacement"].includes(
                    fault,
                  )
                ) {
                  injecting = true;
                  renameSync(path, saved);
                  if (fault === "symlink-replacement") symlinkSync(outside, path);
                  else if (fault === "regular-replacement") writeFileSync(path, replacementBytes);
                  else mkdirSync(path);
                  injected = true;
                  injecting = false;
                }
                if (fault === "ancestor-replacement") {
                  renameSync(env.dir, saved);
                  symlinkSync(saved, env.dir, "dir");
                  injected = true;
                }
              }
              const descriptor = originals.openSync(path, ...args);
              if (path === target) descriptors.add(descriptor);
              return descriptor;
            };
      fs.fstatSync = (descriptor, ...args) => {
        const stat = originals.fstatSync(descriptor, ...args);
        if (descriptors.has(descriptor) && ["device-change", "inode-change"].includes(fault)) {
          injected = true;
          return {
            ...stat,
            dev: stat.dev + (fault === "device-change" ? 1n : 0n),
            ino: stat.ino + (fault === "inode-change" ? 1n : 0n),
            isFile: () => stat.isFile(),
          };
        }
        return stat;
      };
      fs.readFileSync = (descriptor, ...args) => {
        if (descriptors.has(descriptor)) {
          if (fault === "descriptor-read") failIo("EIO");
          if (fault === "truncation" && !injected) {
            truncateSync(target, 1);
            injected = true;
          }
        }
        return originals.readFileSync(descriptor, ...args);
      };
      fs.closeSync = (descriptor) => {
        originals.closeSync(descriptor);
        if (fault === "descriptor-close" && descriptors.has(descriptor)) failIo("EIO");
      };
      await assert.rejects(run(["--execute"], d, cfg), (e) => {
        error = e;
        return e.code === "BUNDLE_INTEGRITY_FAILED";
      });
    } finally {
      for (const [name, original] of Object.entries(originals)) fs[name] = original;
    }
    assert.ok(injected || fault === "missing-open-primitive");
    assert.deepEqual(counters, { api: 0, jwt: 0 });
    assert.equal(w.calls.length, 0);
    for (const stage of ["w1", "w2", "b1"])
      assert.ok(!existsSync(join(env.priv, `c1-${stage}-attempted`)));
    assertTransportSafe(outLines, error);
  });
