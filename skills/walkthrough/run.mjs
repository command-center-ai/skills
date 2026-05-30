#!/usr/bin/env node
// Walkthrough skill runner.
//
// Contract (calling agents read this):
//   - One JSON object per stdout line. Fields: { kind, code?, message?, url?, ... }.
//   - `kind` ∈ {"status", "result", "error", "action-required"}.
//   - `code` is a language-stable enum; `message` is human-readable English (or a
//     pre-localized backend string passed through verbatim).
//   - Branch on `kind` and `code`. Do not parse `message`.
//
// Zero npm dependencies. Plain Node ≥18, only `node:*` imports.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// #######################################
// Constants
// #######################################

// The backend binds to 127.0.0.1 (see backend/src/config/server-config.ts).
// Its actual port is chosen at startup — 6112 is the preferred port, but
// it falls back to the next available one if in use. Read it from the
// port-discovery file the backend writes after binding (see
// backend/src/utils/port-utils.ts).
const BACKEND_HOST = "127.0.0.1";
// CC binds to its preferred port (DEFAULT_BACKEND_PORT) when free, falling
// back to the next available one. We try the default first when no port
// file is available — covers users who hand-launched CC without setting
// CC_PORT_FILE_DIR.
const DEFAULT_BACKEND_PORT = 6112;
const PORT_FILE_RELATIVE = ["runtime", ".backend-port"];
const TRPC_PREFIX = "/trpc";
const SESSION_HEADER = "x-session-token";

// Resolved origin lives here once ensureRunning() succeeds. Read by
// trpcCall, pingHealth, and the browser-fallback open.
let backendOrigin = null;

// Minimum CC version that exposes the endpoints this skill requires
// (walkthroughs.getTaskStatus, walkthroughs.create's `source` field,
// projects.findWorkspaceByPath, models.getAvailability). Bump only when
// adding a hard dependency on a new backend feature.
// TODO: set to the first published CC release that includes these endpoints.
const MIN_BACKEND_VERSION = "0.0.0";

// How long to wait for the backend to come up after we launch it.
// Electron path is local: a few seconds at most. Headless (npx) path may
// have to download ~80MB on first run, so give it a bigger budget.
const HEALTH_TIMEOUT_MS = 20_000;
const HEADLESS_HEALTH_TIMEOUT_MS = 90_000;
const HEALTH_POLL_INTERVAL_MS = 250;

// How long between getTaskStatus polls.
const TASK_POLL_INTERVAL_MS = 1_000;
// Cap on total generation wait time. Walkthroughs typically finish in
// tens of seconds; this cap is just a safety net.
const TASK_TIMEOUT_MS = 10 * 60 * 1_000;

// Stable exit codes (also surfaced via the structured `code` field).
const EXIT = {
  OK: 0,
  GENERIC: 1,
  BACKEND_TOO_OLD: 2,
  NOT_INSTALLED: 3,
  NOT_RUNNING: 4,
  NOT_LOGGED_IN: 5,
  NO_MODEL: 6,
  QUOTA: 7,
  NO_WORKSPACE: 8,
  GENERATION_FAILED: 9,
  NO_FILES_MATCHED: 10,
};

// #######################################
// Output (structured stdout)
// #######################################

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function status(message, extra = {}) {
  emit({ kind: "status", message, ...extra });
}

function actionRequired(code, message, extra = {}) {
  emit({ kind: "action-required", code, message, ...extra });
}

function fail(code, message, exitCode, extra = {}) {
  emit({ kind: "error", code, message, ...extra });
  process.exit(exitCode);
}

function success(extra) {
  emit({ kind: "result", code: "ok", ...extra });
  process.exit(EXIT.OK);
}

// #######################################
// Install detection
// #######################################

function getDataDir() {
  // Mirrors backend/src/utils/env-helpers.ts: CC_DATA_DIR override, else
  // ~/.commandcenter on every platform.
  return process.env.CC_DATA_DIR
    ? resolvePath(process.env.CC_DATA_DIR)
    : join(homedir(), ".commandcenter");
}

function detectInstall() {
  const dataDir = getDataDir();
  const hasData = existsSync(dataDir);

  // Per-OS Electron app probe. We only need a yes/no — actual launch goes
  // through the OS handler (`open`, `start`, etc.) which already searches
  // the standard install locations.
  const electronPaths = {
    darwin: [
      "/Applications/Command Center.app",
      join(homedir(), "Applications/Command Center.app"),
    ],
    linux: [
      "/usr/bin/command-center",
      "/usr/local/bin/command-center",
      join(homedir(), ".local/bin/command-center"),
    ],
    win32: [
      join(
        process.env.LOCALAPPDATA ?? "",
        "Programs",
        "command-center",
        "Command Center.exe",
      ),
      join(
        process.env.PROGRAMFILES ?? "",
        "Command Center",
        "Command Center.exe",
      ),
    ],
  }[platform()] ?? [];

  const hasElectron = electronPaths.some(
    (p) => p && existsSync(p) && safeStat(p),
  );

  return { hasData, hasElectron, dataDir };
}

function safeStat(p) {
  try {
    return !!statSync(p);
  } catch {
    return false;
  }
}

// #######################################
// Backend launch / readiness
// #######################################

// Read the bound port from the port-discovery file the backend writes
// after Bun.serve() succeeds. Returns null if the file is absent,
// half-written, or doesn't contain a usable port — caller decides
// whether to retry or fail.
//
// The port file is only written when CC_PORT_FILE_DIR is set in the
// backend's env (the Electron app sets it; a hand-launched `npx`
// invocation does not). When the file is missing, the caller should
// fall back to probing the default port.
function discoverOrigin(dataDir) {
  const file = join(dataDir, ...PORT_FILE_RELATIVE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const port = parsed?.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) {
      return null;
    }
    return `http://${BACKEND_HOST}:${port}`;
  } catch {
    return null;
  }
}

const DEFAULT_ORIGIN = `http://${BACKEND_HOST}:${DEFAULT_BACKEND_PORT}`;

async function pingHealth(origin) {
  try {
    const res = await fetch(`${origin}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Resolve a healthy origin. Prefer the port the backend advertised in its
// port file; fall back to probing the default port for hand-launched
// instances (those don't write a port file). Returns null if the
// deadline passes without either path responding.
async function waitForHealthy(dataDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fromFile = discoverOrigin(dataDir);
    if (fromFile && (await pingHealth(fromFile))) return fromFile;
    if (await pingHealth(DEFAULT_ORIGIN)) return DEFAULT_ORIGIN;
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }
  return null;
}

function launchElectron() {
  // OS-native "open by registered app". Detached + ignored stdio so we
  // don't keep the child glued to our process group.
  const cmd =
    platform() === "darwin"
      ? ["open", ["-a", "Command Center"]]
      : platform() === "win32"
        ? ["cmd", ["/c", "start", "", "Command Center"]]
        : ["xdg-open", ["command-center://"]];
  spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref();
}

function launchHeadlessBackend(dataDir) {
  // `--no-open` is confirmed against the published binary: when the Electron
  // app spawns its own backend it uses exactly this flag (visible via
  // `ps aux` on a running CC install). We deliberately omit `--worker`,
  // which appears IPC-coupled to the Electron parent.
  //
  // CC_PORT_FILE_DIR is what makes the backend write its bound port to
  // <dataDir>/runtime/.backend-port (see backend/src/utils/port-utils.ts).
  // The Electron app sets this for its child; a bare `npx` invocation does
  // NOT set it by default, which is why hand-launched backends are
  // undiscoverable. We set it explicitly so our spawn behaves like the
  // Electron-spawned one.
  //
  // Detached + ignored stdio so the backend keeps running after this
  // process exits. The /health + port-file polling loop decides success.
  //
  // First run downloads ~80MB; warn the agent so it can surface that to
  // the user instead of looking like a hang.
  status(
    "Starting Command Center via npx (first run downloads ~80MB; subsequent runs are cached)…",
  );
  try {
    const cmd = platform() === "win32" ? "npx.cmd" : "npx";
    spawn(cmd, ["-y", "@command-center/command-center", "--no-open"], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        CC_PORT_FILE_DIR: join(dataDir, "runtime"),
      },
    }).unref();
    return true;
  } catch {
    return false;
  }
}

async function ensureRunning(install) {
  // Fast path: backend already up. Check the advertised port first, then
  // probe the default port — hand-launched instances skip the port file.
  const fromFile = discoverOrigin(install.dataDir);
  if (fromFile && (await pingHealth(fromFile))) {
    backendOrigin = fromFile;
    return;
  }
  if (await pingHealth(DEFAULT_ORIGIN)) {
    backendOrigin = DEFAULT_ORIGIN;
    return;
  }

  let timeoutMs = HEALTH_TIMEOUT_MS;
  if (install.hasElectron) {
    status("Launching Command Center…");
    launchElectron();
  } else if (install.hasData) {
    const launched = launchHeadlessBackend(install.dataDir);
    if (!launched) {
      actionRequired(
        "not-running",
        "Command Center data is present but the backend isn't running. Open the Command Center app, or run `npx -y @command-center/command-center --no-open` to start it, then re-run this command.",
      );
      process.exit(EXIT.NOT_RUNNING);
    }
    timeoutMs = HEADLESS_HEALTH_TIMEOUT_MS;
  } else {
    actionRequired(
      "not-installed",
      "Command Center is not installed. Download it at https://up-to-speed.ai or run `npx -y @command-center/command-center --no-open`.",
      { url: "https://up-to-speed.ai" },
    );
    process.exit(EXIT.NOT_INSTALLED);
  }

  status("Waiting for Command Center backend…");
  const origin = await waitForHealthy(install.dataDir, timeoutMs);
  if (!origin) {
    fail(
      "not-running",
      `Command Center backend did not become ready within ${timeoutMs / 1000}s (waiting for ${join(install.dataDir, ...PORT_FILE_RELATIVE)} and a healthy /health response).`,
      EXIT.NOT_RUNNING,
    );
  }
  backendOrigin = origin;
}

// #######################################
// Session token
// #######################################

function readSessionToken(dataDir) {
  const file = join(dataDir, "global", "session-token.json");
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return typeof raw?.token === "string" ? raw.token : null;
  } catch {
    return null;
  }
}

// #######################################
// tRPC client (raw fetch, un-batched)
// #######################################
//
// The backend mounts tRPC at /trpc with no data transformer (see
// backend/src/trpc/trpc.ts initTRPC.create()). Single un-batched requests
// take this form:
//   Query    GET  /trpc/<path>?input=<urlencoded JSON value>
//   Mutation POST /trpc/<path>  body=<raw JSON value>
// Success: { result: { data: <value> } }
// Error:   HTTP 4xx/5xx + { error: { json: { code, message, data: {...} } } }

class BackendError extends Error {
  constructor(message, { httpStatus, data }) {
    super(message);
    this.httpStatus = httpStatus;
    this.data = data ?? {};
  }
}

async function trpcCall({ path, type, input, sessionToken }) {
  if (!backendOrigin) {
    throw new Error(
      "trpcCall: backend origin not resolved — ensureRunning must run first.",
    );
  }
  const url = new URL(`${TRPC_PREFIX}/${path}`, backendOrigin);
  const headers = { "content-type": "application/json" };
  if (sessionToken) headers[SESSION_HEADER] = sessionToken;

  let res;
  if (type === "query") {
    if (input !== undefined) {
      url.searchParams.set("input", JSON.stringify(input));
    }
    res = await fetch(url, { method: "GET", headers });
  } else {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(input ?? {}),
    });
  }

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new BackendError(`Non-JSON response from ${path}: ${text}`, {
      httpStatus: res.status,
      data: {},
    });
  }

  if (!res.ok || body?.error) {
    const err = body?.error?.json ?? body?.error ?? {};
    throw new BackendError(err.message ?? `Request to ${path} failed`, {
      httpStatus: res.status,
      data: err.data ?? {},
    });
  }
  return body?.result?.data;
}

// #######################################
// Version check
// #######################################

function compareSemver(a, b) {
  const parts = (s) => s.split(".").map((n) => parseInt(n, 10) || 0);
  const [a1, a2, a3] = parts(a);
  const [b1, b2, b3] = parts(b);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}

async function checkVersion() {
  const { currentVersion } = await trpcCall({
    path: "version.currentVersion",
    type: "query",
  });
  if (compareSemver(currentVersion, MIN_BACKEND_VERSION) < 0) {
    fail(
      "backend-too-old",
      `Command Center ${MIN_BACKEND_VERSION} or newer is required (found ${currentVersion}). Update the app, then re-run.`,
      EXIT.BACKEND_TOO_OLD,
      { currentVersion, requiredVersion: MIN_BACKEND_VERSION },
    );
  }
}

// #######################################
// Auth check
// #######################################

async function checkAuth(sessionToken) {
  if (!sessionToken) {
    actionRequired(
      "not-logged-in",
      "Command Center session token not found. Open the app to sign in, then re-run.",
    );
    process.exit(EXIT.NOT_LOGGED_IN);
  }

  let authStatus;
  try {
    authStatus = await trpcCall({
      path: "auth.getStatus",
      type: "query",
      sessionToken,
    });
  } catch (e) {
    if (e instanceof BackendError && e.httpStatus === 401) {
      actionRequired(
        "not-logged-in",
        "Command Center session token is invalid. Open the app to sign in, then re-run.",
      );
      process.exit(EXIT.NOT_LOGGED_IN);
    }
    throw e;
  }

  // Language-stable discriminant: `credential` undefined ⇒ unauthenticated.
  if (!authStatus?.credential) {
    actionRequired(
      "not-logged-in",
      "You are not signed in to Command Center. Open the app to sign in, then re-run.",
    );
    process.exit(EXIT.NOT_LOGGED_IN);
  }
}

// #######################################
// Model availability check
// #######################################

async function checkModel(sessionToken) {
  const availability = await trpcCall({
    path: "models.getAvailability",
    type: "query",
    sessionToken,
  });
  if (availability.state === "ok") return;

  if (availability.state === "no-providers") {
    actionRequired(
      "no-model",
      "No AI providers are configured in Command Center. Open Settings → Models to configure one, then re-run.",
    );
    process.exit(EXIT.NO_MODEL);
  }

  // preference-unavailable
  actionRequired(
    "no-model",
    `The configured ${availability.speed ?? "fast"} model is not available. Open Settings → Models in Command Center to fix this, then re-run.`,
    { speed: availability.speed },
  );
  process.exit(EXIT.NO_MODEL);
}

// #######################################
// Workspace resolution
// #######################################

async function resolveWorkspace(sessionToken, cwd) {
  const result = await trpcCall({
    path: "projects.findWorkspaceByPath",
    type: "query",
    input: { path: cwd },
    sessionToken,
  });
  if (!result) {
    fail(
      "no-workspace",
      `No Command Center workspace contains "${cwd}". Open this directory as a workspace in Command Center first.`,
      EXIT.NO_WORKSPACE,
      { cwd },
    );
  }
  return result.workspaceId;
}

// #######################################
// Git ref resolution
// #######################################

function runGit(args, cwd) {
  const { status: code, stdout, stderr } = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`,
    );
  }
  return stdout.trim();
}

function resolveRefs(argv, cwd) {
  // Accept either `from..to` or no argument (default to merge-base(HEAD, main)..HEAD).
  const arg = argv.find((a) => a.includes(".."));
  if (arg) {
    const [from, to] = arg.split("..");
    if (!from || !to) {
      throw new Error(`Bad ref range "${arg}". Expected "<from>..<to>".`);
    }
    return { from, to };
  }
  // Default: merge-base of HEAD and the most plausible base branch.
  const baseBranch = pickBaseBranch(cwd);
  const mergeBase = runGit(["merge-base", "HEAD", baseBranch], cwd);
  return { from: mergeBase, to: "HEAD" };
}

function pickBaseBranch(cwd) {
  // Try `origin/HEAD` → its symbolic ref; fall back to `main`, then `master`.
  try {
    const symRef = runGit(
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      cwd,
    );
    if (symRef) return symRef;
  } catch {
    // ignore
  }
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    try {
      runGit(["rev-parse", "--verify", candidate], cwd);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(
    "Could not find a base branch (tried origin/HEAD, origin/main, origin/master, main, master).",
  );
}

// #######################################
// File-pattern resolution
// #######################################
//
// `--files=PATTERN[,PATTERN...]` filters the diff down to a subset of
// changed files. Patterns are repo-relative globs:
//   - `*`        matches any non-slash characters
//   - `**`       matches across directories (zero or more segments)
//   - `?`        matches a single non-slash character
//   - leading `!` flips the pattern to an exclusion
// If only exclusions are given, an implicit `**` include is added —
// i.e. "everything in the diff except these."
//
// Globbing happens locally against `git diff --name-only` output, so
// the backend still receives a concrete file list.

function parsePatternSpec(spec) {
  const items = spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const includes = [];
  const excludes = [];
  for (const p of items) {
    if (p.startsWith("!")) excludes.push(p.slice(1));
    else includes.push(p);
  }
  // If the user passed only exclusions, treat unscoped paths as included.
  if (includes.length === 0) includes.push("**");
  return { includes, excludes };
}

// Compile a glob to an anchored RegExp. Path separators are forward slashes
// (matches git's output); `**` matches across segments, `*` doesn't.
function globToRegex(glob) {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    // Treat `/**` followed by `/` or end of pattern as "zero or more segments".
    // Without this, `src/**/*.ts` would not match `src/foo.ts` (top-level).
    if (
      glob.slice(i, i + 3) === "/**" &&
      (i + 3 === glob.length || glob[i + 3] === "/")
    ) {
      re += "(?:/[^/]+)*";
      i += 3;
      if (glob[i] === "/") {
        re += "/";
        i += 1;
      }
      continue;
    }
    // Leading `**/`: zero or more segments at the start.
    if (i === 0 && glob.slice(0, 3) === "**/") {
      re += "(?:[^/]+/)*";
      i += 3;
      continue;
    }
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i += 2;
    } else if (c === "*") {
      re += "[^/]*";
      i += 1;
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (".+()|^$\\{}[]".includes(c)) {
      re += "\\" + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp("^" + re + "$");
}

function listChangedFiles(cwd, from, to) {
  const out = runGit(["diff", "--name-only", `${from}..${to}`], cwd);
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveFiles(argv, cwd, from, to) {
  const flag = argv.find((a) => a.startsWith("--files="));
  if (!flag) return undefined; // No filter — backend defaults to whole diff.

  const { includes, excludes } = parsePatternSpec(flag.slice("--files=".length));
  const includeRes = includes.map(globToRegex);
  const excludeRes = excludes.map(globToRegex);

  const candidates = listChangedFiles(cwd, from, to);
  const matched = candidates.filter(
    (path) =>
      includeRes.some((r) => r.test(path)) &&
      !excludeRes.some((r) => r.test(path)),
  );

  if (matched.length === 0) {
    fail(
      "no-files-matched",
      `--files patterns matched no files in ${from}..${to} (${candidates.length} candidate${candidates.length === 1 ? "" : "s"}).`,
      EXIT.NO_FILES_MATCHED,
      { includes, excludes, candidateCount: candidates.length },
    );
  }
  return matched;
}

// #######################################
// Walkthrough generation
// #######################################

async function createWalkthrough({
  sessionToken,
  workspaceId,
  from,
  to,
  files,
}) {
  try {
    const { taskId } = await trpcCall({
      path: "walkthroughs.create",
      type: "mutation",
      input: {
        workspaceId,
        from,
        to,
        intelligence: "smart",
        level: "medium",
        source: "external-skill",
        // Omit when no filter — backend treats absence as "whole diff".
        ...(files ? { files } : {}),
      },
      sessionToken,
    });
    return taskId;
  } catch (e) {
    if (e instanceof BackendError && e.httpStatus === 429) {
      // Language-stable: usageLimitFeature === "walkthrough".
      if (e.data?.usageLimitFeature === "walkthrough") {
        fail(
          "quota",
          "Daily walkthrough quota reached. Resets at UTC midnight, or upgrade your plan.",
          EXIT.QUOTA,
        );
      }
      fail("quota", e.message || "Quota exceeded.", EXIT.QUOTA);
    }
    throw e;
  }
}

async function waitForCompletion({ sessionToken, workspaceId, taskId }) {
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  let lastPct = -1;
  while (Date.now() < deadline) {
    const state = await trpcCall({
      path: "walkthroughs.getTaskStatus",
      type: "query",
      input: { workspaceId, taskId },
      sessionToken,
    });

    // null = backend doesn't know this task (likely evicted across a
    // backend restart; getTaskStatus stores completed tasks in memory).
    if (state === null) {
      fail(
        "generation-failed",
        "Walkthrough task is no longer tracked by the backend (it may have restarted). Try again.",
        EXIT.GENERATION_FAILED,
      );
    }

    if (state.status === "running") {
      const pct = state.progress?.percentageDone ?? 0;
      if (pct !== lastPct) {
        status(`Generating walkthrough… ${pct}%`, { percentageDone: pct });
        lastPct = pct;
      }
    } else if (state.status === "completed") {
      return state.walkthroughId;
    } else if (state.status === "failed") {
      fail(
        "generation-failed",
        state.error ?? "Walkthrough generation failed.",
        EXIT.GENERATION_FAILED,
      );
    } else if (state.status === "cancelled") {
      fail(
        "generation-failed",
        "Walkthrough generation was cancelled.",
        EXIT.GENERATION_FAILED,
      );
    }

    await sleep(TASK_POLL_INTERVAL_MS);
  }

  fail(
    "generation-failed",
    `Walkthrough did not finish within ${Math.round(TASK_TIMEOUT_MS / 1000)}s.`,
    EXIT.GENERATION_FAILED,
  );
}

// #######################################
// Open the walkthrough
// #######################################

function openUrl(url) {
  const cmd =
    platform() === "darwin"
      ? ["open", [url]]
      : platform() === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref();
}

function openWalkthrough({ install, walkthroughId, workspaceId }) {
  const params = new URLSearchParams({
    id: walkthroughId,
    workspace: workspaceId,
  });
  // Always include the browser URL in the result so the agent can echo it.
  const browserUrl = `${backendOrigin}/walkthrough?${params.toString()}`;

  if (install.hasElectron) {
    // Deep link → Electron main process catches via app.on("open-url") /
    // second-instance and navigates to /walkthrough?…
    openUrl(`commandcenter://walkthrough?${params.toString()}`);
  } else {
    openUrl(browserUrl);
  }
  return browserUrl;
}

// #######################################
// Main
// #######################################

async function main() {
  const argv = process.argv.slice(2);
  const cwd = process.cwd();

  const install = detectInstall();
  status("Checking Command Center installation…", {
    hasData: install.hasData,
    hasElectron: install.hasElectron,
  });

  await ensureRunning(install);
  await checkVersion();

  const sessionToken = readSessionToken(install.dataDir);
  await checkAuth(sessionToken);
  await checkModel(sessionToken);

  const workspaceId = await resolveWorkspace(sessionToken, cwd);
  status(`Resolved workspace ${workspaceId}.`, { workspaceId });

  const { from, to } = resolveRefs(argv, cwd);
  const files = resolveFiles(argv, cwd, from, to);
  if (files) {
    status(
      `Generating walkthrough for ${from}..${to} (${files.length} file${files.length === 1 ? "" : "s"} after filtering)…`,
      { from, to, files },
    );
  } else {
    status(`Generating walkthrough for ${from}..${to}…`, { from, to });
  }

  const taskId = await createWalkthrough({
    sessionToken,
    workspaceId,
    from,
    to,
    files,
  });

  const walkthroughId = await waitForCompletion({
    sessionToken,
    workspaceId,
    taskId,
  });

  const url = openWalkthrough({ install, walkthroughId, workspaceId });
  success({ walkthroughId, workspaceId, url });
}

main().catch((err) => {
  if (err instanceof BackendError) {
    fail(
      "backend-error",
      err.message,
      EXIT.GENERIC,
      { httpStatus: err.httpStatus, data: err.data },
    );
  }
  fail("unexpected", err?.message ?? String(err), EXIT.GENERIC);
});
