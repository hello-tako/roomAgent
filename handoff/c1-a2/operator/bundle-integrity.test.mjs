import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { verifyBundleIntegrity, verifyManifestConsistency } from "./bundle-integrity.mjs";

const IMPLEMENTATION_SHA = "a".repeat(40);
const PRIVATE_DIR_PATH = "operator/private";
const OUTER_MANIFEST_PATH = "BUNDLE_SHA256SUMS";
const OPERATOR_MANIFEST_PATH = "operator/SHA256SUMS";
const W1_TEMPLATE_PATH = "19_W1_REQUEST_BODY_PLACEHOLDER.json";
const MINIMAL_BUNDLE_FILES = {
  "18_FINAL_C1_APPROVAL_MANIFEST.md": "approval-manifest\n",
  "19_MUTATION_GATE_FINAL_CHECK.md": "mutation-gate\n",
  [W1_TEMPLATE_PATH]: '{"bindings":[]}\n',
  "20_A2_EXECUTION_PACKAGE.md": "execution-package\n",
  "HANDOFF_META/INVENTORY.md": "inventory\n",
  "HANDOFF_README.md": "handoff\n",
  "operator/attest-access-identity.mjs": "attestation\n",
  "operator/bundle-integrity.mjs": "integrity-module\n",
  "operator/bundle-integrity.test.mjs": "integrity-tests\n",
  "operator/c1-owner-approval.TEMPLATE.txt": "approval-template\n",
  "operator/c1-runner.mjs": "runner\n",
  "operator/c1-runner.test.mjs": "runner-tests\n",
  "operator/fixtures/bindings18.json": "[]\n",
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeManifest(bundleDir, manifestPath, paths) {
  const lines = [...paths]
    .sort()
    .map((path) => `${sha256(readFileSync(join(bundleDir, ...path.split("/"))))}  ${path}`);
  writeFileSync(join(bundleDir, ...manifestPath.split("/")), `${lines.join("\n")}\n`);
}

function findPublicFiles(bundleDir) {
  const files = [];

  function visit(directory, relativeDirectory = "") {
    for (const name of readdirSync(directory).sort()) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (relativePath === PRIVATE_DIR_PATH) continue;

      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path, relativePath);
      else if (stat.isFile()) files.push(relativePath);
    }
  }

  visit(bundleDir);
  return files.sort();
}

function rebuildOperatorManifest(bundleDir) {
  const paths = findPublicFiles(bundleDir).filter(
    (path) =>
      (path.startsWith("operator/") && path !== OPERATOR_MANIFEST_PATH) ||
      path === W1_TEMPLATE_PATH,
  );
  writeManifest(bundleDir, OPERATOR_MANIFEST_PATH, paths);
}

function rebuildOuterManifest(bundleDir) {
  const paths = findPublicFiles(bundleDir).filter((path) => path !== OUTER_MANIFEST_PATH);
  writeManifest(bundleDir, OUTER_MANIFEST_PATH, paths);
  return sha256(readFileSync(join(bundleDir, OUTER_MANIFEST_PATH)));
}

function rebuildManifests(bundleDir) {
  rebuildOperatorManifest(bundleDir);
  return rebuildOuterManifest(bundleDir);
}

function createBundle(t) {
  const tempRoot = mkdtempSync(join(tmpdir(), "roomagent-c1-integrity-"));
  const bundleDir = join(tempRoot, "bundle");
  mkdirSync(bundleDir);
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

  for (const [path, content] of Object.entries(MINIMAL_BUNDLE_FILES)) {
    const destination = join(bundleDir, ...path.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }

  const trustedManifestDigest = rebuildManifests(bundleDir);
  return { bundleDir, trustedManifestDigest };
}

function verify(bundle, overrides = {}) {
  return verifyBundleIntegrity({
    bundleDir: bundle.bundleDir,
    trustedManifestDigest: bundle.trustedManifestDigest,
    implementationSha: IMPLEMENTATION_SHA,
    actualImplementationSha: IMPLEMENTATION_SHA,
    ...overrides,
  });
}

function expectCode(operation, code) {
  assert.throws(
    operation,
    (error) => error?.code === code && error.message === code && error.cause === undefined,
  );
}

function withFsOverrides(overrides, operation) {
  const originals = new Map();
  for (const [name, replace] of Object.entries(overrides)) {
    const original = fs[name];
    originals.set(name, original);
    fs[name] = replace(original);
  }

  try {
    return operation();
  } finally {
    for (const [name, original] of originals) fs[name] = original;
  }
}

function fsError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function replaceTrustedManifestDigest(bundle, digest) {
  return verify({ ...bundle, trustedManifestDigest: digest });
}

test("verifies both exact manifests and returns their public digests", (t) => {
  const bundle = createBundle(t);

  const result = verify(bundle);

  assert.deepEqual(result, {
    bundleManifestDigest: bundle.trustedManifestDigest,
    operatorManifestDigest: sha256(readFileSync(join(bundle.bundleDir, OPERATOR_MANIFEST_PATH))),
  });
});

test("exposes local consistency without treating recomputed manifests as owner approval", (t) => {
  const bundle = createBundle(t);
  const runner = join(bundle.bundleDir, "operator/c1-runner.mjs");
  writeFileSync(runner, `${readFileSync(runner, "utf8")}x`);
  const locallyRecomputedDigest = rebuildManifests(bundle.bundleDir);

  const result = verifyManifestConsistency(bundle.bundleDir);

  assert.notEqual(result.bundleManifestDigest, bundle.trustedManifestDigest);
  assert.equal(result.bundleManifestDigest, locallyRecomputedDigest);
  assert.equal(
    result.operatorManifestDigest,
    sha256(readFileSync(join(bundle.bundleDir, OPERATOR_MANIFEST_PATH))),
  );
});

test("rejects one-byte drift in a controlled source file", (t) => {
  const bundle = createBundle(t);
  const runner = join(bundle.bundleDir, "operator/c1-runner.mjs");
  writeFileSync(runner, `${readFileSync(runner, "utf8")}x`);

  expectCode(() => verify(bundle), "MANIFEST_HASH_MISMATCH");
});

test("rejects source and manifest recomputation without a newly trusted outer digest", (t) => {
  const bundle = createBundle(t);
  const runner = join(bundle.bundleDir, "operator/c1-runner.mjs");
  writeFileSync(runner, `${readFileSync(runner, "utf8")}x`);
  const recomputedDigest = rebuildManifests(bundle.bundleDir);

  assert.notEqual(recomputedDigest, bundle.trustedManifestDigest);
  expectCode(() => verify(bundle), "TRUSTED_MANIFEST_DIGEST_MISMATCH");
});

test("rejects public files omitted from the outer manifest", (t) => {
  const bundle = createBundle(t);
  const manifestPath = join(bundle.bundleDir, OUTER_MANIFEST_PATH);
  const lines = readFileSync(manifestPath, "utf8")
    .trimEnd()
    .split("\n")
    .filter((line) => !line.endsWith("  HANDOFF_README.md"));
  writeFileSync(manifestPath, `${lines.join("\n")}\n`);
  const ownerApprovedDigest = sha256(readFileSync(manifestPath));

  expectCode(
    () => replaceTrustedManifestDigest(bundle, ownerApprovedDigest),
    "MANIFEST_FILE_UNLISTED",
  );
});

test("rejects outer manifest entries for nonexistent files", (t) => {
  const bundle = createBundle(t);
  const manifestPath = join(bundle.bundleDir, OUTER_MANIFEST_PATH);
  const current = readFileSync(manifestPath, "utf8");
  const lines = current.trimEnd().split("\n");
  lines.push(`${"f".repeat(64)}  HANDOFF_META/NOT_IN_BUNDLE.md`);
  writeFileSync(manifestPath, `${lines.join("\n")}\n`);
  const ownerApprovedDigest = sha256(readFileSync(manifestPath));

  expectCode(
    () => replaceTrustedManifestDigest(bundle, ownerApprovedDigest),
    "MANIFEST_ENTRY_MISSING",
  );
});

test("rejects missing operator entries even when the outer manifest is updated", (t) => {
  const bundle = createBundle(t);
  const manifestPath = join(bundle.bundleDir, OPERATOR_MANIFEST_PATH);
  const lines = readFileSync(manifestPath, "utf8")
    .trimEnd()
    .split("\n")
    .filter((line) => !line.endsWith("  operator/c1-runner.mjs"));
  writeFileSync(manifestPath, `${lines.join("\n")}\n`);
  const ownerApprovedDigest = rebuildOuterManifest(bundle.bundleDir);

  expectCode(
    () => replaceTrustedManifestDigest(bundle, ownerApprovedDigest),
    "MANIFEST_FILE_UNLISTED",
  );
});

test("rejects duplicate operator manifest entries", (t) => {
  const bundle = createBundle(t);
  const manifestPath = join(bundle.bundleDir, OPERATOR_MANIFEST_PATH);
  const original = readFileSync(manifestPath, "utf8");
  writeFileSync(manifestPath, `${original}${original.split("\n")[0]}\n`);
  const ownerApprovedDigest = rebuildOuterManifest(bundle.bundleDir);

  expectCode(
    () => replaceTrustedManifestDigest(bundle, ownerApprovedDigest),
    "MANIFEST_ENTRY_DUPLICATE",
  );
});

test("rejects traversal and non-regular operator manifest entries", (t) => {
  const traversalBundle = createBundle(t);
  const traversalManifest = join(traversalBundle.bundleDir, OPERATOR_MANIFEST_PATH);
  const traversalLine = `${"0".repeat(64)}  ../outside.txt\n`;
  writeFileSync(traversalManifest, `${readFileSync(traversalManifest, "utf8")}${traversalLine}`);
  const traversalDigest = rebuildOuterManifest(traversalBundle.bundleDir);
  expectCode(
    () => replaceTrustedManifestDigest(traversalBundle, traversalDigest),
    "MANIFEST_ENTRY_PATH_INVALID",
  );

  const nonRegularBundle = createBundle(t);
  const nonRegularManifest = join(nonRegularBundle.bundleDir, OPERATOR_MANIFEST_PATH);
  const directoryEntry = `${"0".repeat(64)}  operator/fixtures\n`;
  writeFileSync(nonRegularManifest, `${readFileSync(nonRegularManifest, "utf8")}${directoryEntry}`);
  const nonRegularDigest = rebuildOuterManifest(nonRegularBundle.bundleDir);
  expectCode(
    () => replaceTrustedManifestDigest(nonRegularBundle, nonRegularDigest),
    "MANIFEST_ENTRY_MISSING",
  );
});

test("rejects out-of-scope operator entries", (t) => {
  const bundle = createBundle(t);
  const manifestPath = join(bundle.bundleDir, OPERATOR_MANIFEST_PATH);
  const readmeDigest = sha256(readFileSync(join(bundle.bundleDir, "HANDOFF_README.md")));
  writeFileSync(
    manifestPath,
    `${readFileSync(manifestPath, "utf8")}${readmeDigest}  HANDOFF_README.md\n`,
  );
  const ownerApprovedDigest = rebuildOuterManifest(bundle.bundleDir);

  expectCode(
    () => replaceTrustedManifestDigest(bundle, ownerApprovedDigest),
    "MANIFEST_ENTRY_UNEXPECTED",
  );
});

test("requires a pinned digest and a matching full implementation commit SHA", (t) => {
  const bundle = createBundle(t);

  expectCode(
    () => verify(bundle, { trustedManifestDigest: undefined }),
    "TRUSTED_MANIFEST_DIGEST_INVALID",
  );
  expectCode(
    () => verify(bundle, { trustedManifestDigest: "a".repeat(63) }),
    "TRUSTED_MANIFEST_DIGEST_INVALID",
  );
  expectCode(
    () => verify(bundle, { implementationSha: "worker-source-label" }),
    "IMPLEMENTATION_SHA_INVALID",
  );
  expectCode(
    () => verify(bundle, { implementationSha: undefined, sourceSha: IMPLEMENTATION_SHA }),
    "IMPLEMENTATION_SHA_INVALID",
  );
  expectCode(
    () => verify(bundle, { implementationSha: "b".repeat(40) }),
    "IMPLEMENTATION_SHA_MISMATCH",
  );
  expectCode(
    () => verify(bundle, { actualImplementationSha: "worker-source-label" }),
    "ACTUAL_IMPLEMENTATION_SHA_INVALID",
  );
});

test("rejects symlinked public files and ancestor directories", (t) => {
  const fileBundle = createBundle(t);
  const outsideFile = join(join(fileBundle.bundleDir, ".."), "outside-runner.mjs");
  const runner = join(fileBundle.bundleDir, "operator/c1-runner.mjs");
  writeFileSync(outsideFile, "external\n");
  unlinkSync(runner);
  symlinkSync(outsideFile, runner);
  expectCode(() => verify(fileBundle), "BUNDLE_PATH_SYMLINK");

  const ancestorBundle = createBundle(t);
  const operatorPath = join(ancestorBundle.bundleDir, "operator");
  const movedOperatorPath = join(ancestorBundle.bundleDir, "operator-real");
  renameSync(operatorPath, movedOperatorPath);
  symlinkSync(movedOperatorPath, operatorPath, "dir");
  expectCode(() => verify(ancestorBundle), "BUNDLE_PATH_SYMLINK");
});

test("rejects symlinked bundle path ancestors", (t) => {
  const bundle = createBundle(t);
  const alias = join(bundle.bundleDir, "..", "bundle-alias");
  symlinkSync(bundle.bundleDir, alias, "dir");

  expectCode(() => verify(bundle, { bundleDir: alias }), "BUNDLE_PATH_SYMLINK");
});

test("excludes only operator/private runtime data and rejects private symlinks", (t) => {
  const bundle = createBundle(t);
  const privateDir = join(bundle.bundleDir, PRIVATE_DIR_PATH);
  mkdirSync(privateDir);
  writeFileSync(join(privateDir, "c1-owner-approval.txt"), "mock approval\n");
  assert.doesNotThrow(() => verify(bundle));

  const unexpectedRuntimeFile = join(bundle.bundleDir, "operator/runtime/receipt.json");
  mkdirSync(dirname(unexpectedRuntimeFile), { recursive: true });
  writeFileSync(unexpectedRuntimeFile, "mock receipt\n");
  expectCode(() => verify(bundle), "MANIFEST_FILE_UNLISTED");
  rmSync(join(bundle.bundleDir, "operator/runtime"), { recursive: true, force: true });

  const outsideDir = join(bundle.bundleDir, "..", "outside-private");
  mkdirSync(outsideDir);
  rmSync(privateDir, { recursive: true, force: true });
  symlinkSync(outsideDir, privateDir, "dir");
  expectCode(() => verify(bundle), "BUNDLE_PATH_SYMLINK");
});

test("rejects a symlink swapped in after path inspection and before open", (t) => {
  const bundle = createBundle(t);
  const runner = join(bundle.bundleDir, "operator/c1-runner.mjs");
  const outside = join(bundle.bundleDir, "..", "outside-runner.mjs");
  writeFileSync(outside, "outside\n");
  let swapped = false;

  withFsOverrides(
    {
      openSync:
        (original) =>
        (path, ...args) => {
          if (path === runner && !swapped) {
            swapped = true;
            unlinkSync(runner);
            symlinkSync(outside, runner);
          }
          return original(path, ...args);
        },
    },
    () => expectCode(() => verify(bundle), "BUNDLE_PATH_SYMLINK"),
  );

  assert.equal(swapped, true);
});

test("rejects a regular file replacement between path inspection and open", (t) => {
  const bundle = createBundle(t);
  const runner = join(bundle.bundleDir, "operator/c1-runner.mjs");
  let replaced = false;

  withFsOverrides(
    {
      openSync:
        (original) =>
        (path, ...args) => {
          if (path === runner && !replaced) {
            replaced = true;
            renameSync(runner, runner + ".original");
            writeFileSync(runner, "replacement\n");
          }
          return original(path, ...args);
        },
    },
    () => expectCode(() => verify(bundle), "BUNDLE_FILE_CHANGED"),
  );

  assert.equal(replaced, true);
});

test("reads from the opened descriptor and rejects a pathname replacement during read", (t) => {
  const bundle = createBundle(t);
  const runner = join(bundle.bundleDir, "operator/c1-runner.mjs");
  const originalContents = readFileSync(runner);
  const openedPaths = new Map();
  let replaced = false;
  let bytesRead;

  withFsOverrides(
    {
      openSync:
        (original) =>
        (path, ...args) => {
          const descriptor = original(path, ...args);
          openedPaths.set(descriptor, path);
          return descriptor;
        },
      readFileSync:
        (original) =>
        (pathOrDescriptor, ...args) => {
          if (openedPaths.get(pathOrDescriptor) === runner && !replaced) {
            replaced = true;
            renameSync(runner, runner + ".original");
            writeFileSync(runner, "replacement\n");
          }
          const bytes = original(pathOrDescriptor, ...args);
          if (openedPaths.get(pathOrDescriptor) === runner) bytesRead = bytes;
          return bytes;
        },
    },
    () => expectCode(() => verify(bundle), "BUNDLE_FILE_CHANGED"),
  );

  assert.equal(replaced, true);
  assert.deepEqual(bytesRead, originalContents);
});

test("rejects descriptor device or inode changes after open", (t) => {
  for (const field of ["dev", "ino"]) {
    const bundle = createBundle(t);
    const runner = join(bundle.bundleDir, "operator/c1-runner.mjs");
    assert.equal(readFileSync(runner, "utf8"), "runner\n");
    const openedPaths = new Map();
    let changed = false;

    withFsOverrides(
      {
        openSync:
          (original) =>
          (path, ...args) => {
            const descriptor = original(path, ...args);
            openedPaths.set(descriptor, path);
            return descriptor;
          },
        fstatSync:
          (original) =>
          (descriptor, ...args) => {
            const stat = original(descriptor, ...args);
            if (openedPaths.get(descriptor) !== runner) return stat;
            changed = true;
            return {
              dev: field === "dev" ? stat.dev + 1n : stat.dev,
              ino: field === "ino" ? stat.ino + 1n : stat.ino,
              uid: stat.uid,
              gid: stat.gid,
              mode: stat.mode,
              size: stat.size,
              mtimeNs: stat.mtimeNs,
              ctimeNs: stat.ctimeNs,
              isFile: () => stat.isFile(),
              isDirectory: () => stat.isDirectory(),
              isSymbolicLink: () => stat.isSymbolicLink(),
            };
          },
      },
      () => expectCode(() => verify(bundle), "BUNDLE_FILE_CHANGED"),
    );

    assert.equal(changed, true);
  }
});

test("rejects a directory swapped in where a regular file was inspected", (t) => {
  const bundle = createBundle(t);
  const runner = join(bundle.bundleDir, "operator/c1-runner.mjs");
  const openedPaths = new Map();
  let replaced = false;
  let closed = false;

  withFsOverrides(
    {
      openSync:
        (original) =>
        (path, ...args) => {
          if (path === runner && !replaced) {
            replaced = true;
            renameSync(runner, runner + ".original");
            mkdirSync(runner);
          }
          const descriptor = original(path, ...args);
          openedPaths.set(descriptor, path);
          return descriptor;
        },
      closeSync: (original) => (descriptor) => {
        if (openedPaths.get(descriptor) === runner) closed = true;
        return original(descriptor);
      },
    },
    () => expectCode(() => verify(bundle), "BUNDLE_FILE_NOT_REGULAR"),
  );

  assert.equal(replaced, true);
  assert.equal(closed, true);
});

test("detects truncation after descriptor inspection", (t) => {
  const bundle = createBundle(t);
  const runner = join(bundle.bundleDir, "operator/c1-runner.mjs");
  const openedPaths = new Map();
  let truncated = false;

  withFsOverrides(
    {
      openSync:
        (original) =>
        (path, ...args) => {
          const descriptor = original(path, ...args);
          openedPaths.set(descriptor, path);
          return descriptor;
        },
      readFileSync:
        (original) =>
        (pathOrDescriptor, ...args) => {
          if (openedPaths.get(pathOrDescriptor) === runner && !truncated) {
            truncated = true;
            truncateSync(runner, 1);
          }
          return original(pathOrDescriptor, ...args);
        },
    },
    () => expectCode(() => verify(bundle), "BUNDLE_FILE_CHANGED"),
  );

  assert.equal(truncated, true);
});

test("fails closed when an inspected bundle file cannot be opened", (t) => {
  const bundle = createBundle(t);
  const runner = join(bundle.bundleDir, "operator/c1-runner.mjs");
  let denied = false;

  withFsOverrides(
    {
      openSync:
        (original) =>
        (path, ...args) => {
          if (path === runner) {
            denied = true;
            throw fsError("EACCES");
          }
          return original(path, ...args);
        },
    },
    () => expectCode(() => verify(bundle), "BUNDLE_READ_FAILED"),
  );

  assert.equal(denied, true);
});

test("fails closed when the no-follow open primitive is unsupported", (t) => {
  const bundle = createBundle(t);
  let attempted = false;

  withFsOverrides(
    {
      openSync: () => () => {
        attempted = true;
        throw fsError("ENOTSUP");
      },
    },
    () => expectCode(() => verify(bundle), "BUNDLE_SAFE_OPEN_UNSUPPORTED"),
  );

  assert.equal(attempted, true);
});

test("closes a descriptor after a failed descriptor read", (t) => {
  const bundle = createBundle(t);
  const openedPaths = new Map();
  let closeCount = 0;

  withFsOverrides(
    {
      openSync:
        (original) =>
        (path, ...args) => {
          const descriptor = original(path, ...args);
          openedPaths.set(descriptor, path);
          return descriptor;
        },
      readFileSync:
        (original) =>
        (pathOrDescriptor, ...args) => {
          if (typeof pathOrDescriptor === "number") throw fsError("EIO");
          return original(pathOrDescriptor, ...args);
        },
      closeSync: (original) => (descriptor) => {
        if (openedPaths.has(descriptor)) closeCount += 1;
        return original(descriptor);
      },
    },
    () => expectCode(() => verify(bundle), "BUNDLE_READ_FAILED"),
  );

  assert.equal(closeCount, 1);
});

test("fails closed when descriptor close reports an error after a successful read", (t) => {
  const bundle = createBundle(t);
  const manifest = join(bundle.bundleDir, OUTER_MANIFEST_PATH);
  const openedPaths = new Map();
  let closeCount = 0;

  withFsOverrides(
    {
      openSync:
        (original) =>
        (path, ...args) => {
          const descriptor = original(path, ...args);
          openedPaths.set(descriptor, path);
          return descriptor;
        },
      closeSync: (original) => (descriptor) => {
        if (openedPaths.get(descriptor) === manifest) {
          closeCount += 1;
          original(descriptor);
          throw fsError("EIO");
        }
        return original(descriptor);
      },
    },
    () => expectCode(() => verify(bundle), "BUNDLE_DESCRIPTOR_CLOSE_FAILED"),
  );

  assert.equal(closeCount, 1);
});

test("rejects an ancestor directory replaced with a symlink during open", (t) => {
  const bundle = createBundle(t);
  const runner = join(bundle.bundleDir, "operator/c1-runner.mjs");
  const operator = join(bundle.bundleDir, "operator");
  const movedOperator = join(bundle.bundleDir, "operator-real");
  const openedPaths = new Map();
  let swapped = false;
  let closed = false;

  withFsOverrides(
    {
      openSync:
        (original) =>
        (path, ...args) => {
          if (path === runner && !swapped) {
            swapped = true;
            renameSync(operator, movedOperator);
            symlinkSync(movedOperator, operator, "dir");
          }
          const descriptor = original(path, ...args);
          openedPaths.set(descriptor, path);
          return descriptor;
        },
      closeSync: (original) => (descriptor) => {
        if (openedPaths.get(descriptor) === runner) closed = true;
        return original(descriptor);
      },
    },
    () => expectCode(() => verify(bundle), "BUNDLE_PATH_SYMLINK"),
  );

  assert.equal(swapped, true);
  assert.equal(closed, true);
});

test("rechecks ancestor snapshots after reading from an opened descriptor", (t) => {
  const bundle = createBundle(t);
  const runner = join(bundle.bundleDir, "operator/c1-runner.mjs");
  const operator = join(bundle.bundleDir, "operator");
  const movedOperator = join(bundle.bundleDir, "operator-real");
  const openedPaths = new Map();
  let swapped = false;
  let readFromDescriptor = false;
  let closed = false;

  withFsOverrides(
    {
      openSync:
        (original) =>
        (path, ...args) => {
          const descriptor = original(path, ...args);
          openedPaths.set(descriptor, path);
          return descriptor;
        },
      readFileSync:
        (original) =>
        (pathOrDescriptor, ...args) => {
          if (openedPaths.get(pathOrDescriptor) === runner && !swapped) {
            swapped = true;
            renameSync(operator, movedOperator);
            symlinkSync(movedOperator, operator, "dir");
          }
          const bytes = original(pathOrDescriptor, ...args);
          if (openedPaths.get(pathOrDescriptor) === runner) readFromDescriptor = true;
          return bytes;
        },
      closeSync: (original) => (descriptor) => {
        if (openedPaths.get(descriptor) === runner) closed = true;
        return original(descriptor);
      },
    },
    () => expectCode(() => verify(bundle), "BUNDLE_PATH_SYMLINK"),
  );

  assert.equal(swapped, true);
  assert.equal(readFromDescriptor, true);
  assert.equal(closed, true);
});
