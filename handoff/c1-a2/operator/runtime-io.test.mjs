import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  accessExecutable,
  assertCommittedBundle,
  capture,
  implementationHead,
  pinExecutable,
  readPrivateFile,
  writePrivateExclusive,
} from "./runtime-io.mjs";

const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "c1-io-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "private");
  mkdirSync(directory, { mode: 0o700 });
  return { root, directory, path: join(directory, "input") };
}

test("private reads and durable exclusive writes enforce modes and never replace a file", (t) => {
  const { path } = fixture(t);
  writePrivateExclusive(path, "fake-private-canary");
  assert.equal(readPrivateFile(path), "fake-private-canary");
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  assert.throws(() => writePrivateExclusive(path, "replacement"), { code: "PRIVATE_WRITE_FAILED" });
  assert.equal(readPrivateFile(path), "fake-private-canary");
  chmodSync(path, 0o644);
  assert.throws(() => readPrivateFile(path), { code: "PRIVATE_INPUT_INVALID" });
});

test("private file and directory symlinks, unsafe modes and missing inputs fail closed", (t) => {
  const { root, directory, path } = fixture(t);
  assert.throws(() => readPrivateFile(path), { code: "PRIVATE_INPUT_INVALID" });
  const other = join(root, "target");
  writeFileSync(other, "canary", { mode: 0o600 });
  symlinkSync(other, path);
  assert.throws(() => readPrivateFile(path), { code: "PRIVATE_INPUT_INVALID" });
  symlinkSync(directory, join(root, "link"));
  assert.throws(() => readPrivateFile(join(root, "link", "input")), {
    code: "PRIVATE_INPUT_INVALID",
  });
  chmodSync(directory, 0o755);
  assert.throws(() => writePrivateExclusive(join(directory, "new"), "canary"), {
    code: "PRIVATE_WRITE_FAILED",
  });
});

test("executable path and digest pins reject PATH names, substitutions and symlinks", (t) => {
  const { root } = fixture(t);
  const path = join(root, "cloudflared");
  writeFileSync(path, "test-binary", { mode: 0o700 });
  assert.equal(pinExecutable(path, "cloudflared", digest(path)), path);
  assert.throws(() => pinExecutable("cloudflared", "cloudflared", digest(path)), {
    code: "EXECUTABLE_PIN_INVALID",
  });
  assert.throws(() => pinExecutable(path, "cloudflared", "f".repeat(64)), {
    code: "EXECUTABLE_PIN_INVALID",
  });
  const link = join(root, "alias");
  symlinkSync(path, link);
  assert.throws(() => pinExecutable(link, "alias", digest(path)), {
    code: "EXECUTABLE_PIN_INVALID",
  });
  chmodSync(path, 0o777);
  assert.throws(() => pinExecutable(path, "cloudflared", digest(path)), {
    code: "EXECUTABLE_PIN_INVALID",
  });
});

test("capture rejects nonzero status, spawn errors, timeout and oversized output without leaking canaries", async () => {
  const canary = "fake-child-secret-canary";
  assert.equal(await capture(process.execPath, ["-e", "process.stdout.write('ok')"]), "ok");
  for (const [args, options, code] of [
    [
      ["-e", `console.log('${canary}'); console.error('${canary}'); process.exit(9)`],
      {},
      "CHILD_PROCESS_FAILED",
    ],
    [["-e", "setTimeout(()=>{},10000)"], { timeoutMs: 20 }, "CHILD_PROCESS_TIMEOUT"],
    [["-e", `console.log('${canary}')`], { maxBytes: 4 }, "CHILD_OUTPUT_INVALID"],
  ]) {
    await assert.rejects(capture(process.execPath, args, undefined, options), (error) => {
      assert.equal(error.code, code);
      assert.ok(!JSON.stringify(error).includes(canary) && !String(error).includes(canary));
      return true;
    });
  }
  await assert.rejects(capture("/not/a/real/executable", []), { code: "CHILD_PROCESS_FAILED" });
});

test("capture carries credentials only over stdin and uses an isolated, shell-free child", async () => {
  const value = "fake-stdin-secret";
  const result = await capture(
    process.execPath,
    [
      "-e",
      "let x=''; process.stdin.on('data',d=>x+=d); process.stdin.on('end',()=>console.log(x.length))",
    ],
    value,
  );
  assert.equal(result, String(value.length));
});

test("Access executable requires an exact approved compatible version", async (t) => {
  const { root } = fixture(t);
  const path = join(root, "cloudflared");
  writeFileSync(path, "test-binary", { mode: 0o700 });
  const approval = {
    cloudflared_path: path,
    cloudflared_sha256: digest(path),
    cloudflared_version: "2026.10.0",
  };
  assert.equal(
    await accessExecutable(approval, async () => "cloudflared version 2026.10.0 (built test)"),
    path,
  );
  await assert.rejects(
    accessExecutable(approval, async () => "cloudflared version 2025.1.0"),
    { code: "EXECUTABLE_VERSION_INVALID" },
  );
  await assert.rejects(
    accessExecutable(
      { ...approval, cloudflared_version: "2024.1.0" },
      async () => "cloudflared version 2024.1.0",
    ),
    { code: "EXECUTABLE_VERSION_INVALID" },
  );
});

test("implementation SHA comes from the pinned git and running Node version", async () => {
  const node = realpathSync(process.execPath);
  const git = realpathSync("/usr/bin/git");
  const gitVersion = (await capture(git, ["--version"])).replace("git version ", "");
  const approval = {
    node_path: node,
    node_sha256: digest(node),
    node_version: process.version,
    git_path: git,
    git_sha256: digest(git),
    git_version: gitVersion,
  };
  const head = await implementationHead(approval, process.cwd());
  assert.match(head, /^[0-9a-f]{40}$/);
  await assert.rejects(implementationHead({ ...approval, node_version: "v1.0.0" }, process.cwd()), {
    code: "EXECUTABLE_VERSION_INVALID",
  });
});

test("tracked private inputs and uncommitted bundle files block execution", async () => {
  const git = realpathSync("/usr/bin/git");
  const approval = { git_path: git, git_sha256: digest(git) };
  const calls = [];
  const clean = async (_command, args) => {
    calls.push(args);
    return "";
  };
  await assertCommittedBundle(approval, process.cwd(), clean);
  assert.equal(calls.length, 2);
  await assert.rejects(
    assertCommittedBundle(approval, process.cwd(), async () => "private-name-only"),
    { code: "PRIVATE_FILE_TRACKED" },
  );
  await assert.rejects(
    assertCommittedBundle(approval, process.cwd(), async (_command, args) =>
      args.includes("status") ? " M handoff/c1-a2/operator/c1-runner.mjs" : "",
    ),
    { code: "UNCOMMITTED_OPERATOR_BUNDLE" },
  );
});
