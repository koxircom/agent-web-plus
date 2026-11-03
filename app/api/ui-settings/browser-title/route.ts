import { isBrowserTabAppearance } from "@/lib/browser-tab-appearance";
import { NextResponse } from "next/server";
import {
  readAgentWebSettings,
  writeAgentWebSettings,
  normalizeBrowserTabTitle,
  MalformedSettingsError,
  SettingsConflictError,
} from "@/lib/browser-tab-title";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const { settings } = await readAgentWebSettings();
    return NextResponse.json(
      {
        version: settings.version,
        revision: settings.revision,
        title: settings.title,
        customTitle: normalizeBrowserTabTitle(settings.title),
        appearance: settings.tabAppearance ?? null,
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
          Pragma: "no-cache",
          Expires: "0",
        },
      }
    );
  } catch (err) {
    if (err instanceof MalformedSettingsError) {
      return NextResponse.json(
        { error: "Malformed agent web settings file (fail closed)" },
        { status: 500 }
      );
    }
    return NextResponse.json(
      { error: "Failed to read browser tab title settings" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 400 });
  }

  // Bound the actual stream rather than trusting Content-Length.
  let body: any;
  const reader = req.body?.getReader();
  if (!reader) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        return NextResponse.json({ error: "Request body too large" }, { status: 413 });
      }
      chunks.push(chunk.value);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  } finally {
    reader.releaseLock();
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Request body must be an object" }, { status: 400 });
  }

  if (Object.keys(body).some((key) => key !== "title" && key !== "revision" && key !== "appearance") ||
      typeof body.revision !== "number" || !Number.isSafeInteger(body.revision) || body.revision < 0) {
    return NextResponse.json({ error: "Field 'revision' must be a non-negative integer" }, { status: 400 });
  }

  if (typeof body.title !== "string" || body.title.length > 160) {
    return NextResponse.json({ error: "Field 'title' must be a string of at most 80 Unicode characters" }, { status: 400 });
  }

  if (body.appearance !== undefined && body.appearance !== null && !isBrowserTabAppearance(body.appearance)) {
    return NextResponse.json({ error: "Invalid tab appearance: use supported tokens and six-digit hex colors" }, { status: 400 });
  }

  const titleStr = body.title;

  try {
    const updated = await writeAgentWebSettings({
      title: titleStr,
      revision: body.revision,
      ...(body.appearance !== undefined ? { appearance: body.appearance } : {}),
    });

    return NextResponse.json(
      {
        success: true,
        version: updated.version,
        revision: updated.revision,
        title: updated.title,
        customTitle: normalizeBrowserTabTitle(updated.title),
        appearance: updated.tabAppearance ?? null,
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        },
      }
    );
  } catch (err: any) {
    if (err instanceof SettingsConflictError) {
      return NextResponse.json(
        {
          error: "Conflict: revision mismatch",
          currentRevision: err.currentRevision,
          requestedRevision: err.requestedRevision,
        },
        { status: 409 }
      );
    }
    if (err instanceof MalformedSettingsError) {
      return NextResponse.json(
        { error: "Malformed agent web settings file (fail closed)" },
        { status: 500 }
      );
    }
    return NextResponse.json(
      { error: "Failed to update browser tab title settings" },
      { status: 500 }
    );
  }
}
