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
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { basename, join, resolve as resolvePath } from "node:path";
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
// projects.findWorkspaceByPath, models.getAvailability). The contract
// landed in 1.0.0-rc0; `compareSemver` strips pre-release tags via
// parseInt, so a baseline of "1.0.0" accepts every 1.0.0-rcN onward.
// Bump only when adding a hard dependency on a new backend feature.
const MIN_BACKEND_VERSION = "1.0.0";

// How long to wait for the backend to come up after we launch it.
// Electron path is local: a few seconds at most. Headless (npx) path may
// have to download ~80MB on first run, so give it a bigger budget.
const HEALTH_TIMEOUT_MS = 20_000;
const HEADLESS_HEALTH_TIMEOUT_MS = 90_000;
const HEALTH_POLL_INTERVAL_MS = 250;

// How long between getTaskStatus polls.
const TASK_POLL_INTERVAL_MS = 1_000;

// Sign-in waiting: opening the sign-in surface and polling auth.getStatus
// until the user completes the flow in their browser / Electron app.
const LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;
const LOGIN_POLL_INTERVAL_MS = 2_000;
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
        "Command Center",
        "Command Center.exe",
      ),
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

  const electronPath =
    electronPaths.find((p) => p && existsSync(p) && safeStat(p)) ?? null;
  const hasElectron = electronPath !== null;

  return { hasData, hasElectron, electronPath, dataDir };
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
// after Bun.serve() succeeds. Returns the origin + file metadata, or
// null if the file is absent/half-written/garbage.
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
    const stat = statSync(file);
    return {
      origin: `http://${BACKEND_HOST}:${port}`,
      port,
      file,
      mtimeIso: stat.mtime.toISOString(),
      pid: typeof parsed.pid === "number" ? parsed.pid : null,
    };
  } catch {
    return null;
  }
}

const DEFAULT_ORIGIN = `http://${BACKEND_HOST}:${DEFAULT_BACKEND_PORT}`;

// Tagged result so callers can tell the failure modes apart in error
// messages: "nothing listening" (ECONNREFUSED) is a different signal
// from "we got blocked" (sandbox / firewall / timeout).
async function pingHealth(origin) {
  try {
    const res = await fetch(`${origin}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok
      ? { kind: "ok" }
      : { kind: "http-error", status: res.status };
  } catch (err) {
    // Node 18+ surfaces the underlying error code on .cause for fetch
    // failures: ECONNREFUSED, ENETUNREACH, ETIMEDOUT, etc.
    const code = err?.cause?.code ?? err?.code ?? null;
    if (err?.name === "TimeoutError" || code === "ETIMEDOUT") {
      return { kind: "timeout" };
    }
    if (code === "ECONNREFUSED") return { kind: "refused" };
    return { kind: "error", code: code ?? "unknown", message: err?.message };
  }
}

// Resolve a healthy origin. Prefer (a) any explicit override, (b) the
// port the backend advertised in its port file, (c) the default port
// for hand-launched instances. Returns the resolved origin, or a probe
// summary describing what we tried and how each probe failed.
async function waitForHealthy(dataDir, timeoutMs, override) {
  const deadline = Date.now() + timeoutMs;
  // Latest probe result per origin, used for the failure-summary message.
  const lastResult = new Map();

  // do-while so timeoutMs=0 still gets one pass (fast-path "is it already up?")
  do {
    const fromFile = discoverOrigin(dataDir);

    // Probe each candidate in priority order; first OK wins.
    const candidates = [];
    if (override) candidates.push({ origin: override, source: "override" });
    if (fromFile) {
      candidates.push({ origin: fromFile.origin, source: "port-file" });
    }
    candidates.push({ origin: DEFAULT_ORIGIN, source: "default-port" });

    for (const c of candidates) {
      const result = await pingHealth(c.origin);
      lastResult.set(c.origin, { ...c, ...result });
      if (result.kind === "ok") {
        return { ok: true, origin: c.origin };
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(HEALTH_POLL_INTERVAL_MS);
  } while (Date.now() < deadline);

  return {
    ok: false,
    portFile: discoverOrigin(dataDir), // for surfacing mtime/pid
    probes: [...lastResult.values()],
  };
}

function launchElectron(install) {
  // OS-native "open by registered app". Detached + ignored stdio so we
  // don't keep the child glued to our process group.
  // On Windows, spawn the resolved .exe directly — `start "" "Command Center"`
  // surfaces a "Windows cannot find" dialog.
  if (platform() === "win32") {
    if (!install?.electronPath) return;
    spawn(install.electronPath, [], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  const cmd =
    platform() === "darwin"
      ? ["open", ["-a", "Command Center"]]
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
  // Detached so the backend keeps running after this process exits.
  // Pipe stdout/stderr to a log file rather than ignoring them so a
  // silent-failure spawn (npx exiting non-zero, network blocked, etc.)
  // can be diagnosed from the log path we surface in the timeout error.
  //
  // First run downloads ~80MB; warn the agent so it can surface that to
  // the user instead of looking like a hang.
  status(
    "Starting Command Center via npx (first run downloads ~80MB; subsequent runs are cached)…",
  );
  try {
    const runtimeDir = join(dataDir, "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    const logPath = join(runtimeDir, "skill-launch.log");
    const logFd = openSync(logPath, "a");

    const isWindows = platform() === "win32";
    const cmd = isWindows ? "npx.cmd" : "npx";
    // .cmd needs shell:true on Node 20.12+ (CVE-2024-27980) — else EINVAL
    spawn(cmd, ["-y", "@command-center/command-center", "--no-open"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, CC_PORT_FILE_DIR: runtimeDir },
      shell: isWindows,
    }).unref();
    return { ok: true, logPath };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function ensureRunning(install, override) {
  // Fast path: backend already up. waitForHealthy with a zero deadline
  // does one pass through (override → port-file → default-port).
  const fast = await waitForHealthy(install.dataDir, 0, override);
  if (fast.ok) {
    backendOrigin = fast.origin;
    status(`Found running Command Center at ${fast.origin}.`, {
      backendOrigin: fast.origin,
    });
    return;
  }

  // With an explicit override, the user expects us to use that specific
  // backend — don't auto-spawn another one.
  if (override) {
    surfaceUnreachable(fast, install, "override", null);
    process.exit(EXIT.NOT_RUNNING);
  }

  let timeoutMs = HEALTH_TIMEOUT_MS;
  let launchLogPath = null;
  if (install.hasElectron) {
    status("Launching Command Center…");
    launchElectron(install);
  } else if (install.hasData) {
    const launched = launchHeadlessBackend(install.dataDir);
    if (!launched.ok) {
      actionRequired(
        "not-running",
        `Command Center data is present but the backend isn't running, and the runner couldn't spawn it (${launched.reason}). Open the Command Center app, or run \`npx -y @command-center/command-center --no-open\` to start it, then re-run this command.`,
      );
      process.exit(EXIT.NOT_RUNNING);
    }
    launchLogPath = launched.logPath;
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
  const result = await waitForHealthy(install.dataDir, timeoutMs, override);
  if (!result.ok) {
    surfaceUnreachable(result, install, "launch", launchLogPath);
    process.exit(EXIT.NOT_RUNNING);
  }
  backendOrigin = result.origin;
  status(`Backend ready at ${result.origin}.`, { backendOrigin: result.origin });
}

// Format an unreachable-backend failure so the error message and the
// structured data both carry enough detail to diagnose multi-instance
// dev setups, sandbox/firewall blocks, and stale port files.
function surfaceUnreachable(result, install, phase, launchLogPath) {
  const probeSummary = (result.probes ?? [])
    .map((p) => {
      const tag =
        p.kind === "refused"
          ? "ECONNREFUSED (nothing listening)"
          : p.kind === "timeout"
            ? "timeout (sandbox / firewall?)"
            : p.kind === "http-error"
              ? `HTTP ${p.status}`
              : p.kind === "error"
                ? `${p.code}`
                : p.kind;
      return `  - ${p.origin} (${p.source}): ${tag}`;
    })
    .join("\n");

  const portFileInfo = result.portFile
    ? `\nPort file: ${result.portFile.file} → :${result.portFile.port} (written ${result.portFile.mtimeIso}${result.portFile.pid ? `, pid ${result.portFile.pid}` : ""}).`
    : `\nPort file: not present at ${join(install.dataDir, ...PORT_FILE_RELATIVE)}.`;

  const sandboxHint = (result.probes ?? []).every((p) => p.kind === "timeout")
    ? "\nAll probes timed out without a refusal — likely a sandbox or firewall blocking localhost. Try running the runner unsandboxed."
    : "";

  const overrideHint = (result.probes ?? []).some((p) => p.kind === "refused")
    ? "\nIf the real backend is on a different port, re-run with `--port=<port>` to target it directly."
    : "";

  const logHint = launchLogPath
    ? `\nSpawn log: ${launchLogPath}.`
    : "";

  fail(
    "not-running",
    `Command Center backend not reachable (${phase}).\nProbes tried:\n${probeSummary}${portFileInfo}${sandboxHint}${overrideHint}${logHint}`,
    EXIT.NOT_RUNNING,
    {
      phase,
      probes: result.probes,
      portFile: result.portFile,
      launchLogPath,
    },
  );
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

// Returns the (possibly refreshed) session token once auth is confirmed.
async function checkAuth(initialToken, install) {
  const probe = async (token) => {
    if (!token) return { ok: false, reason: "no-token" };
    try {
      const status = await trpcCall({
        path: "auth.getStatus",
        type: "query",
        sessionToken: token,
      });
      // Language-stable: credential undefined ⇒ unauthenticated.
      return status?.credential
        ? { ok: true }
        : { ok: false, reason: "no-credential" };
    } catch (e) {
      if (e instanceof BackendError && e.httpStatus === 401) {
        return { ok: false, reason: "invalid-token" };
      }
      throw e;
    }
  };

  const first = await probe(initialToken);
  if (first.ok) return initialToken;

  return await waitForSignIn(install, initialToken, probe);
}

// Open the sign-in surface (Electron if available, else the web UI on
// the backend's bound port) and block until either the user completes
// the flow or the deadline passes. Polls auth.getStatus on each beat
// and re-reads the session token from disk in case sign-in rewrites it.
async function waitForSignIn(install, initialToken, probe) {
  if (install.hasElectron) {
    status("Opening Command Center to sign in…");
    launchElectron(install);
  } else {
    status(`Opening ${backendOrigin} to sign in…`, { signInUrl: backendOrigin });
    openUrl(backendOrigin);
  }

  status(
    `Waiting for sign-in to complete (up to ${Math.round(LOGIN_TIMEOUT_MS / 60_000)} min)…`,
  );
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let token = initialToken;
  while (Date.now() < deadline) {
    await sleep(LOGIN_POLL_INTERVAL_MS);
    // Re-read in case the sign-in flow rotated it (or it was missing at
    // start — common right after launching a fresh `npx` backend).
    token = readSessionToken(install.dataDir) ?? token;
    const result = await probe(token);
    if (result.ok) {
      status("Signed in.");
      return token;
    }
  }

  fail(
    "not-logged-in",
    `Sign-in did not complete within ${Math.round(LOGIN_TIMEOUT_MS / 60_000)} minutes. ${
      install.hasElectron
        ? "Open the Command Center app and sign in, then re-run."
        : `Open ${backendOrigin} and sign in, then re-run.`
    }`,
    EXIT.NOT_LOGGED_IN,
  );
}

// #######################################
// Model availability check
// #######################################

async function checkModel(sessionToken) {
  const availability = await trpcCall({
    path: "models.getAvailability",
    type: "query",
    // Backend schema is `z.object({ speed: zModelSpeed.default("fast") })` —
    // the outer object is required. Send {} so the default kicks in.
    input: {},
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

async function findWorkspaceId(sessionToken, cwd) {
  const result = await trpcCall({
    path: "projects.findWorkspaceByPath",
    type: "query",
    input: { path: cwd },
    sessionToken,
  });
  return result?.workspaceId ?? null;
}

// Canonicalize a path the same way the backend does for containment checks:
// resolve symlinks (realpath), then apply the platform's path-key casing.
// Falls back to a lexical resolve when the path doesn't exist on disk.
function canonicalize(p) {
  let resolved;
  try {
    resolved = realpathSync.native(resolvePath(p));
  } catch {
    resolved = resolvePath(p);
  }
  return platform() === "win32"
    ? resolved.replaceAll("\\", "/").toLowerCase()
    : resolved;
}

// Local mirror of the backend's findWorkspaceByContainingPath, run against the
// overview a mutation returned. Used as a fallback for backends that still
// match workspace paths lexically (pre-symlink-resolution).
function pickContainingWorkspaceId(overview, cwd) {
  const target = canonicalize(cwd);
  let best = null;
  for (const project of overview?.projects ?? []) {
    for (const ws of project.workspaces ?? []) {
      if (!ws?.absolutePath) continue;
      const root = canonicalize(ws.absolutePath);
      const contained = target === root || target.startsWith(root + "/");
      if (!contained) continue;
      if (!best || root.length > best.rootLen) {
        best = { id: ws.id, rootLen: root.length };
      }
    }
  }
  return best?.id ?? null;
}

async function resolveWorkspace(sessionToken, cwd) {
  const existing = await findWorkspaceId(sessionToken, cwd);
  if (existing) return existing;

  // Not inside any known workspace. Register the containing git repo as a
  // project — addProject creates a root workspace pointing at the repo root —
  // then resolve again. This mirrors "Open this directory as a workspace" in
  // the app, so the skill is self-contained and doesn't dead-end the user.
  let repoRoot;
  try {
    repoRoot = runGit(["rev-parse", "--show-toplevel"], cwd);
  } catch (e) {
    fail(
      "no-workspace",
      `No Command Center workspace contains "${cwd}", and it isn't inside a git repository, so the runner can't register it automatically (${e.message}). Open this directory as a workspace in Command Center first.`,
      EXIT.NO_WORKSPACE,
      { cwd },
    );
  }

  status(`Registering ${repoRoot} as a Command Center workspace…`, { repoRoot });
  let overview;
  try {
    overview = await trpcCall({
      path: "projects.addProject",
      type: "mutation",
      input: { label: basename(repoRoot) || "Workspace", rootPath: repoRoot },
      sessionToken,
    });
  } catch (e) {
    fail(
      "no-workspace",
      `No Command Center workspace contains "${cwd}", and registering "${repoRoot}" as a workspace failed: ${e.message}`,
      EXIT.NO_WORKSPACE,
      { cwd, repoRoot },
    );
  }

  // Preferred: a fresh lookup. Correct once the backend resolves symlinks when
  // matching paths (root workspaces store their path as a symlink into the CC
  // storage dir, which canonicalizes back to repoRoot).
  const afterAdd = await findWorkspaceId(sessionToken, cwd);
  if (afterAdd) return afterAdd;

  // Fallback: resolve the containing workspace ourselves from the returned
  // overview, for older backends that compare workspace paths lexically.
  const fromOverview = pickContainingWorkspaceId(overview, cwd);
  if (fromOverview) return fromOverview;

  fail(
    "no-workspace",
    `Registered "${repoRoot}" as a Command Center workspace but still couldn't resolve "${cwd}" to it. This is unexpected — please report it.`,
    EXIT.NO_WORKSPACE,
    { cwd, repoRoot },
  );
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

// Wire sentinels the backend's zGeneralGitRef codec decodes — see
// shared/src/git/git-types.ts (WORKING_TREE_STRING / STAGED_ONLY_STRING).
const WORKING_TREE_REF = "__WORKING_TREE__";
const STAGED_ONLY_REF = "__STAGED_ONLY__";

// Translate friendly tokens like "WORKING_TREE" / "STAGED" into the wire
// sentinels. Everything else (SHAs, branch names, "HEAD", "HEAD~3", tags)
// passes through untouched for resolveRefToWire to turn into a SHA.
function normalizeRef(token) {
  if (!token) return token;
  const upper = token.toUpperCase();
  if (upper === "WORKING_TREE" || upper === "WORKING-TREE") {
    return WORKING_TREE_REF;
  }
  if (
    upper === "STAGED_ONLY" ||
    upper === "STAGED-ONLY" ||
    upper === "STAGED"
  ) {
    return STAGED_ONLY_REF;
  }
  return token;
}

// Resolve a user-supplied ref token to the wire form the backend's
// zGeneralGitRef codec accepts: a special sentinel, or a concrete 40-char
// commit SHA (see shared/src/git/git-types.ts — GIT_SHA_REGEX). The codec
// rejects symbolic refs (branch names, "HEAD", "HEAD~3", tags, short SHAs),
// so anything that isn't a sentinel is resolved to a full SHA via git.
// `^{commit}` peels tags to the commit they point at and forces a commit-ish.
function resolveRefToWire(token, cwd) {
  const normalized = normalizeRef(token);
  if (normalized === WORKING_TREE_REF || normalized === STAGED_ONLY_REF) {
    return normalized;
  }
  try {
    return runGit(["rev-parse", "--verify", `${normalized}^{commit}`], cwd);
  } catch (e) {
    throw new Error(`Could not resolve git ref "${token}": ${e.message}`);
  }
}

function resolveRefs(argv, cwd) {
  // Convenience flags. Equivalent ref syntax also accepted (see normalizeRef).
  if (argv.includes("--working-tree")) {
    // No base branch (detached HEAD, single commit, no remote) → diff the
    // working tree against HEAD itself. "Uncommitted changes vs HEAD" is
    // unambiguous and useful even when there's nothing to merge-base against.
    // Resolve to a concrete SHA: the wire ref codec rejects the literal
    // "HEAD" (it wants a SHA or a sentinel), and a SHA also stays valid for
    // the local `git diff` in listChangedFiles when --files is combined.
    let from;
    try {
      from = runGit(["merge-base", "HEAD", pickBaseBranch(cwd)], cwd);
    } catch {
      from = runGit(["rev-parse", "HEAD"], cwd);
    }
    return { from, to: WORKING_TREE_REF };
  }
  if (argv.includes("--staged")) {
    return { from: runGit(["rev-parse", "HEAD"], cwd), to: STAGED_ONLY_REF };
  }
  // Accept either `from..to` or no argument (default to merge-base(HEAD, main)..HEAD).
  const arg = argv.find((a) => a.includes(".."));
  if (arg) {
    const [from, to] = arg.split("..");
    if (!from || !to) {
      throw new Error(`Bad ref range "${arg}". Expected "<from>..<to>".`);
    }
    return { from: resolveRefToWire(from, cwd), to: resolveRefToWire(to, cwd) };
  }
  // Default: merge-base of HEAD and the most plausible base branch.
  const baseBranch = pickBaseBranch(cwd);
  const mergeBase = runGit(["merge-base", "HEAD", baseBranch], cwd);
  return { from: mergeBase, to: runGit(["rev-parse", "HEAD"], cwd) };
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
  // Working-tree vs from: `git diff --name-only <from>` (no `..`). Picks
  // up unstaged AND staged modifications of tracked files.
  // Staged vs from: `git diff --name-only --cached <from>`.
  // Committed range: `git diff --name-only <from>..<to>`.
  const args =
    to === WORKING_TREE_REF
      ? ["diff", "--name-only", from]
      : to === STAGED_ONLY_REF
        ? ["diff", "--name-only", "--cached", from]
        : ["diff", "--name-only", `${from}..${to}`];
  return runGit(args, cwd)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Manual port override. Useful when (a) the user has multiple CC instances
// and the port file points at the wrong one, or (b) the runner can't write
// CC_PORT_FILE_DIR (read-only data dir, etc.). Argument shape: `--port=6112`.
function parsePortOverride(argv) {
  const flag = argv.find((a) => a.startsWith("--port="));
  if (!flag) return null;
  const port = Number(flag.slice("--port=".length));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fail(
      "unexpected",
      `Bad --port value: ${flag}. Expected a positive integer like --port=6112.`,
      EXIT.GENERIC,
    );
  }
  return `http://${BACKEND_HOST}:${port}`;
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

  await ensureRunning(install, parsePortOverride(argv));
  await checkVersion();

  const sessionToken = await checkAuth(
    readSessionToken(install.dataDir),
    install,
  );
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
