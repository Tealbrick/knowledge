/** Opt-in native, disposable upstream fixture. No live deploy or global install. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REF = "30c7e2a63e43b7f270fc2c638f0b6246934a53f4";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const programDir = path.resolve(scriptDir, "..");
const [upstreamArg, surrealArg, mode] = process.argv.slice(2);
assert(mode === undefined || mode === "--browser", "Only the optional --browser mode is supported");
const browserMode = mode === "--browser";
assert(upstreamArg && surrealArg, "Usage: node scripts/open-notebook-native-fixture.mjs <verified-upstream-checkout> <verified-surreal-2.6.5-binary>");
const upstream = await fs.realpath(upstreamArg);
const surreal = await fs.realpath(surrealArg);
assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: upstream, encoding: "utf8", timeout: 10_000 }).trim(), REF);
assert.equal(execFileSync("git", ["diff", "HEAD", "--", "api", "open_notebook", "commands", "prompts", "pyproject.toml", "uv.lock"], { cwd: upstream, encoding: "utf8", timeout: 10_000 }), "", "Upstream code must be unmodified");
assert.equal(execFileSync("git", ["ls-files", "--others", "--exclude-standard", "api", "open_notebook", "commands", "prompts"], { cwd: upstream, encoding: "utf8", timeout: 10_000 }), "", "Untracked upstream code is not allowed");
assert.match(execFileSync(surreal, ["version"], { encoding: "utf8", timeout: 10_000 }), /^2\.6\.5\s/);
const python = path.join(upstream, ".venv/bin/python");
await fs.access(python);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-on-native-"));
const work = path.join(root, "work");
await fs.mkdir(work);
for (const name of ["api", "open_notebook", "commands", "prompts"]) {
  await fs.symlink(path.join(upstream, name), path.join(work, name), "dir");
}
const children = [];
const outputs = [];
const controller = new AbortController();
const overall = setTimeout(() => controller.abort(), browserMode ? 660_000 : 240_000);
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const secret = () => randomBytes(32).toString("hex");
const password = secret();
const databasePassword = secret();
const cleanEnv = {
  PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: root,
  PYTHONDONTWRITEBYTECODE: "1", PYTHON_DOTENV_DISABLED: "1",
  PYTHONPATH: [path.join(scriptDir, "fixtures/open-notebook-network-guard"), upstream].join(path.delimiter),
  CORS_ORIGINS: "http://127.0.0.1", LOGURU_LEVEL: "INFO",
  OPEN_NOTEBOOK_ENABLE_DOCLING: "false", OPEN_NOTEBOOK_ENABLE_CRAWL4AI: "false",
};

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function launch(label, executable, args, env) {
  const output = createWriteStream(path.join(root, `${label}.log`), { mode: 0o600 });
  outputs.push(output);
  const child = spawn(executable, args, { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  const record = { child, label, done: false, code: null, error: null };
  record.completion = new Promise((resolve) => {
    child.once("error", () => { record.error = "spawn_failed"; record.done = true; resolve(); });
    child.once("close", (code) => { record.code = code; record.done = true; resolve(); });
  });
  children.push(record);
  return record;
}

async function pause(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function ready(url, record, deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until && !controller.signal.aborted) {
    assert(!record.done, `${record.label}_exited_before_ready`);
    try {
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch { /* bounded local readiness retry only */ }
    await pause(200);
  }
  throw new Error(`${record.label}_readiness_timeout`);
}

async function stopChild(record) {
  if (record.done) return;
  record.child.kill("SIGTERM");
  const until = Date.now() + 5_000;
  while (!record.done && Date.now() < until) await pause(50);
  if (!record.done) record.child.kill("SIGKILL");
  const hardUntil = Date.now() + 5_000;
  while (!record.done && Date.now() < hardUntil) await pause(50);
  assert(record.done, `${record.label}_cleanup_failed`);
}

let succeeded = false;
try {
  execFileSync(python, ["-c", "import socket\ntry:\n socket.getaddrinfo('fixture.invalid',443)\nexcept OSError as error:\n assert str(error) == 'fixture_non_loopback_dns_denied'\nelse:\n raise AssertionError('fixture guard not active')"], { cwd: work, env: cleanEnv, timeout: 10_000, stdio: "pipe" });
  const dbPort = await freePort();
  const apiPort = await freePort();
  const db = launch("surreal", surreal, ["start", "--no-banner", "--bind", `127.0.0.1:${dbPort}`, "--log", "warn", "--deny-net", "--", `rocksdb:${path.join(root, "database")}`], {
    ...cleanEnv, SURREAL_USER: "fixture", SURREAL_PASS: databasePassword,
  });
  await ready(`http://127.0.0.1:${dbPort}/health`, db, 15_000);
  const upstreamEnv = {
    ...cleanEnv, SURREAL_URL: `ws://127.0.0.1:${dbPort}/rpc`,
    SURREAL_USER: "fixture", SURREAL_PASSWORD: databasePassword,
    SURREAL_NAMESPACE: "knowledge_fixture", SURREAL_DATABASE: "knowledge_fixture",
    OPEN_NOTEBOOK_PASSWORD: password, OPEN_NOTEBOOK_ENCRYPTION_KEY: secret(),
  };
  const api = launch("api", python, ["-m", "uvicorn", "api.main:app", "--host", "127.0.0.1", "--port", String(apiPort)], upstreamEnv);
  await ready(`http://127.0.0.1:${apiPort}/health`, api, 90_000);
  const worker = launch("worker", python, [path.join(upstream, ".venv/bin/surreal-commands-worker"), "--import-modules", "commands", "--max-tasks", "1"], upstreamEnv);
  console.log(JSON.stringify({ event: "fixture.ready", upstreamRef: REF, surrealVersion: "2.6.5", loopbackOnly: true, pythonSocketGuard: true, dataRoot: root }));
  const driver = launch("driver", process.execPath, [path.join(programDir, "node_modules/tsx/dist/cli.mjs"), path.join(scriptDir, browserMode ? "open-notebook-browser-fixture.ts" : "open-notebook-runtime-smoke.ts")], {
    PATH: cleanEnv.PATH, TMPDIR: root,
    KNOWLEDGE_OPEN_NOTEBOOK_FIXTURE: "disposable",
    KNOWLEDGE_OPEN_NOTEBOOK_FIXTURE_TIMEOUT_MS: "60000",
    KNOWLEDGE_OPEN_NOTEBOOK_FIXTURE_URL: `http://127.0.0.1:${apiPort}`,
    KNOWLEDGE_OPEN_NOTEBOOK_FIXTURE_TOKEN: password,
  });
  while (!driver.done && !controller.signal.aborted) await pause(100);
  assert(!controller.signal.aborted, "fixture_total_timeout");
  assert.equal(driver.code, 0, "fixture_driver_failed");
  assert(!worker.done, "fixture_worker_exited");
  succeeded = true;
} catch (error) {
  console.error(JSON.stringify({ event: "fixture.failed", error: error instanceof Error ? error.message : "unknown_failure", evidenceRoot: root }));
  process.exitCode = 1;
} finally {
  clearTimeout(overall);
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  let stopped = true;
  for (const record of children.toReversed()) {
    try { await stopChild(record); } catch { stopped = false; }
  }
  await Promise.all(outputs.map((output) => new Promise((resolve) => output.end(resolve))));
  // Retain bounded fixture logs for diagnosis; delete only this newly-created
  // data root after proving that all its owned processes are stopped.
  if (stopped) {
    const driverLog = await fs.readFile(path.join(root, "driver.log"), "utf8").catch(() => "");
    if (succeeded) console.log(driverLog.trim());
    await fs.rm(path.join(root, "database"), { recursive: true, force: true });
    await fs.rm(work, { recursive: true, force: true });
    console.log(JSON.stringify({ event: "fixture.cleanup", processesStopped: true, dataRemoved: true, evidenceRoot: root }));
  } else {
    process.exitCode = 1;
    console.error(JSON.stringify({ event: "fixture.cleanup_failed", evidenceRoot: root }));
  }
}
