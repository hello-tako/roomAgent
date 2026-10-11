// Local tests for c1-runner.mjs. Every endpoint is mocked. No network, no real secret.
// Run: node --test operator/c1-runner.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, openSync, writeSync, closeSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REAL_CONFIG, Redactor, Stop, run, makeCf, canonicalPlan, sha256hex, bindingsHash, buildW1Body,
  assertReadOnlySql, parseApproval, validatePlan,
} from "./c1-runner.mjs";

const BIND18 = JSON.parse(readFileSync(new URL("./fixtures/bindings18.json", import.meta.url), "utf8"));
const MODULE_B64 = "ZHVtbXktbW9kdWxlLWNvbnRlbnQ="; // dummy, not the real bundle
const FAKE = { issuer: REAL_CONFIG.issuer, subject: "test-subject-0001", email: "operator@example.test" };
const API_TOKEN = "TESTAPITOKEN_abcdefghijklmnopqrstuvwxyz012345";
const JWT = "eyJhbGciOiJSUzI1NiJ9AAAA.eyJzdWIiOiJ0ZXN0In0AAAA.c2lnbmF0dXJlLXRlc3QtdmFsdWU";

function makePlan(cfg) {
  return {
    environment: "staging", execution: "remote-staging", accountId: cfg.accountId, databaseId: cfg.d1,
    databaseName: cfg.databaseName, schemaVersion: "0015", repositorySha: cfg.sourceSha, orgName: cfg.orgName,
    ownerDisplayName: cfg.ownerDisplayName, operatorIdentityRef: cfg.operatorIdentityRef, issuer: FAKE.issuer,
    subject: FAKE.subject, email: FAKE.email, verificationSource: "cloudflare-access-operator-record",
    attestationRef: cfg.attestationRef, approvalRef: cfg.approvalRef, expectedPreState: "uninitialized",
  };
}

function testConfig() {
  const base = { ...REAL_CONFIG, api: "https://mock.invalid/client/v4", appUrl: "https://app.mock.invalid", moduleB64Sha256: sha256hex(MODULE_B64) };
  base.digest = sha256hex(canonicalPlan(makePlan(base)));
  return Object.freeze(base);
}

function setup(cfg, { approval = true, approvalOverride = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "c1test-"));
  const priv = join(dir, "private");
  writeFileSync(join(dir, ".keep"), "");
  require_mkdir(priv);
  writeFileSync(join(priv, "c1-access-attestation.json"), JSON.stringify({ ...FAKE, attestationRef: cfg.attestationRef, verificationSource: "cloudflare-access-operator-record" }));
  writeFileSync(join(priv, "c1-canonical-plan.json"), JSON.stringify({ plan: makePlan(cfg) }));
  const tpl = join(dir, "template.json");
  writeFileSync(tpl, JSON.stringify({ bindings: [...BIND18, { name: "BOOTSTRAP_APPROVAL_TOKEN", type: "secret_text", text: "<P>" }, { name: "BOOTSTRAP_APPROVAL_DIGEST", type: "secret_text", text: "<P>" }, { name: "STAGING_RELEASE_SHA", type: "secret_text", text: "<P>" }] }));
  if (approval) {
    const a = approvalOverride ?? [
      `action=${cfg.action}`, `approval_request_ref=${cfg.approvalRef}`, `canonical_plan_digest=${cfg.digest}`,
      `source_sha=${cfg.sourceSha}`, `base_version=${cfg.baseVersion}`, `worker=${cfg.worker}`, `d1=${cfg.d1}`,
      "secret_transport=A2", "human_owner_approval=APPROVED",
    ].join("\n");
    writeFileSync(join(priv, "c1-owner-approval.txt"), a);
  }
  return { dir, priv, tpl };
}
import { mkdirSync } from "node:fs";
function require_mkdir(p) { mkdirSync(p, { recursive: true }); }

// Mock Cloudflare + app. faults: { latest, bindingsDrift, secrets, moduleMismatchNew, w1NetworkError, w1NoDeployCheck, postStatus, postNetworkError, d1Wrote }
function mockWorld(cfg, faults = {}) {
  const calls = [];
  const s = {
    versions: [{ id: cfg.baseVersion, bindings: BIND18, modules: [{ name: "index.js", content_base64: MODULE_B64 }] }],
    deployments: [{ id: cfg.baseDeployment, versions: [{ version_id: cfg.baseVersion, percentage: 100 }] }],
    secrets: faults.secrets ? [{ name: "X", type: "secret_text" }] : [],
    db: { ...cfg.prestate },
  };
  const ok = (result) => ({ ok: true, status: 200, json: async () => ({ success: true, errors: [], result }) });
  const versionView = (v) => ({ id: v.id, main_module: "index.js", compatibility_date: cfg.compatibilityDate, bindings: v.bindings.map((b) => (b.type === "secret_text" ? { name: b.name, type: b.type } : b)), modules: v.modules });
  async function fetch(url, init = {}) {
    const u = new URL(url);
    const method = init.method || "GET";
    const headers = init.headers || {};
    calls.push({ method, path: u.pathname, query: u.search, body: init.body, headers });
    if (u.origin === new URL(cfg.appUrl).origin) {
      if (faults.postNetworkError) throw new Error("socket hang up " + headers["x-bootstrap-approval-token"]);
      if (faults.postStatus) return { ok: false, status: faults.postStatus, json: async () => ({ error: { code: "X" } }) };
      s.db = { ...cfg.poststate };
      return { ok: true, status: 200, json: async () => ({ state: "VERIFIED", reason: "PROVISIONED", writes: 76, user_id: "usr_x", org_id: "org_x", identity_id: "hid_x" }) };
    }
    assert.equal(headers.authorization, `Bearer ${API_TOKEN}`);
    const p = u.pathname.replace("/client/v4", "");
    const W = `/accounts/${cfg.accountId}/workers/workers/${cfg.worker}`;
    const S = `/accounts/${cfg.accountId}/workers/scripts/${cfg.worker}`;
    const latest = s.versions[s.versions.length - 1];
    if (method === "GET" && p === `${S}/deployments`) return ok({ deployments: [...s.deployments].reverse() });
    if (method === "GET" && p === `${W}/versions/latest`) {
      if (faults.latest) return ok({ id: "11111111-2222-3333-4444-555555555555", bindings: BIND18 });
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
      const mods = faults.moduleMismatchNew ? [{ name: "index.js", content_base64: "b3RoZXI=" }] : latest.modules;
      s.versions.push({ id, bindings: body.bindings, modules: mods });
      if (u.searchParams.get("deploy") === "true") s.deployments.push({ id: "dep-auto", versions: [{ version_id: id, percentage: 100 }] });
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
      if (sql.startsWith("SELECT id, name FROM d1_migrations")) return ok([{ results: cfg.migrations.map((name, i) => ({ id: i + 1, name })), meta }]);
      if (sql.startsWith("PRAGMA foreign_key_check")) return ok([{ results: [], meta }]);
      return ok([{ results: [{ ...s.db }], meta }]);
    }
    throw new Error(`unmocked ${method} ${p}`);
  }
  return { fetch, calls, s };
}

function deps(cfg, env, world, { confirm = true, tty = true } = {}) {
  const outLines = [];
  const red = new Redactor();
  return {
    outLines,
    d: {
      redactor: red, operatorDir: env.dir, templatePath: env.tpl,
      out: (l) => outLines.push(l),
      readFile: (p) => readFileSync(p, "utf8"),
      exists: (p) => existsSync(p),
      isTTY: () => tty,
      writeExclusive: (p, text) => { const fd = openSync(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); writeSync(fd, text); closeSync(fd); },
      readSecret: async () => API_TOKEN,
      prompt: async (label) => (confirm ? (label.includes("DEPLOY") ? `DEPLOY aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee` : `BOOTSTRAP ${cfg.approvalRef}`) : "no"),
      fetch: world.fetch,
      getAccessJwt: async () => JWT,
      attest: async (jwt, outPath) => {
        assert.equal(jwt, JWT);
        writeFileSync(outPath, JSON.stringify({ ...FAKE, attestationRef: "c1att-fresh" }));
        return JSON.stringify({ identity_attestation_status: "VERIFIED", email_binding: "MATCHED", attestation_reference: "c1att-fresh" });
      },
    },
  };
}

const mutating = (calls) => calls.filter((c) => c.method !== "GET" && !c.path.endsWith("/query")).map((c) => `${c.method} ${c.path.replace("/client/v4", "")}`);
const allOutput = (outLines, e) => outLines.join("\n") + (e ? `\n${e.code} ${e.detail}` : "");

test("dry-run validates offline and makes zero network calls", async () => {
  const cfg = testConfig(); const env = setup(cfg, { approval: false }); const w = mockWorld(cfg);
  const { d } = deps(cfg, env, w);
  d.fetch = async () => { throw new Error("network must not be used"); };
  const r = await run([], d, cfg);
  assert.equal(r.status, "DRY_RUN_OK");
  assert.equal(w.calls.length, 0);
});

test("execute refuses without approval file / with wrong digest / with wrong ref / without TTY", async () => {
  const cfg = testConfig();
  for (const [opts, code] of [
    [{ approval: false }, "ENOENT"],
    [{ approvalOverride: `action=${cfg.action}\napproval_request_ref=${cfg.approvalRef}\ncanonical_plan_digest=${"f".repeat(64)}` }, "APPROVAL_FILE_INVALID"],
    [{ approvalOverride: `action=${cfg.action}\napproval_request_ref=c1req-wrong000000000000\ncanonical_plan_digest=${cfg.digest}` }, "APPROVAL_FILE_INVALID"],
  ]) {
    const env = setup(cfg, opts); const w = mockWorld(cfg); const { d } = deps(cfg, env, w);
    await assert.rejects(run(["--execute"], d, cfg), (e) => (e.code === code));
    assert.equal(w.calls.length, 0);
  }
  const env = setup(cfg); const w = mockWorld(cfg); const { d } = deps(cfg, env, w, { tty: false });
  await assert.rejects(run(["--execute"], d, cfg), (e) => e.code === "TTY_REQUIRED");
  assert.equal(w.calls.length, 0);
});

test("happy path: exactly W1, W2, one POST; W1 has no deploy param; W2 is [{NEW,100}] without force; no secret in output", async () => {
  const cfg = testConfig(); const env = setup(cfg); const w = mockWorld(cfg); const { d, outLines } = deps(cfg, env, w);
  const r = await run(["--execute"], d, cfg);
  assert.equal(r.status, "C1_BOOTSTRAP_VERIFIED");
  const W = `/accounts/${cfg.accountId}/workers/workers/${cfg.worker}`;
  const S = `/accounts/${cfg.accountId}/workers/scripts/${cfg.worker}`;
  assert.deepEqual(mutating(w.calls), [`PATCH ${W}/versions/latest`, `POST ${S}/deployments`, "POST /operator/staging-bootstrap"]);
  const w1 = w.calls.find((c) => c.method === "PATCH");
  assert.equal(w1.query, "");
  const body = JSON.parse(w1.body);
  assert.equal(body.bindings.length, 21);
  assert.equal(bindingsHash(body.bindings.slice(0, 18)), cfg.bindings18Sha256);
  assert.deepEqual(body.bindings.slice(18).map((b) => [b.name, b.type]), cfg.secretNames.map((n) => [n, "secret_text"]));
  const token = readFileSync(join(env.priv, "c1-bootstrap-approval-token"), "utf8").trim();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.notEqual(token, cfg.digest);
  const w2 = w.calls.find((c) => c.method === "POST" && c.path.endsWith("/deployments"));
  assert.equal(w2.query, "");
  assert.deepEqual(JSON.parse(w2.body).versions, [{ version_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", percentage: 100 }]);
  const post = w.calls.find((c) => c.path === "/operator/staging-bootstrap");
  assert.equal(post.headers["x-bootstrap-approval-digest"], cfg.digest);
  assert.equal(post.headers["x-bootstrap-approval-token"], token);
  assert.deepEqual(Object.keys(JSON.parse(post.body)), ["plan"]);
  const text = allOutput(outLines) + JSON.stringify(r.receipt);
  for (const secret of [token, API_TOKEN, JWT, FAKE.subject, FAKE.email]) assert.ok(!text.includes(secret), "secret leaked to output/receipt");
});

test("pre-W1 drift stops before any mutation (latest, bindings, secrets)", async () => {
  const cfg = testConfig();
  for (const [fault, code] of [["latest", "DRIFT_LATEST"], ["bindingsDrift", "DRIFT_BINDINGS"], ["secrets", "DRIFT_SECRETS"]]) {
    const env = setup(cfg); const w = mockWorld(cfg, { [fault]: true }); const { d } = deps(cfg, env, w);
    await assert.rejects(run(["--execute"], d, cfg), (e) => e.code === code);
    assert.deepEqual(mutating(w.calls), []);
  }
});

test("post-W1 code mismatch stops before W2", async () => {
  const cfg = testConfig(); const env = setup(cfg); const w = mockWorld(cfg, { moduleMismatchNew: true }); const { d } = deps(cfg, env, w);
  await assert.rejects(run(["--execute"], d, cfg), (e) => e.code === "POST_W1_CODE_MISMATCH");
  assert.equal(mutating(w.calls).length, 1);
});

test("W1 network error = UNKNOWN_OUTCOME, exactly one PATCH, rerun refused", async () => {
  const cfg = testConfig(); const env = setup(cfg); const w = mockWorld(cfg, { w1NetworkError: true }); const { d } = deps(cfg, env, w);
  await assert.rejects(run(["--execute"], d, cfg), (e) => e.code === "UNKNOWN_OUTCOME");
  assert.equal(w.calls.filter((c) => c.method === "PATCH").length, 1);
  const w2 = mockWorld(cfg); const { d: d2 } = deps(cfg, env, w2);
  await assert.rejects(run(["--execute"], d2, cfg), (e) => e.code === "ALREADY_ATTEMPTED_W1");
  assert.equal(w2.calls.length, 0);
});

test("W2 not confirmed = stop, no deployment", async () => {
  const cfg = testConfig(); const env = setup(cfg); const w = mockWorld(cfg); const { d } = deps(cfg, env, w, { confirm: false });
  await assert.rejects(run(["--execute"], d, cfg), (e) => e.code === "W2_NOT_CONFIRMED");
  assert.equal(mutating(w.calls).length, 1);
});

test("bootstrap POST failure or network error = stop, never retried; secrets scrubbed from error", async () => {
  const cfg = testConfig();
  for (const [fault, code] of [[{ postStatus: 500 }, "BOOTSTRAP_NOT_VERIFIED"], [{ postNetworkError: true }, "UNKNOWN_OUTCOME"]]) {
    const env = setup(cfg); const w = mockWorld(cfg, fault); const { d, outLines } = deps(cfg, env, w);
    let err;
    await assert.rejects(run(["--execute"], d, cfg), (e) => { err = e; return e.code === code; });
    assert.equal(w.calls.filter((c) => c.path === "/operator/staging-bootstrap").length, 1);
    assert.ok(existsSync(join(env.priv, "c1-post-attempted")));
    const token = readFileSync(join(env.priv, "c1-bootstrap-approval-token"), "utf8").trim();
    const text = d.redactor.scrub(allOutput(outLines, err));
    assert.ok(!text.includes(token) && !text.includes(JWT) && !text.includes(API_TOKEN));
  }
});

test("D1 read that reports a write stops", async () => {
  const cfg = testConfig(); const env = setup(cfg); const w = mockWorld(cfg, { d1Wrote: true }); const { d } = deps(cfg, env, w);
  await assert.rejects(run(["--execute"], d, cfg), (e) => e.code === "D1_READ_WROTE");
  assert.deepEqual(mutating(w.calls), []);
});

test("guards: public worker, public D1, foreign account, non-allowlisted mutation, write SQL", async () => {
  const cfg = testConfig();
  const state = { mutationsEnabled: false, allowNext: null, apiToken: API_TOKEN };
  const cf = makeCf({ cfg, deps: { fetch: async () => { throw new Error("must not be called"); } }, state });
  await assert.rejects(cf.request("GET", `/accounts/${cfg.accountId}/workers/scripts/${cfg.publicWorker}/deployments`), (e) => e.code === "PUBLIC_TARGET_REJECTED");
  await assert.rejects(cf.request("GET", `/accounts/${cfg.accountId}/d1/database/${cfg.publicD1}`), (e) => e.code === "PUBLIC_TARGET_REJECTED");
  await assert.rejects(cf.request("GET", "/accounts/0000/workers/scripts/x"), (e) => e.code === "PATH_REJECTED");
  await assert.rejects(cf.request("PATCH", `/accounts/${cfg.accountId}/workers/workers/${cfg.worker}/versions/latest`), (e) => e.code === "MUTATION_DISABLED_IN_PREPARATION_MODE");
  state.mutationsEnabled = true;
  await assert.rejects(cf.request("DELETE", `/accounts/${cfg.accountId}/workers/scripts/${cfg.worker}/secrets/X`), (e) => e.code === "MUTATION_NOT_ALLOWLISTED");
  for (const sql of ["INSERT INTO x VALUES (1)", "SELECT 1; DELETE FROM x", "UPDATE x SET y=1", "PRAGMA writable_schema=1"]) assert.throws(() => assertReadOnlySql(sql), (e) => e.code === "SQL_NOT_READ_ONLY");
  assertReadOnlySql("SELECT id, name FROM d1_migrations ORDER BY id");
  assertReadOnlySql("PRAGMA foreign_key_check");
});

test("real config: template bindings hash and W1 body shape match the live read", () => {
  assert.equal(bindingsHash(BIND18), REAL_CONFIG.bindings18Sha256);
  const b = buildW1Body(BIND18, { token: "1".repeat(64) }, REAL_CONFIG);
  assert.equal(b.bindings.length, 21);
  assert.throws(() => buildW1Body(BIND18, { token: REAL_CONFIG.digest }, REAL_CONFIG), (e) => e.code === "APPROVAL_TOKEN_INVALID");
  assert.throws(() => buildW1Body(BIND18.slice(1), { token: "1".repeat(64) }, REAL_CONFIG), (e) => e.code === "BINDINGS_DRIFT");
});

test("redactor scrubs registered secrets, JWT shapes and bearer headers", () => {
  const r = new Redactor(); r.add("supersecretvalue123");
  const s = r.scrub(`x supersecretvalue123 y ${JWT} Authorization: Bearer abc.def`);
  assert.ok(!s.includes("supersecretvalue123") && !s.includes(JWT) && !s.includes("abc.def"));
});

test("plan/approval validators reject tampering", () => {
  const cfg = testConfig();
  const plan = makePlan(cfg);
  const rec = { ...FAKE, attestationRef: cfg.attestationRef };
  assert.equal(validatePlan(plan, rec, cfg), cfg.digest);
  assert.throws(() => validatePlan({ ...plan, ownerDisplayName: "X" }, rec, cfg), (e) => e.code === "PLAN_FIELD_MISMATCH");
  assert.throws(() => validatePlan({ ...plan, extra: "1" }, rec, cfg), (e) => e.code === "PLAN_FIELDS_INVALID");
  assert.throws(() => validatePlan(plan, { ...rec, subject: "other" }, cfg), (e) => e.code === "PLAN_IDENTITY_MISMATCH");
  assert.throws(() => parseApproval("action=x", cfg), (e) => e instanceof Stop);
});
