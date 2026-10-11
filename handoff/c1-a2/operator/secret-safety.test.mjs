import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { scanTrackedFiles, SYSTEM_GIT_PATH } from "./secret-safety.mjs";

const OPERATOR_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(OPERATOR_DIR, "../../..");
const SCRIPT_PATH = join(OPERATOR_DIR, "secret-safety.mjs");
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTemporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "roomagent-secret-safety-"));
  temporaryDirectories.push(directory);
  return directory;
}

function findingsFor(entries) {
  return scanTrackedFiles(entries);
}

function git(args, cwd, capture = false) {
  return execFileSync(SYSTEM_GIT_PATH, args, {
    cwd,
    encoding: capture ? "buffer" : "utf8",
    stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore",
  });
}

function readPublicOperatorFiles(
  directory = OPERATOR_DIR,
  trackedPrefix = "handoff/c1-a2/operator",
) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name.toLowerCase() !== "private") {
        files.push(
          ...readPublicOperatorFiles(join(directory, entry.name), `${trackedPrefix}/${entry.name}`),
        );
      }
    } else if (entry.isFile()) {
      files.push({
        path: `${trackedPrefix}/${entry.name}`,
        content: readFileSync(join(directory, entry.name)),
      });
    }
  }
  return files;
}

test("tracked private directories fail closed without reading their content", () => {
  const entries = [
    {
      path: "handoff/c1-a2/operator/private/c1-access-attestation.json",
      content: "MOCK_PRIVATE_RECORD_CANARY",
    },
    {
      path: "handoff/another-bundle/private/runtime.txt",
      content: "MOCK_RUNTIME_CANARY",
    },
    {
      path: "c1-operator/private/session.json",
      content: "MOCK_SESSION_CANARY",
    },
  ];

  assert.deepEqual(findingsFor(entries), [
    {
      code: "TRACKED_PRIVATE_PATH",
      path: "c1-operator/private/session.json",
    },
    {
      code: "TRACKED_PRIVATE_PATH",
      path: "handoff/another-bundle/private/runtime.txt",
    },
    {
      code: "TRACKED_PRIVATE_PATH",
      path: "handoff/c1-a2/operator/private/c1-access-attestation.json",
    },
  ]);
});

test("private operator artifacts are detected outside private directories", () => {
  const paths = [
    "handoff/c1-a2/operator/c1-access-attestation.json",
    "handoff/c1-a2/operator/identity-record.json",
    "handoff/c1-a2/operator/c1-private-plan.txt",
    "handoff/c1-a2/operator/c1-owner-approval.txt",
    "handoff/c1-a2/operator/expected-email-hash.txt",
    "handoff/c1-a2/operator/api-approval-token.txt",
    "handoff/c1-a2/operator/access-session-token.json",
    "handoff/c1-a2/operator/w1-attempt-markers.json",
    "handoff/c1-a2/operator/c1-exec-receipt.json",
  ];
  const entries = paths.map((path) => ({ path, content: "{}" }));

  assert.deepEqual(
    findingsFor(entries),
    paths
      .map((path) => ({ code: "TRACKED_PRIVATE_ARTIFACT", path }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  );
});

test("public receipts with credential, JWT, authorization, and email values are reported by code and path only", () => {
  const sessionCanary = ["MOCK", "SESSION", "CANARY", "8d21"].join("_");
  const accessTokenCanary = ["MOCK", "ACCESS", "TOKEN", "1c45"].join("_");
  const emailCanary = ["operator", "@", "canary", ".invalidtld"].join("");
  const jwtCanary = [
    Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: "canary" })).toString("base64url"),
    "signaturecanary12345678901234567890",
  ].join(".");
  const receipt = JSON.stringify({
    operator_email: emailCanary,
    authorization: `Bearer ${accessTokenCanary}`,
    session_token: sessionCanary,
    access_jwt: jwtCanary,
  });
  const findings = findingsFor([{ path: "handoff/c1-a2/operator/receipt.json", content: receipt }]);

  assert.deepEqual(
    new Set(findings.map(({ code }) => code)),
    new Set([
      "SENSITIVE_CREDENTIAL_ASSIGNMENT",
      "AUTHORIZATION_HEADER",
      "LITERAL_JWT",
      "REAL_OPERATOR_EMAIL",
      "PRIVATE_IDENTITY_RECORD",
    ]),
  );
  assert.ok(findings.every(({ path }) => path === "handoff/c1-a2/operator/receipt.json"));
  const serializedFindings = JSON.stringify(findings);
  assert.equal(
    serializedFindings.includes(sessionCanary),
    false,
    "findings must omit secret values",
  );
  assert.equal(
    serializedFindings.includes(accessTokenCanary),
    false,
    "findings must omit token values",
  );
  assert.equal(serializedFindings.includes(emailCanary), false, "findings must omit email values");
  assert.equal(serializedFindings.includes(jwtCanary), false, "findings must omit JWT values");
});

test("JSON secret_text bindings require placeholders and public hashes remain allowed", () => {
  const tokenName = ["CLOUDFLARE", "_API_TOKEN"].join("");
  const canaryValue = ["MOCK", "CF", "TOKEN", "CANARY", "73ae"].join("_");
  const actualBinding = JSON.stringify({
    [tokenName]: canaryValue,
    bindings: [{ name: tokenName, type: "secret_text", text: canaryValue }],
  });
  const placeholderBinding = JSON.stringify({
    bindings: [
      {
        name: tokenName,
        type: "secret_text",
        text: "<PLACEHOLDER_CLOUDFLARE_API_TOKEN>",
      },
    ],
  });
  const implementationSha = "a".repeat(40);
  const manifestDigest = "b".repeat(64);
  const findings = findingsFor([
    {
      path: "handoff/c1-a2/operator/fixture.json",
      content: actualBinding,
    },
    {
      path: "handoff/c1-a2/19_W1_REQUEST_BODY_PLACEHOLDER.json",
      content: placeholderBinding,
    },
    {
      path: "handoff/c1-a2/public-hashes.txt",
      content: `IMPLEMENTATION_SHA=${implementationSha}\n${manifestDigest}\n`,
    },
  ]);

  assert.deepEqual(findings, [
    {
      code: "SECRET_TEXT_BINDING_VALUE",
      path: "handoff/c1-a2/operator/fixture.json",
    },
    {
      code: "SENSITIVE_CREDENTIAL_ASSIGNMENT",
      path: "handoff/c1-a2/operator/fixture.json",
    },
  ]);
  assert.equal(
    JSON.stringify(findings).includes(canaryValue),
    false,
    "findings must omit binding values",
  );
});

test("the runner's exact API token and example.test email mocks stay allowed without ignoring tests", () => {
  const runnerPath = "handoff/c1-a2/operator/c1-runner.test.mjs";
  const fakeValue = ["TESTAPITOKEN_", "abcdefghijklmnopqrstuvwxyz012345"].join("");
  const fakeAssignment = [
    "const ",
    "API_TOKEN",
    " = ",
    JSON.stringify(fakeValue),
    ";\nconst email = ",
    JSON.stringify(["operator", "@example.test"].join("")),
    ";",
  ].join("");
  const allowed = findingsFor([{ path: runnerPath, content: fakeAssignment }]);
  assert.deepEqual(allowed, []);

  const changedValue = ["MOCK", "API", "TOKEN", "CANARY", "60d3"].join("_");
  const unsafeAssignment = ["const ", "API_TOKEN", " = ", JSON.stringify(changedValue), ";"].join(
    "",
  );
  assert.deepEqual(findingsFor([{ path: runnerPath, content: unsafeAssignment }]), [
    {
      code: "SENSITIVE_CREDENTIAL_ASSIGNMENT",
      path: runnerPath,
    },
  ]);
});

test("dynamic credential references and the known generated test filler are not literal secrets", () => {
  const source = [
    "const token = process.env.CLOUDFLARE_API_TOKEN;",
    "const reservationToken = reservation.uploadToken;",
    "const suppliedToken = request.header('x-bootstrap-approval-token');",
    "if (input.tokenSecret === input.planDigest) { return false; }",
  ].join("\n");
  assert.deepEqual(
    findingsFor([
      {
        path: "apps/api/src/staging-bootstrap-route.ts",
        content: source,
      },
    ]),
    [],
  );

  const fixturePath = "scripts/test-staging-bootstrap.py";
  const tokenKey = ["BOOTSTRAP_APPROVAL", "_TOKEN"].join("");
  const filler = ["x", "0"].join("");
  const generatedCanary = `{"${tokenKey}": ${JSON.stringify(filler)} * 32}`;
  assert.deepEqual(findingsFor([{ path: fixturePath, content: generatedCanary }]), []);

  const unsafeValue = ["MOCK", "APPROVAL", "CANARY", "31fd"].join("_");
  const literalCanary = `{"${tokenKey}": ${JSON.stringify(unsafeValue)}}`;
  assert.deepEqual(findingsFor([{ path: fixturePath, content: literalCanary }]), [
    {
      code: "SENSITIVE_CREDENTIAL_ASSIGNMENT",
      path: fixturePath,
    },
  ]);
});

test("current public operator files, placeholders, and owner template stay clean", () => {
  const files = [
    {
      path: "handoff/c1-a2/19_W1_REQUEST_BODY_PLACEHOLDER.json",
      content: readFileSync(
        join(REPO_ROOT, "handoff/c1-a2/19_W1_REQUEST_BODY_PLACEHOLDER.json"),
        "utf8",
      ),
    },
    {
      path: "handoff/c1-a2/operator/c1-owner-approval.TEMPLATE.txt",
      content: readFileSync(join(OPERATOR_DIR, "c1-owner-approval.TEMPLATE.txt"), "utf8"),
    },
    ...readPublicOperatorFiles(),
  ];

  assert.deepEqual(findingsFor(files), []);
});

test("the checked-in ignore rules protect private directories from git add -A", () => {
  const directory = makeTemporaryDirectory();
  writeFileSync(join(directory, ".gitignore"), readFileSync(join(REPO_ROOT, ".gitignore"), "utf8"));
  git(["init", "-q"], directory);

  const privateFiles = [
    "handoff/c1-a2/operator/private/attestation.json",
    "handoff/another-bundle/private/receipt.json",
    "c1-operator/private/session.txt",
  ];
  for (const path of privateFiles) {
    const absolutePath = join(directory, path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, "temporary fixture");
  }
  writeFileSync(join(directory, "public.txt"), "tracked fixture");

  git(["add", "-A"], directory);
  const trackedPaths = git(["ls-files", "-z"], directory, true)
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  assert.deepEqual(trackedPaths, [".gitignore", "public.txt"]);
  assert.deepEqual(findingsFor([{ path: "docs/PLAN.md", content: "public plan" }]), []);

  git(["add", "-f", ...privateFiles], directory);
  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: directory,
    encoding: "utf8",
    timeout: 15_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(result.status, 1, "CLI should fail when an ignored private path is already tracked");
  assert.ok(output.includes("TRACKED_PRIVATE_PATH"), "CLI should report the private-path code");
  assert.equal(
    output.includes("temporary fixture"),
    false,
    "CLI must not print private file contents",
  );
});

test("the CLI scans tracked and untracked bundle paths without printing canaries", () => {
  const directory = makeTemporaryDirectory();
  git(["init", "-q"], directory);
  const tokenCanary = ["MOCK", "SESSION", "CANARY", "4d73"].join("_");
  const emailCanary = ["operator", "@", "canary", ".invalidtld"].join("");
  const fileNameCanary = ["MOCK", "FILE", "CANARY", "5f2a"].join("_");
  const trackedPath = "tracked-receipt.json";
  const bundlePath = `handoff/c1-a2/operator/${fileNameCanary}-${emailCanary}.json`;
  const ignoredPublicPath = "handoff/c1-a2/operator/.env";
  const ignoredTokenCanary = ["MOCK", "IGNORED", "TOKEN", "CANARY", "66bc"].join("_");
  const privatePath = "handoff/c1-a2/operator/private/identity.json";
  const privateCanary = ["MOCK", "PRIVATE", "CANARY", "21d8"].join("_");
  writeFileSync(join(directory, ".gitignore"), readFileSync(join(REPO_ROOT, ".gitignore"), "utf8"));
  writeFileSync(join(directory, trackedPath), JSON.stringify({ session_token: tokenCanary }));
  git(["add", ".gitignore", trackedPath], directory);
  mkdirSync(dirname(join(directory, bundlePath)), { recursive: true });
  writeFileSync(
    join(directory, bundlePath),
    JSON.stringify({ session_token: tokenCanary, operator_email: emailCanary }),
  );
  writeFileSync(join(directory, ignoredPublicPath), `SESSION_TOKEN=${ignoredTokenCanary}\n`);
  mkdirSync(dirname(join(directory, privatePath)), { recursive: true });
  writeFileSync(join(directory, privatePath), JSON.stringify({ session_token: privateCanary }));

  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: directory,
    encoding: "utf8",
    timeout: 15_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.equal(result.status, 1, "CLI should fail on tracked and untracked sensitive values");
  assert.ok(output.includes("SENSITIVE_CREDENTIAL_ASSIGNMENT"), "CLI should report a finding code");
  assert.ok(
    output.includes("REAL_OPERATOR_EMAIL"),
    "CLI should detect untracked public bundle content",
  );
  const bundlePathDigest = createHash("sha256").update(bundlePath).digest("hex");
  assert.ok(
    output.includes(`path_sha256=${bundlePathDigest}`),
    "CLI should report a one-way path digest for the untracked file",
  );
  const ignoredPublicPathDigest = createHash("sha256").update(ignoredPublicPath).digest("hex");
  assert.ok(
    output.includes(`path_sha256=${ignoredPublicPathDigest}`),
    "CLI should also scan ignored-but-public bundle files",
  );
  assert.equal(output.includes(tokenCanary), false, "CLI output must omit token values");
  assert.equal(output.includes(emailCanary), false, "CLI output must omit email values");
  assert.equal(output.includes(fileNameCanary), false, "CLI output must omit filename canaries");
  assert.equal(
    output.includes(ignoredTokenCanary),
    false,
    "CLI output must omit ignored-file values",
  );
  assert.equal(
    output.includes("TRACKED_PRIVATE_PATH"),
    false,
    "CLI should skip ignored private paths",
  );
  assert.equal(output.includes(privateCanary), false, "CLI output must omit private file contents");
});
