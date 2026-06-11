#!/usr/bin/env node
// Refactor skill runner.
//
// Contract (calling agents read this):
//   - One JSON object per stdout line. Fields: { kind, code?, message?, ... }.
//   - `kind` ∈ {"status", "result", "error", "action-required"}.
//   - `code` is a language-stable enum; `message` is human-readable English (or a
//     pre-localized backend string passed through verbatim).
//   - Branch on `kind` and `code`. Do not parse `message`.
//
// The refactoring itself runs inside Command Center, which spawns its own
// coding-agent sessions that EDIT THE WORKSPACE WORKING TREE. The calling
// agent must not edit files while this runner is waiting, and must re-read
// any files it has cached once the runner exits.
//
// All Command Center plumbing (backend discovery/launch, auth, tRPC, SSE,
// git helpers) lives in the vendored cc-skill-lib.mjs next to this file.

import { setTimeout as sleep } from "node:timers/promises";
import {
  EXIT as SHARED_EXIT,
  BackendError,
  actionRequired,
  emit,
  fail,
  globToRegex,
  listChangedFiles,
  parsePatternSpec,
  parsePortOverride,
  preflight,
  resolveRefs,
  runGit,
  sseEvents,
  status,
  success,
  toFatalError,
  trpcCall,
} from "./cc-skill-lib.mjs";

// #######################################
// Constants
// #######################################

// Oldest backend this skill works against. The refactoring tRPC surface
// (refactoring.runRefactoring with `workflowType`, screenFilesForRefactoring,
// subscribeToProgress) shipped in 0.7.3, but the shared preflight endpoints
// (projects.findWorkspaceByPath, models.getAvailability) gate at 1.0.0 —
// same baseline as the walkthrough skill.
const MIN_BACKEND_VERSION = "1.0.0";

// Refactorings spawn one or more coding-agent sessions and routinely run
// for many minutes on multi-file diffs. Overridable via --timeout-mins.
const DEFAULT_TASK_TIMEOUT_MS = 60 * 60 * 1_000;

// Delay between SSE reconnect attempts. The backend's streamProgress
// yields the current state immediately on each (re)connect, so
// reconnection is lossless.
const SSE_RECONNECT_DELAY_MS = 1_000;

// The backend only reports progress between workflow steps, and a single
// step (a coding agent reworking many files) can run 15+ minutes — dead
// silence that calling agents misread as a hang. The backend's 30s SSE
// pings prove the task is alive, so piggyback a heartbeat status on them
// whenever we've been quiet this long. Env override is for tests.
const HEARTBEAT_INTERVAL_MS =
  Number(process.env.CC_SKILL_HEARTBEAT_MS) || 60_000;

// Workflow keys the backend accepts (shared/src/refactorings/workflow-types.ts).
const WORKFLOWS = {
  "do-it-all": "refactoring-do-it-all",
  "de-duplicate": "refactoring-de-duplicate",
};
const DEFAULT_WORKFLOW = "do-it-all";

// Shared codes 0–8 and 10, plus this skill's own failure kinds.
const EXIT = {
  ...SHARED_EXIT,
  REFACTORING_FAILED: 9,
  NO_AGENT: 11,
  NO_ELIGIBLE_FILES: 12,
  CANCELLED: 13,
};

// #######################################
// Coding-agent availability check
// #######################################

// The refactoring workflows delegate the actual code edits to a locally
// installed coding agent (Claude Code, etc.). Without one, the backend's
// runRefactoring fails with NoAgentAvailableError — check up front so the
// failure is structured and actionable instead.
async function checkCodingAgent(sessionToken) {
  const { agents } = await trpcCall({
    path: "settings.listAgents",
    type: "query",
    sessionToken,
  });
  if (Array.isArray(agents) && agents.some((a) => a?.installed)) return;

  actionRequired(
    "no-agent",
    "No coding agent is available to Command Center. Install one (e.g. Claude Code) or configure it in Command Center Settings → Agents, then re-run.",
  );
  process.exit(EXIT.NO_AGENT);
}

// #######################################
// Changed-file resolution
// #######################################

// Unlike the walkthrough endpoint, refactoring.runRefactoring requires a
// concrete `changedFiles` list — there is no "whole diff" default on the
// backend. Always expand the diff locally, then optionally narrow it with
// `--files=PATTERN[,PATTERN...]` globs (see cc-skill-lib for the syntax).
function resolveChangedFiles(argv, cwd, from, to) {
  const candidates = listChangedFiles(cwd, from, to);
  if (candidates.length === 0) {
    fail(
      "no-files-matched",
      `No changed files found in ${from}..${to} — nothing to refactor.`,
      EXIT.NO_FILES_MATCHED,
      { from, to },
    );
  }

  const flag = argv.find((a) => a.startsWith("--files="));
  if (!flag) return candidates;

  const { includes, excludes } = parsePatternSpec(flag.slice("--files=".length));
  const includeRes = includes.map(globToRegex);
  const excludeRes = excludes.map(globToRegex);

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
// Flag parsing
// #######################################

function parseWorkflow(argv) {
  const flag = argv.find((a) => a.startsWith("--workflow="));
  if (!flag) return WORKFLOWS[DEFAULT_WORKFLOW];
  const value = flag.slice("--workflow=".length);
  // Accept both the short alias ("do-it-all") and the full backend key
  // ("refactoring-do-it-all").
  const key =
    WORKFLOWS[value] ??
    Object.values(WORKFLOWS).find((full) => full === value);
  if (!key) {
    fail(
      "unexpected",
      `Bad --workflow value: "${value}". Expected one of: ${Object.keys(WORKFLOWS).join(", ")}.`,
      EXIT.GENERIC,
    );
  }
  return key;
}

function parseTimeoutMs(argv) {
  const flag = argv.find((a) => a.startsWith("--timeout-mins="));
  if (!flag) return DEFAULT_TASK_TIMEOUT_MS;
  const mins = Number(flag.slice("--timeout-mins=".length));
  if (!Number.isFinite(mins) || mins <= 0) {
    fail(
      "unexpected",
      `Bad --timeout-mins value: ${flag}. Expected a positive number like --timeout-mins=30.`,
      EXIT.GENERIC,
    );
  }
  return mins * 60_000;
}

// #######################################
// Refactoring start
// #######################################

// Pre-screen with the backend's own eligibility filter (well-sized code
// files only) so "nothing to do" is a structured early failure instead of
// a NoFilesEligibleForRefactoringError string from runRefactoring.
async function screenFiles({ sessionToken, workspaceId, files }) {
  const eligible = await trpcCall({
    path: "refactoring.screenFilesForRefactoring",
    type: "mutation",
    input: { workspaceId, filePaths: files },
    sessionToken,
  });
  if (!Array.isArray(eligible) || eligible.length === 0) {
    fail(
      "no-eligible-files",
      `None of the ${files.length} changed file${files.length === 1 ? "" : "s"} are eligible for refactoring (only reasonably-sized code files qualify; lockfiles, generated files, and very large files are skipped).`,
      EXIT.NO_ELIGIBLE_FILES,
      { candidateCount: files.length },
    );
  }
  if (eligible.length < files.length) {
    status(
      `${files.length - eligible.length} of ${files.length} changed files are not eligible for refactoring (skipped).`,
      { eligibleCount: eligible.length, candidateCount: files.length },
    );
  }
  return eligible;
}

async function startRefactoring({
  sessionToken,
  workspaceId,
  from,
  to,
  changedFiles,
  workflowType,
}) {
  try {
    const { taskId, sessionId } = await trpcCall({
      path: "refactoring.runRefactoring",
      type: "mutation",
      input: {
        workspaceId,
        fromCommit: from,
        toCommit: to,
        changedFiles,
        workflowType,
      },
      sessionToken,
    });
    return { taskId, sessionId };
  } catch (e) {
    if (e instanceof BackendError && e.httpStatus === 429) {
      // Language-stable: usageLimitFeature === "refactoring".
      if (e.data?.usageLimitFeature === "refactoring") {
        fail(
          "quota",
          "Daily refactoring quota reached. Resets at UTC midnight, or upgrade your plan.",
          EXIT.QUOTA,
        );
      }
      fail("quota", e.message || "Quota exceeded.", EXIT.QUOTA);
    }
    throw e;
  }
}

// #######################################
// Progress streaming
// #######################################

// Best-effort cancellation on SIGINT/SIGTERM: without this, killing the
// runner would leave the refactoring running inside Command Center,
// editing the working tree after the calling agent has moved on.
let activeCancellation = null;

function installSignalHandlers() {
  const handler = () => {
    const cancel = activeCancellation;
    if (!cancel) process.exit(EXIT.CANCELLED);
    emit({
      kind: "error",
      code: "refactoring-cancelled",
      message: "Interrupted — cancelling the refactoring in Command Center…",
    });
    // Hard exit after a grace period in case the cancel call hangs.
    setTimeout(() => process.exit(EXIT.CANCELLED), 5_000).unref();
    trpcCall({
      path: "refactoring.cancel",
      type: "mutation",
      input: { workspaceId: cancel.workspaceId, taskId: cancel.taskId },
      sessionToken: cancel.sessionToken,
    })
      .catch(() => {})
      .finally(() => process.exit(EXIT.CANCELLED));
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

// Subscribe to refactoring.subscribeToProgress and block until the task
// reaches a terminal state. Reconnects on transport drops — the backend
// yields the current state immediately on each (re)connect, and keeps
// completed tasks around in memory, so reconnection is lossless short of
// a backend restart (which kills the refactoring anyway).
async function waitForCompletion({ sessionToken, workspaceId, taskId, timeoutMs }) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastPct = -1;
  let lastEmitAt = Date.now();

  const heartbeat = () => {
    if (Date.now() - lastEmitAt < HEARTBEAT_INTERVAL_MS) return;
    const mins = Math.round((Date.now() - startedAt) / 60_000);
    status(
      `Refactoring still running — ${mins} min elapsed, last reported progress ${Math.max(lastPct, 0)}%. Long quiet stretches are normal: progress only updates between workflow steps, and a single step can take many minutes.`,
      {
        percentageDone: Math.max(lastPct, 0),
        elapsedMinutes: mins,
        heartbeat: true,
      },
    );
    lastEmitAt = Date.now();
  };

  // Connections that yield no task state at all mean the backend doesn't
  // know the task. One empty connection could race the task registering
  // into completedTasks; two in a row means it's gone.
  let emptyConnections = 0;

  while (Date.now() < deadline) {
    let sawState = false;
    try {
      for await (const evt of sseEvents({
        path: "refactoring.subscribeToProgress",
        input: { workspaceId, taskId },
        sessionToken,
      })) {
        if (evt.event === "ping") {
          // Pings arrive every ~30s; they prove the task is alive even
          // when progress hasn't moved.
          heartbeat();
          continue;
        }
        if (evt.event === "connected") continue;
        if (evt.event === "return") break;
        if (evt.event === "serialized-error") {
          let parsed = null;
          try {
            parsed = JSON.parse(evt.data);
          } catch {
            // fall through with raw text
          }
          throw new BackendError(
            parsed?.message ?? `Progress stream error: ${evt.data}`,
            { httpStatus: 0, data: parsed?.data ?? {} },
          );
        }
        if (evt.event !== null || !evt.sawData) continue;

        let state;
        try {
          state = JSON.parse(evt.data);
        } catch {
          continue;
        }
        if (!state || typeof state !== "object") continue;
        sawState = true;

        if (state.status === "running") {
          const pct = state.progress?.percentageDone ?? 0;
          if (pct !== lastPct) {
            status(`Refactoring… ${pct}%`, { percentageDone: pct });
            lastPct = pct;
            lastEmitAt = Date.now();
          }
        } else {
          return state; // completed | failed | cancelled
        }
      }
    } catch (e) {
      if (e instanceof BackendError) throw e;
      // Transport drop / inactivity watchdog — reconnect.
      status(`Progress stream interrupted (${e?.message ?? e}); reconnecting…`);
    }

    if (sawState) {
      emptyConnections = 0;
    } else {
      emptyConnections += 1;
      if (emptyConnections >= 2) {
        fail(
          "refactoring-failed",
          "Command Center no longer tracks this refactoring task (the backend may have restarted). Check the session in the Command Center app for any partial changes, then try again.",
          EXIT.REFACTORING_FAILED,
          { taskId },
        );
      }
    }
    await sleep(SSE_RECONNECT_DELAY_MS);
  }

  fail(
    "refactoring-failed",
    `Refactoring did not finish within ${Math.round(timeoutMs / 60_000)} minutes. It may still be running — check the Command Center app, or cancel it there. Re-run with a larger --timeout-mins to wait longer.`,
    EXIT.REFACTORING_FAILED,
    { taskId },
  );
}

// #######################################
// Main
// #######################################

async function main() {
  const argv = process.argv.slice(2);
  const cwd = process.cwd();

  installSignalHandlers();

  const workflowType = parseWorkflow(argv);
  const timeoutMs = parseTimeoutMs(argv);

  const { sessionToken, workspaceId } = await preflight({
    minVersion: MIN_BACKEND_VERSION,
    portOverride: parsePortOverride(argv),
    cwd,
  });
  await checkCodingAgent(sessionToken);

  const { from, to } = resolveRefs(argv, cwd);
  const candidates = resolveChangedFiles(argv, cwd, from, to);
  const changedFiles = await screenFiles({
    sessionToken,
    workspaceId,
    files: candidates,
  });

  status(
    `Starting ${workflowType} refactoring of ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"} (${from}..${to})…`,
    { from, to, workflowType, files: changedFiles },
  );

  const { taskId, sessionId } = await startRefactoring({
    sessionToken,
    workspaceId,
    from,
    to,
    changedFiles,
    workflowType,
  });
  activeCancellation = { sessionToken, workspaceId, taskId };
  status(
    `Refactoring started (task ${taskId}). Progress is also visible in the Command Center app's Agents panel.`,
    { taskId, sessionId },
  );

  const finalState = await waitForCompletion({
    sessionToken,
    workspaceId,
    taskId,
    timeoutMs,
  });
  activeCancellation = null;

  if (finalState.status === "failed") {
    fail(
      "refactoring-failed",
      finalState.error ?? "Refactoring failed.",
      EXIT.REFACTORING_FAILED,
      { taskId, sessionId },
    );
  }
  if (finalState.status === "cancelled") {
    fail(
      "refactoring-cancelled",
      "The refactoring was cancelled (from the Command Center app, or by another caller).",
      EXIT.CANCELLED,
      { taskId, sessionId },
    );
  }

  // completed — report what's now dirty so the calling agent knows exactly
  // which files to re-read. (May include changes that were already
  // uncommitted before the refactoring, e.g. in --working-tree mode.)
  let dirtyFiles = [];
  try {
    dirtyFiles = runGit(["diff", "--name-only", "-z", "HEAD"], cwd)
      .split("\0")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    // Non-fatal: the result is still a success without the file list.
  }

  success({
    taskId,
    sessionId,
    workspaceId,
    filesSubmitted: changedFiles,
    dirtyFiles,
    message:
      "Refactoring complete. The changes are uncommitted edits in the working tree — review them with `git diff`, and re-read any of these files you had cached before editing further. The refactoring session (with explanations of each change) is in the Command Center app's Agents panel.",
  });
}

main().catch(toFatalError);
