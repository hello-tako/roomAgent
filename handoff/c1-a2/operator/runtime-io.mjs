import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";

export class IoStop extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function noSymlinkAncestors(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new IoStop("UNSAFE_DIRECTORY");
    if (dirname(current) === current) break;
  }
}

export function assertPrivateDirectory(directory) {
  try {
    noSymlinkAncestors(directory);
    const stat = lstatSync(directory);
    if ((stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid()) {
      throw new IoStop("PRIVATE_DIRECTORY_INVALID");
    }
  } catch {
    throw new IoStop("PRIVATE_DIRECTORY_INVALID");
  }
}

export function readPrivateFile(path) {
  let fd;
  try {
    assertPrivateDirectory(dirname(path));
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.uid !== process.getuid()
    ) {
      throw new IoStop("PRIVATE_INPUT_INVALID");
    }
    if (stat.size > 128 * 1024) throw new IoStop("PRIVATE_INPUT_INVALID");
    return readFileSync(fd, "utf8");
  } catch {
    throw new IoStop("PRIVATE_INPUT_INVALID");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function writePrivateExclusive(path, text) {
  let fd;
  let parent;
  try {
    assertPrivateDirectory(dirname(path));
    parent = openSync(
      dirname(path),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(fd, 0o600);
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
    fsyncSync(parent);
  } catch {
    // Preserve partial files: an uncertain write must not silently authorize a retry.
    throw new IoStop("PRIVATE_WRITE_FAILED");
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (parent !== undefined) closeSync(parent);
  }
}

export function pinExecutable(path, name, digest) {
  try {
    if (
      !isAbsolute(path) ||
      path !== realpathSync(path) ||
      basename(path) !== name ||
      !/^[0-9a-f]{64}$/.test(digest)
    ) {
      throw new IoStop("EXECUTABLE_PIN_INVALID");
    }
    noSymlinkAncestors(dirname(path));
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      (stat.mode & 0o022) !== 0 ||
      (stat.mode & 0o111) === 0 ||
      ![0, process.getuid()].includes(stat.uid)
    ) {
      throw new IoStop("EXECUTABLE_PIN_INVALID");
    }
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (actual !== digest) throw new IoStop("EXECUTABLE_PIN_INVALID");
    return path;
  } catch {
    throw new IoStop("EXECUTABLE_PIN_INVALID");
  }
}

export function capture(
  command,
  args,
  input,
  { spawnFn = spawn, timeoutMs = 60_000, maxBytes = 64 * 1024 } = {},
) {
  return new Promise((resolveP, reject) => {
    let child;
    let timer;
    let finished = false;
    let output = "";
    let bytes = 0;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) {
        child?.kill();
        reject(new IoStop(error));
      } else resolveP(output.trim());
    };
    try {
      child = spawnFn(command, args, {
        shell: false,
        env: { PATH: "/usr/bin:/bin", HOME: homedir() },
        stdio: ["pipe", "pipe", "ignore"],
      });
      timer = setTimeout(() => finish("CHILD_PROCESS_TIMEOUT"), timeoutMs);
      child.stdout.on("data", (data) => {
        bytes += data.length;
        if (bytes > maxBytes) finish("CHILD_OUTPUT_INVALID");
        else output += data.toString("utf8");
      });
      child.on("error", () => finish("CHILD_PROCESS_FAILED"));
      child.on("close", (code, signal) =>
        finish(code === 0 && !signal ? null : "CHILD_PROCESS_FAILED"),
      );
      child.stdin.on("error", () => finish("CHILD_PROCESS_FAILED"));
      child.stdin.end(input);
    } catch {
      finish("CHILD_PROCESS_FAILED");
    }
  });
}

export async function implementationHead(approval, repositoryDir, captureFn = capture) {
  const node = pinExecutable(approval.node_path, "node", approval.node_sha256);
  if (
    node !== realpathSync(process.execPath) ||
    approval.node_version !== process.version ||
    Number(process.versions.node.split(".")[0]) < 22
  ) {
    throw new IoStop("EXECUTABLE_VERSION_INVALID");
  }
  const git = pinExecutable(approval.git_path, "git", approval.git_sha256);
  const version = await captureFn(git, ["--version"]);
  if (version !== `git version ${approval.git_version}`)
    throw new IoStop("EXECUTABLE_VERSION_INVALID");
  const head = await captureFn(git, ["-C", repositoryDir, "rev-parse", "--verify", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(head)) throw new IoStop("IMPLEMENTATION_SHA_INVALID");
  return head;
}

export async function accessExecutable(approval, captureFn = capture) {
  const path = pinExecutable(approval.cloudflared_path, "cloudflared", approval.cloudflared_sha256);
  const version = await captureFn(path, ["--version"]);
  const match = /^cloudflared version (\d{4}\.\d+\.\d+)(?:\s|$)/.exec(version);
  if (
    !match ||
    match[1] !== approval.cloudflared_version ||
    Number(match[1].split(".")[0]) < 2025
  ) {
    throw new IoStop("EXECUTABLE_VERSION_INVALID");
  }
  return path;
}

export async function assertCommittedBundle(approval, repositoryDir, captureFn = capture) {
  const git = pinExecutable(approval.git_path, "git", approval.git_sha256);
  const prefix = ["-C", repositoryDir, "-c", "core.fsmonitor=false"];
  const privatePaths = await captureFn(git, [
    ...prefix,
    "ls-files",
    "--",
    "handoff/c1-a2/operator/private/",
  ]);
  if (privatePaths) throw new IoStop("PRIVATE_FILE_TRACKED");
  const status = await captureFn(git, [
    ...prefix,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    "handoff/c1-a2/",
  ]);
  if (status) throw new IoStop("UNCOMMITTED_OPERATOR_BUNDLE");
}
