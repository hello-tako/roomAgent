import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import test from "node:test";
import {
  assertNoAttemptMarkers,
  ATTEMPT_MARKERS,
  ATTEMPT_MARKER_ERROR_CODES,
  ATTEMPT_MARKER_METADATA_KEYS,
  createAttemptMarker,
  LEGACY_ATTEMPT_MARKER,
} from "./attempt-markers.mjs";

const CORE_METADATA = Object.freeze({
  implementationSha: "a".repeat(40),
  manifestDigest: "b".repeat(64),
  sourceSha: "d".repeat(40),
  accountId: "staging-account-123",
  worker: "staging-worker",
  d1: "staging-database",
  approvalRef: "c1-request-123",
  timestamp: "2026-10-11T12:34:56.000Z",
});

function metadataFor(stage) {
  const stageMetadata = {
    W1: { baseVersion: "base-release-123" },
    W2: { newVersionId: "123e4567-e89b-42d3-a456-426614174000" },
    B1: {
      newVersionId: "123e4567-e89b-42d3-a456-426614174000",
      newDeploymentId: "223e4567-e89b-42d3-a456-426614174000",
    },
  };
  return { ...CORE_METADATA, ...stageMetadata[stage] };
}

function layout(t) {
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "c1-attempt-markers-"));
  const directory = join(root, "private");
  fs.mkdirSync(directory, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, directory };
}

function expectedCode(stage) {
  return ATTEMPT_MARKER_ERROR_CODES[`${stage}_ATTEMPTED`];
}

function expectCode(action, code) {
  let thrown;
  assert.throws(action, (error) => {
    thrown = error;
    return error instanceof Error && error.code === code && error.message === code;
  });
  return thrown;
}

function assertAttemptRefused(directory, stage, code = expectedCode(stage), options = {}) {
  return expectCode(
    () => createAttemptMarker({ directory, stage, metadata: metadataFor(stage), ...options }),
    code,
  );
}

test("creates each canonical stage marker exclusively at mode 0600 and fsyncs file and directory", (t) => {
  for (const stage of Object.keys(ATTEMPT_MARKERS)) {
    const { directory } = layout(t);
    const markerPath = join(directory, ATTEMPT_MARKERS[stage]);
    const trace = { fileSyncs: 0, directorySyncs: 0, markerOpen: null };
    const adapter = {
      openSync(path, flags, mode) {
        if (path === markerPath) trace.markerOpen = { flags, mode };
        return mode === undefined ? fs.openSync(path, flags) : fs.openSync(path, flags, mode);
      },
      fsyncSync(fd) {
        if (fs.fstatSync(fd).isDirectory()) trace.directorySyncs += 1;
        else trace.fileSyncs += 1;
        return fs.fsyncSync(fd);
      },
    };

    assert.equal(
      createAttemptMarker({ directory, stage, metadata: metadataFor(stage), fs: adapter }),
      ATTEMPT_MARKERS[stage],
    );
    assert.equal(fs.lstatSync(markerPath).mode & 0o7777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(markerPath, "utf8")), {
      version: 1,
      stage,
      marker: ATTEMPT_MARKERS[stage],
      metadata: metadataFor(stage),
    });
    assert.ok((trace.markerOpen.flags & fsConstants.O_CREAT) !== 0);
    assert.ok((trace.markerOpen.flags & fsConstants.O_EXCL) !== 0);
    assert.ok((trace.markerOpen.flags & fsConstants.O_NOFOLLOW) !== 0);
    assert.equal(trace.markerOpen.mode, 0o600);
    assert.equal(trace.fileSyncs, 1);
    assert.equal(trace.directorySyncs, 1);
    expectCode(() => assertNoAttemptMarkers(directory), expectedCode(stage));
  }
});

test("loops until short writes have written the complete marker", (t) => {
  const { directory } = layout(t);
  const markerPath = join(directory, ATTEMPT_MARKERS.W1);
  let writes = 0;
  const adapter = {
    writeSync(fd, buffer, offset, length, position) {
      writes += 1;
      return fs.writeSync(fd, buffer, offset, Math.min(length, 9), position);
    },
  };

  createAttemptMarker({ directory, stage: "W1", metadata: metadataFor("W1"), fs: adapter });
  assert.ok(writes > 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(markerPath, "utf8")).metadata, metadataFor("W1"));
});

test("creates W1, W2, and B1 markers in sequence while the next-run guard remains terminal", (t) => {
  const { directory } = layout(t);
  for (const stage of Object.keys(ATTEMPT_MARKERS)) {
    const metadata = metadataFor(stage);
    assert.equal(createAttemptMarker({ directory, stage, metadata }), ATTEMPT_MARKERS[stage]);
    assert.deepEqual(JSON.parse(fs.readFileSync(join(directory, ATTEMPT_MARKERS[stage]), "utf8")), {
      version: 1,
      stage,
      marker: ATTEMPT_MARKERS[stage],
      metadata,
    });
  }
  expectCode(() => assertNoAttemptMarkers(directory), expectedCode("W1"));
});

test("exports the exact integration allowlist and stage-specific refusal codes", () => {
  assert.deepEqual(ATTEMPT_MARKER_METADATA_KEYS, [
    "implementationSha",
    "manifestDigest",
    "sourceSha",
    "workerReleaseSha",
    "workerVersion",
    "accountId",
    "accountPublicId",
    "worker",
    "workerId",
    "workerName",
    "d1",
    "d1DatabaseId",
    "databaseId",
    "resourceId",
    "resourcePublicId",
    "approvalRef",
    "timestamp",
    "baseVersion",
    "newVersionId",
    "newDeploymentId",
  ]);
  assert.deepEqual(ATTEMPT_MARKER_ERROR_CODES, {
    W1_ATTEMPTED: "ALREADY_ATTEMPTED_W1",
    W2_ATTEMPTED: "ALREADY_ATTEMPTED_W2",
    B1_ATTEMPTED: "ALREADY_ATTEMPTED_B1",
    LEGACY_ATTEMPTED: "LEGACY_ALREADY_ATTEMPTED",
  });
});

test("rejects incomplete, unknown, identity-bearing, token-shaped, and accessor metadata", (t) => {
  const invalidMetadata = [
    { ...metadataFor("W1"), email: "owner@example.invalid" },
    {
      ...metadataFor("W1"),
      approvalRef: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature",
    },
    { ...metadataFor("W1"), workerReleaseSha: "Bearer abcdefghijklmnop" },
    { ...metadataFor("W1"), timestamp: "yesterday" },
    Object.fromEntries(Object.entries(metadataFor("W1")).filter(([key]) => key !== "accountId")),
  ];
  const accessorMetadata = { ...metadataFor("W1") };
  Object.defineProperty(accessorMetadata, "workerVersion", {
    enumerable: true,
    get() {
      throw new Error("sensitive getter message");
    },
  });
  invalidMetadata.push(accessorMetadata);

  for (const metadata of invalidMetadata) {
    const { directory } = layout(t);
    const error = expectCode(
      () => createAttemptMarker({ directory, stage: "W1", metadata }),
      "ATTEMPT_MARKER_METADATA_INVALID",
    );
    assert.doesNotMatch(error.message, /owner@example|sensitive|signature/i);
    assert.equal(fs.readdirSync(directory).length, 0);
  }
});

test("requires stage-specific version and deployment references", (t) => {
  const cases = [
    ["W1", "baseVersion"],
    ["W2", "newVersionId"],
    ["B1", "newVersionId"],
    ["B1", "newDeploymentId"],
  ];
  for (const [stage, missingKey] of cases) {
    const { directory } = layout(t);
    const metadata = { ...metadataFor(stage) };
    delete metadata[missingKey];
    expectCode(
      () => createAttemptMarker({ directory, stage, metadata }),
      "ATTEMPT_MARKER_METADATA_INVALID",
    );
    assert.equal(fs.readdirSync(directory).length, 0);
  }
});

test("refuses invalid stages and option shapes with sanitized coded errors", (t) => {
  const { directory } = layout(t);
  for (const stage of ["POST", "toString", "__proto__"]) {
    expectCode(
      () => createAttemptMarker({ directory, stage, metadata: metadataFor("W1") }),
      "ATTEMPT_MARKER_STAGE_INVALID",
    );
  }
  expectCode(
    () =>
      createAttemptMarker({
        directory,
        stage: "W1",
        metadata: metadataFor("W1"),
        identity: "private",
      }),
    "ATTEMPT_MARKER_INVALID_ARGUMENT",
  );
  expectCode(() => createAttemptMarker(null), "ATTEMPT_MARKER_INVALID_ARGUMENT");
  assert.equal(fs.readdirSync(directory).length, 0);
});

test("any pre-existing canonical stage blocks a new run without overwriting its bytes", (t) => {
  for (const stage of Object.keys(ATTEMPT_MARKERS)) {
    const { directory } = layout(t);
    const markerPath = join(directory, ATTEMPT_MARKERS[stage]);
    const original = Buffer.from(`old ${stage} attempt`);
    fs.writeFileSync(markerPath, original, { mode: 0o600, flag: "wx" });

    expectCode(() => assertNoAttemptMarkers(directory), expectedCode(stage));
    assertAttemptRefused(directory, stage);
    assert.deepEqual(fs.readFileSync(markerPath), original);
  }
});

test("the legacy POST marker blocks every stage and is never migrated or removed", (t) => {
  const { directory } = layout(t);
  const legacyPath = join(directory, LEGACY_ATTEMPT_MARKER);
  const original = Buffer.from("legacy attempt record");
  fs.writeFileSync(legacyPath, original, { mode: 0o600, flag: "wx" });

  expectCode(() => assertNoAttemptMarkers(directory), ATTEMPT_MARKER_ERROR_CODES.LEGACY_ATTEMPTED);
  for (const stage of Object.keys(ATTEMPT_MARKERS)) {
    assertAttemptRefused(directory, stage, ATTEMPT_MARKER_ERROR_CODES.LEGACY_ATTEMPTED);
  }
  assert.deepEqual(fs.readFileSync(legacyPath), original);
  assert.deepEqual(fs.readdirSync(directory), [LEGACY_ATTEMPT_MARKER]);
});

test("a marker symlink is treated as pre-existing and its target is not followed or changed", (t) => {
  const { root, directory } = layout(t);
  const victim = join(root, "victim");
  const markerPath = join(directory, ATTEMPT_MARKERS.W1);
  fs.writeFileSync(victim, "keep this target", { mode: 0o600 });
  fs.symlinkSync(victim, markerPath);

  expectCode(() => assertNoAttemptMarkers(directory), expectedCode("W1"));
  assertAttemptRefused(directory, "W1");
  assert.equal(fs.lstatSync(markerPath).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(victim, "utf8"), "keep this target");
});

test("rejects a symlink at the private directory or any ancestor", (t) => {
  const { root, directory } = layout(t);
  const finalLink = join(root, "private-link");
  fs.symlinkSync(directory, finalLink, "dir");
  expectCode(() => assertNoAttemptMarkers(finalLink), "ATTEMPT_MARKER_PARENT_UNSAFE");
  expectCode(
    () => createAttemptMarker({ directory: finalLink, stage: "W1", metadata: metadataFor("W1") }),
    "ATTEMPT_MARKER_PARENT_UNSAFE",
  );

  const actualParent = join(root, "actual-parent");
  const throughLink = join(root, "ancestor-link");
  fs.mkdirSync(actualParent, { mode: 0o700 });
  fs.mkdirSync(join(actualParent, "private"), { mode: 0o700 });
  fs.symlinkSync(actualParent, throughLink, "dir");
  const aliasedDirectory = join(throughLink, "private");
  expectCode(() => assertNoAttemptMarkers(aliasedDirectory), "ATTEMPT_MARKER_PARENT_UNSAFE");
  expectCode(
    () =>
      createAttemptMarker({
        directory: aliasedDirectory,
        stage: "W1",
        metadata: metadataFor("W1"),
      }),
    "ATTEMPT_MARKER_PARENT_UNSAFE",
  );
});

test("maps permission failures to a sanitized coded error", (t) => {
  const { directory } = layout(t);
  const markerPath = join(directory, ATTEMPT_MARKERS.W1);
  const adapter = {
    openSync(path, flags, mode) {
      if (path === markerPath) {
        const error = new Error("/private/path contains an API token");
        error.code = "EACCES";
        throw error;
      }
      return mode === undefined ? fs.openSync(path, flags) : fs.openSync(path, flags, mode);
    },
  };

  const error = assertAttemptRefused(directory, "W1", "ATTEMPT_MARKER_CREATE_FAILED", {
    fs: adapter,
  });
  assert.doesNotMatch(error.stack, /private\/path|API token/i);
  assert.equal(fs.existsSync(markerPath), false);
});

test("an interrupted partial write leaves its marker in place and all retries fail closed", (t) => {
  const { directory } = layout(t);
  const markerPath = join(directory, ATTEMPT_MARKERS.W1);
  let writes = 0;
  const adapter = {
    writeSync(fd, buffer, offset, length, position) {
      writes += 1;
      if (writes === 1) {
        fs.writeSync(fd, buffer, offset, Math.min(length, 13), position);
        throw new Error("private interrupted write");
      }
      return fs.writeSync(fd, buffer, offset, length, position);
    },
  };

  expectCode(
    () =>
      createAttemptMarker({
        directory,
        stage: "W1",
        metadata: metadataFor("W1"),
        fs: adapter,
      }),
    "ATTEMPT_MARKER_WRITE_FAILED",
  );
  const partial = fs.readFileSync(markerPath);
  assert.ok(partial.length > 0);
  assert.ok(
    partial.length <
      Buffer.byteLength(
        JSON.stringify({
          version: 1,
          stage: "W1",
          marker: ATTEMPT_MARKERS.W1,
          metadata: metadataFor("W1"),
        }) + "\n",
      ),
  );
  expectCode(() => assertNoAttemptMarkers(directory), expectedCode("W1"));
  assertAttemptRefused(directory, "W1");
  assert.deepEqual(fs.readFileSync(markerPath), partial);
});

test("file fsync failure leaves a non-recreatable marker", (t) => {
  const { directory } = layout(t);
  const markerPath = join(directory, ATTEMPT_MARKERS.W2);
  const adapter = {
    fsyncSync(fd) {
      if (!fs.fstatSync(fd).isDirectory()) throw new Error("file fsync failed with private detail");
      return fs.fsyncSync(fd);
    },
  };

  expectCode(
    () =>
      createAttemptMarker({
        directory,
        stage: "W2",
        metadata: metadataFor("W2"),
        fs: adapter,
      }),
    "ATTEMPT_MARKER_DURABILITY_FAILED",
  );
  const retained = fs.readFileSync(markerPath);
  assert.deepEqual(JSON.parse(retained.toString("utf8")).metadata, metadataFor("W2"));
  expectCode(() => assertNoAttemptMarkers(directory), expectedCode("W2"));
  assertAttemptRefused(directory, "W2");
  assert.deepEqual(fs.readFileSync(markerPath), retained);
});

test("unsupported directory fsync fails closed and preserves the marker for unknown-outcome reconciliation", (t) => {
  const { directory } = layout(t);
  const markerPath = join(directory, ATTEMPT_MARKERS.B1);
  const adapter = {
    fsyncSync(fd) {
      if (fs.fstatSync(fd).isDirectory()) {
        const error = new Error("directory fsync is unsupported");
        error.code = "EINVAL";
        throw error;
      }
      return fs.fsyncSync(fd);
    },
  };

  expectCode(
    () =>
      createAttemptMarker({
        directory,
        stage: "B1",
        metadata: metadataFor("B1"),
        fs: adapter,
      }),
    "ATTEMPT_MARKER_DURABILITY_FAILED",
  );
  const retained = fs.readFileSync(markerPath);
  assert.deepEqual(JSON.parse(retained.toString("utf8")).metadata, metadataFor("B1"));
  expectCode(() => assertNoAttemptMarkers(directory), expectedCode("B1"));
  assertAttemptRefused(directory, "B1");
  assert.deepEqual(fs.readFileSync(markerPath), retained);
});

test("a process restart after partial execution detects W1 and cannot start W2", (t) => {
  const { directory } = layout(t);
  createAttemptMarker({ directory, stage: "W1", metadata: metadataFor("W1") });

  const moduleUrl = new URL("./attempt-markers.mjs", import.meta.url).href;
  const source = `
    import { assertNoAttemptMarkers } from ${JSON.stringify(moduleUrl)};
    try {
      assertNoAttemptMarkers(process.argv[1]);
      console.log("CLEAR");
    } catch (error) {
      console.log(error.code);
      process.exitCode = 17;
    }
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source, directory], {
    encoding: "utf8",
  });

  assert.equal(child.status, 17, child.stderr);
  assert.equal(child.stdout.trim(), expectedCode("W1"));
  assert.equal(fs.existsSync(join(directory, ATTEMPT_MARKERS.W2)), false);
  assert.equal(fs.existsSync(join(directory, ATTEMPT_MARKERS.B1)), false);
});

test("simultaneous creators have exactly one exclusive winner", async (t) => {
  const { root, directory } = layout(t);
  const moduleUrl = new URL("./attempt-markers.mjs", import.meta.url).href;
  const gate = join(root, "go");
  const ready = [join(root, "ready-1"), join(root, "ready-2")];
  const source = `
    import { existsSync, writeFileSync } from "node:fs";
    import { createAttemptMarker } from ${JSON.stringify(moduleUrl)};
    const [directory, readyPath, gatePath] = process.argv.slice(1);
    writeFileSync(readyPath, "ready", { flag: "wx", mode: 0o600 });
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 5000;
    while (!existsSync(gatePath)) {
      if (Date.now() > deadline) process.exit(18);
      Atomics.wait(waitCell, 0, 0, 5);
    }
    try {
      createAttemptMarker({ directory, stage: "W1", metadata: ${JSON.stringify(metadataFor("W1"))} });
      console.log("CREATED");
    } catch (error) {
      console.log(error.code ?? "UNCODED_ERROR");
      process.exitCode = 2;
    }
  `;

  const children = ready.map((readyPath) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", source, directory, readyPath, gate],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const closed = new Promise((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    return { child, closed, readyPath };
  });

  try {
    const deadline = Date.now() + 5000;
    while (!ready.every((path) => fs.existsSync(path))) {
      if (Date.now() > deadline) throw new Error("marker creator children did not become ready");
      await delay(5);
    }
    fs.writeFileSync(gate, "go", { flag: "wx", mode: 0o600 });
    const results = await Promise.all(children.map(({ closed }) => closed));
    assert.deepEqual(
      results.map((result) => result.stdout.trim()).sort(),
      ["CREATED", expectedCode("W1")].sort(),
    );
    assert.deepEqual(
      results.map((result) => result.code).sort((left, right) => left - right),
      [0, 2],
    );
    assert.equal(fs.lstatSync(join(directory, ATTEMPT_MARKERS.W1)).mode & 0o7777, 0o600);
    assert.equal(fs.readdirSync(directory).length, 1);
  } finally {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }
});
