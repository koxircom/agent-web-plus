import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession, setRpcSessionTools } from "@/lib/rpc-manager";
import { acknowledgeRecalledPromptDelivery, getPromptReceipt, getUncommittedPromptSubmissions, isPromptDeliveryCommitting, runPromptDelivery, validPromptRequestId } from "@/lib/prompt-delivery";

async function executeCommand(id: string, body: Record<string, unknown>): Promise<unknown> {
  if (body.type === "acknowledge_recalled_prompts") {
    if (!Array.isArray(body.requestIds) || body.requestIds.length > 512 || !body.requestIds.every(validPromptRequestId)) throw new Error("Invalid recalled prompt IDs");
    for (const requestId of body.requestIds) acknowledgeRecalledPromptDelivery(id, requestId);
    return { cancelledPromptRequestIds: body.requestIds.filter(requestId => getPromptReceipt(id, requestId).status === "cancelled") };
  }
  const requestedToolNames = body.toolNames;
  if (requestedToolNames !== undefined
    && (!Array.isArray(requestedToolNames) || requestedToolNames.some((name) => typeof name !== "string"))) {
    throw new Error("toolNames must be an array of strings");
  }
  const toolNames = requestedToolNames as string[] | undefined;
  const existing = getRpcSession(id);
  if (body.type === "set_tools") {
    const filePath = existing?.sessionFile || await resolveSessionPath(id) || undefined;
    if (!existing?.isAlive() && !filePath) throw new Error("Session not found");
    const changed = await setRpcSessionTools(id, filePath, toolNames);
    return { sessionId: changed.sessionId, recreated: changed.recreated };
  }
  if (existing?.isAlive()) return await existing.send(body);
  const filePath = await resolveSessionPath(id);
  if (!filePath) throw new Error("Session not found");
  const { session } = await startRpcSession(id, filePath, undefined, {
    ...(toolNames !== undefined ? { toolNames } : {}),
  });
  return await session.send(body);
}

// A request ID identifies one submission, not the text (identical messages are valid).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let commandType: string | undefined;
  let requestId: string | undefined;
  try {
    const body = await req.json() as Record<string, unknown>;
    commandType = typeof body.type === "string" ? body.type : undefined;
    if (body.type === "prompt" && body.requestId !== undefined && !validPromptRequestId(body.requestId)) {
      throw new Error("Invalid prompt request ID");
    }
    if (body.type === "prompt" && body.requestId === undefined) body.requestId = randomUUID();
    requestId = validPromptRequestId(body.requestId) ? body.requestId : undefined;
    const execute = () => executeCommand(id, body);
    const result = body.type === "prompt" && validPromptRequestId(body.requestId)
      ? await runPromptDelivery(id, body.requestId, body, execute)
      : await execute();
    return NextResponse.json({ success: true, data: result, ...(commandType === "prompt" && requestId ? { requestId, receipt: getPromptReceipt(id, requestId) } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const receipt = requestId ? getPromptReceipt(id, requestId) : null;
    const uncertain = receipt && !["unknown", "rejected"].includes(receipt.status);
    return NextResponse.json({ error: message,
      ...(commandType === "prompt" ? { code: uncertain ? "prompt_uncertain" : "prompt_rejected", accepted: Boolean(uncertain) } : {}),
    }, { status: message === "Session not found" ? 404 : 500 });
  }
}

// Receipt reads neither create a wrapper nor start a model request.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const query = new URL(req.url).searchParams;
  const requestId = query.get("requestId");
  if (requestId !== null) {
    if (!validPromptRequestId(requestId)) return NextResponse.json({ error: "Invalid prompt request ID" }, { status: 400 });
    const session = getRpcSession(id);
    return NextResponse.json({ ...getPromptReceipt(id, requestId),
      // Read-only: an admitted queue/run may legitimately be awaiting its user entry.
      inFlight: Boolean(session?.isAlive() && session.isPromptRequestActive(requestId)) || isPromptDeliveryCommitting(id, requestId),
    }, { headers: { "Cache-Control": "no-store" } });
  }
  if (query.get("interactions") === "1") {
    const session = getRpcSession(id);
    return NextResponse.json({
      pendingExtensionUiRequests: session?.isAlive() ? session.getPendingExtensionUiRequests() : [],
      uncommittedPrompts: getUncommittedPromptSubmissions(id),
    }, { headers: { "Cache-Control": "no-store" } });
  }
  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) return NextResponse.json({ running: false }, { headers: { "Cache-Control": "no-store" } });
    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: session.isRunning(), runtimeAlive: true, state }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
