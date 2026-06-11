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
// All Command Center plumbing (backend discovery/launch, auth, tRPC,
// git helpers) lives in the vendored cc-skill-lib.mjs next to this file.

import { setTimeout as sleep } from "node:timers/promises";
import {
  EXIT as SHARED_EXIT,
  BackendError,
  detectInstall,
  ensureRunning,
  fail,
  getBackendOrigin,
  globToRegex,
  listChangedFiles,
  openUrl,
  parsePatternSpec,
  parsePortOverride,
  preflight,
  resolveRefs,
  status,
  success,
  toFatalError,
  trpcCall,
} from "./cc-skill-lib.mjs";

// #######################################
// Constants
// #######################################

// Oldest backend this skill works against: the walkthrough contract
// (walkthroughs.getTaskStatus, walkthroughs.create's `source` field,
// projects.findWorkspaceByPath, models.getAvailability) landed in
// 1.0.0-rc0. Bump only when adding a hard dependency on a new backend
// feature.
const MIN_BACKEND_VERSION = "1.0.0";

// How long between getTaskStatus polls.
const TASK_POLL_INTERVAL_MS = 1_000;

// Cap on total generation wait time. Walkthroughs typically finish in
// tens of seconds; this cap is just a safety net.
const TASK_TIMEOUT_MS = 10 * 60 * 1_000;

// Shared codes 0–8 and 10, plus this skill's own failure kind.
const EXIT = {
  ...SHARED_EXIT,
  GENERATION_FAILED: 9,
};

// #######################################
// File-pattern resolution
// #######################################

// `--files=PATTERN[,PATTERN...]` filters the diff down to a subset of
// changed files (see cc-skill-lib for the glob syntax). Unlike the
// refactor skill, the filter is optional end to end: when absent we send
// no file list and the backend defaults to the whole diff.
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

function openWalkthrough({ install, walkthroughId, workspaceId }) {
  const params = new URLSearchParams({
    id: walkthroughId,
    workspace: workspaceId,
  });
  // Always include the browser URL in the result so the agent can echo it.
  const browserUrl = `${getBackendOrigin()}/walkthrough?${params.toString()}`;

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

  // Debugging aid for multi-instance setups: resolve which backend this
  // runner would talk to, report it, and exit without doing anything.
  if (argv.includes("--discover")) {
    await ensureRunning(detectInstall(), parsePortOverride(argv));
    success({ backendOrigin: getBackendOrigin() });
  }

  const { install, sessionToken, workspaceId } = await preflight({
    minVersion: MIN_BACKEND_VERSION,
    portOverride: parsePortOverride(argv),
    cwd,
  });

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

main().catch(toFatalError);
