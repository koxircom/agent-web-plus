import { NextResponse } from "next/server";
import {
  ModelsConfigConflictError,
  ModelsConfigReadError,
  ModelsConfigWriteError,
  readModelsConfig,
  writeModelsConfig,
} from "@/lib/models-config-store";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET(req: Request) {
  if (req && !isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    return NextResponse.json(readModelsConfig());
  } catch (error) {
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error reading models config" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json(
      { error: "Content-Type must be application/json" },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isRecord(body)) {
    return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  }

  try {
    writeModelsConfig(body);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ModelsConfigConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ModelsConfigWriteError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    const errCode = (error as { code?: string })?.code;
    const message = error instanceof Error ? error.message : String(error);

    if (
      errCode === "LOCK_BUSY" ||
      message.includes("LOCK_BUSY") ||
      message.includes("lock") ||
      message.includes("timeout") ||
      message.includes("busy") ||
      message.includes("EAGAIN") ||
      message.includes("ELOCKED")
    ) {
      return NextResponse.json(
        { error: "Service temporarily busy, please retry" },
        {
          status: 503,
          headers: { "Retry-After": "1" },
        },
      );
    }

    if (
      errCode === "LEGACY_MODELS_INVALID" ||
      message.includes("LEGACY_MODELS_INVALID")
    ) {
      return NextResponse.json({ error: message }, { status: 422 });
    }

    return NextResponse.json(
      { error: "Internal error processing models config" },
      { status: 500 },
    );
  }
}
