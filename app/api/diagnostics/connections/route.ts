import { appendConnectionDiagnostic, connectionLogPath, CONNECTION_LOG_ARCHIVES, CONNECTION_LOG_MAX_BYTES, readConnectionDiagnostics } from "@/lib/connection-diagnostics-server";
import { sanitizeConnectionDiagnostic } from "@/lib/connection-diagnostics";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 64 * 1024;

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return Response.json({ error: "JSON required" }, { status: 415 });
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400 });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); return new Response(null, { status: 413 }); }
      chunks.push(part.value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(body.events) || body.events.length > 20) return new Response(null, { status: 400 });
    const events = body.events.map(sanitizeConnectionDiagnostic);
    if (events.some((event: unknown) => event === null)) return new Response(null, { status: 400 });
    // The browser cannot impersonate a server-side failure or supply runtime metadata.
    if (events.some((event: { source: string; event: string; operation: string; reason: string }) => event.source !== "browser" || event.operation === "web_lifecycle" || event.event === "lifecycle" || event.reason === "service_start" || event.reason === "service_stop")) return new Response(null, { status: 400 });
    const stored = events.every((event: unknown) => appendConnectionDiagnostic(event));
    return Response.json({ accepted: stored ? events.length : 0 }, { status: stored ? 202 : 503, headers: { "Cache-Control": "no-store" } });
  } catch { return new Response(null, { status: 400 }); }
  finally { reader.releaseLock(); }
}

export async function GET(request: Request) {
  const download = new URL(request.url).searchParams.get("download") === "1";
  return Response.json({ version: 1, logPath: connectionLogPath(),
    retention: { maxBytesPerFile: CONNECTION_LOG_MAX_BYTES, files: CONNECTION_LOG_ARCHIVES + 1 },
    events: readConnectionDiagnostics(download ? 10_000 : 100) },
  { headers: { "Cache-Control": "no-store", ...(download ? { "Content-Disposition": 'attachment; filename="agent-web-connections.json"' } : {}) } });
}
