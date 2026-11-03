import http from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

export const FIXTURE_DISCLAIMER = "QA-C-REAL-HTTP-BULK-DELETE-EVIDENCE-ONLY";

const root = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Creates an isolated localhost HTTP server executing real Next.js route handlers
 * for bulk-delete and batch-delete jobs protocols.
 */
export async function createRealBulkDeleteHttpServer(options = {}) {
  const sandboxDir = await mkdtemp(join(tmpdir(), "bulk-delete-http-sandbox-"));
  const sessionsDir = join(sandboxDir, "sessions", "fixture-workspace");
  await mkdir(sessionsDir, { recursive: true });

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSessionsDir = process.env.PI_SESSIONS_DIR;
  const previousUsageDir = process.env.PI_USAGE_DATA_DIR;

  process.env.PI_CODING_AGENT_DIR = sandboxDir;
  process.env.PI_SESSIONS_DIR = join(sandboxDir, "sessions");
  delete process.env.PI_USAGE_DATA_DIR;

  const jiti = createJiti(import.meta.url, {
    alias: {
      "@": root,
      "server-only": "next/dist/compiled/server-only/empty.js",
    },
    interopDefault: true,
  });

  const batchRoute = await jiti.import(join(root, "app/api/sessions/batch-delete/route.ts"));
  const jobsRoute = await jiti.import(join(root, "app/api/sessions/batch-delete/jobs/route.ts"));
  const jobIdRoute = await jiti.import(join(root, "app/api/sessions/batch-delete/jobs/[id]/route.ts"));
  const eventsRoute = await jiti.import(join(root, "app/api/sessions/batch-delete/jobs/[id]/events/route.ts"));
  const sessionReader = await jiti.import(join(root, "lib/session-reader.ts"));

  sessionReader.invalidateSessionListCache();

  const sessionsMap = new Map();

  async function addSession(id, options = {}) {
    const filePath = join(sessionsDir, `${id}.jsonl`);
    sessionsMap.set(id, filePath);
    const header = {
      type: "session",
      version: 3,
      id,
      timestamp: new Date().toISOString(),
      cwd: sessionsDir,
      name: options.name || id,
    };
    const entries = [header];
    if (options.messages) {
      for (const m of options.messages) {
        entries.push({
          type: "message",
          id: `msg-${entries.length}`,
          parentId: null,
          timestamp: new Date().toISOString(),
          message: m,
        });
      }
    }
    await writeFile(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    sessionReader.cacheSessionPath(id, filePath);
    return filePath;
  }

  let server;
  await new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      const host = req.headers.host || "";
      if (!host.startsWith("127.0.0.1:") && !host.startsWith("localhost:")) {
        res.statusCode = 403;
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ error: "Access rejected: non-local host" }));
      }

      res.setHeader("x-fixture-evidence", FIXTURE_DISCLAIMER);

      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const pathname = urlObj.pathname;
      const method = req.method ? req.method.toUpperCase() : "GET";

      try {
        let bodyBuffer = null;
        if (method !== "GET" && method !== "HEAD") {
          const chunks = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          bodyBuffer = Buffer.concat(chunks);
        }

        const standardHeaders = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (v === undefined) continue;
          if (Array.isArray(v)) {
            for (const item of v) standardHeaders.append(k, item);
          } else {
            standardHeaders.set(k, v);
          }
        }

        const standardRequest = new Request(urlObj.toString(), {
          method,
          headers: standardHeaders,
          body: bodyBuffer && bodyBuffer.length > 0 ? bodyBuffer : undefined,
          duplex: "half",
        });

        let nextResponse = null;

        // Route matching
        if (pathname === "/api/sessions/batch-delete" && method === "POST") {
          nextResponse = await batchRoute.POST(standardRequest);
        } else if (pathname === "/api/sessions/batch-delete/jobs") {
          if (method === "POST") {
            nextResponse = await jobsRoute.POST(standardRequest);
          } else if (method === "GET") {
            nextResponse = await jobsRoute.GET();
          }
        } else if (pathname.startsWith("/api/sessions/batch-delete/jobs/")) {
          const sub = pathname.slice("/api/sessions/batch-delete/jobs/".length);
          if (sub.endsWith("/events") && method === "GET") {
            const jobId = decodeURIComponent(sub.slice(0, -"/events".length));
            nextResponse = await eventsRoute.GET(standardRequest, {
              params: Promise.resolve({ id: jobId }),
            });
          } else if (!sub.includes("/") && method === "GET") {
            const jobId = decodeURIComponent(sub);
            nextResponse = await jobIdRoute.GET(standardRequest, {
              params: Promise.resolve({ id: jobId }),
            });
          }
        }

        if (!nextResponse) {
          if (options.fallbackHandler) {
            return options.fallbackHandler(req, res, { standardRequest, urlObj, method });
          }
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ error: "Route not found" }));
        }

        res.statusCode = nextResponse.status;
        for (const [k, v] of nextResponse.headers.entries()) {
          res.setHeader(k, v);
        }

        if (nextResponse.body) {
          const reader = nextResponse.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
        } else {
          const text = await nextResponse.text();
          res.end(text);
        }
      } catch (err) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
        }
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    });

    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  return {
    server,
    port,
    origin,
    sandboxDir,
    addSession,
    async close() {
      if (server) {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
      }
      for (const id of sessionsMap.keys()) {
        sessionReader.invalidateSessionPathCache(id);
      }
      sessionReader.invalidateSessionListCache();

      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

      if (previousSessionsDir === undefined) delete process.env.PI_SESSIONS_DIR;
      else process.env.PI_SESSIONS_DIR = previousSessionsDir;

      if (previousUsageDir === undefined) delete process.env.PI_USAGE_DATA_DIR;
      else process.env.PI_USAGE_DATA_DIR = previousUsageDir;

      try {
        await rm(sandboxDir, { recursive: true, force: true });
      } catch {}
    },
  };
}
