#!/usr/bin/env node
// Throwaway mock of the Command Center backend for exercising
// skills/refactor/run.mjs end-to-end. Not shipped with the skill.
// Usage: node mock-backend.mjs <port> [fail|cancel|lost]
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 7999);
const mode = process.argv[3] ?? "ok"; // ok | fail | cancel | lost

const json = (res, value) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
const ok = (res, data) => json(res, { result: { data } });

let cancelled = false;

createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const path = url.pathname;
  console.error(`[mock] ${req.method} ${path}`);

  if (path === "/health") return json(res, { status: "ok" });
  if (path === "/trpc/version.currentVersion")
    return ok(res, { currentVersion: "1.0.0" });
  if (path === "/trpc/auth.getStatus")
    return ok(res, { credential: { email: "test@example.com" } });
  if (path === "/trpc/models.getAvailability")
    return ok(res, { state: "ok" });
  if (path === "/trpc/settings.listAgents")
    return ok(res, {
      agents: [{ id: "claude-code", installed: true }],
      preference: "claude-code",
    });
  if (path === "/trpc/projects.findWorkspaceByPath")
    return ok(res, { workspaceId: "ws-mock-1" });

  if (path === "/trpc/refactoring.screenFilesForRefactoring") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const input = JSON.parse(body);
      console.error(`[mock] screen input: ${body}`);
      // Drop one file to exercise the "skipped ineligible" path.
      ok(res, input.filePaths.slice(0, Math.max(1, input.filePaths.length - 1)));
    });
    return;
  }

  if (path === "/trpc/refactoring.runRefactoring") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      console.error(`[mock] run input: ${body}`);
      const input = JSON.parse(body);
      const badRef = (r) =>
        !/^[0-9a-f]{40}$/.test(r) && r !== "__WORKING_TREE__" && r !== "__STAGED_ONLY__";
      if (badRef(input.fromCommit) || badRef(input.toCommit)) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({ error: { json: { message: "bad ref", data: {} } } }),
        );
      }
      ok(res, { taskId: "refactoring-task-0000", sessionId: "session-0000" });
    });
    return;
  }

  if (path === "/trpc/refactoring.cancel") {
    cancelled = true;
    console.error("[mock] CANCEL received");
    return ok(res, undefined);
  }

  if (path === "/trpc/refactoring.subscribeToProgress") {
    // Mirrors @trpc/server 11.x SSE framing (sse.ts): each chunk is
    // `event:`/`data:` lines followed by a blank line; data events have
    // no `event:` field.
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (lines) => res.write(lines.join("\n") + "\n\n\n");
    send([`event: connected`, `data: {"id":"conn-1"}`]);
    if (mode === "lost") {
      // Unknown task: generator yields nothing and returns.
      send([`event: return`, `data: `]);
      return res.end();
    }
    let pct = 0;
    const tick = setInterval(() => {
      if (cancelled) {
        send([`data: ${JSON.stringify({ status: "cancelled", endedAt: 1 })}`]);
        clearInterval(tick);
        send([`event: return`, `data: `]);
        return res.end();
      }
      pct += 25;
      if (pct === 50) send([`event: ping`, `data: `]); // keepalive mid-run
      if (pct < 100) {
        send([
          `data: ${JSON.stringify({ status: "running", progress: { percentageDone: pct } })}`,
        ]);
      } else {
        const terminal =
          mode === "fail"
            ? { status: "failed", error: "mock failure reason", endedAt: 1 }
            : { status: "completed", endedAt: 1 };
        send([`data: ${JSON.stringify(terminal)}`]);
        clearInterval(tick);
        send([`event: return`, `data: `]);
        res.end();
      }
    }, Number(process.env.MOCK_TICK_MS ?? 300));
    req.on("close", () => clearInterval(tick));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { json: { message: `No procedure ${path}`, data: {} } } }));
}).listen(port, "127.0.0.1", () => console.error(`[mock] listening on ${port}`));
