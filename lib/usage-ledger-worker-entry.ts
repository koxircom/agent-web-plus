import { parentPort } from "node:worker_threads";
import { getUsageLedger, refreshUsageLedger, type UsageLedgerMode } from "./usage-ledger-service";
import { readUsageByEngine } from "./usage-ledger-engines";
import { getUsagePricing } from "./usage-pricing";
import { gzipSync } from "node:zlib";

if (!parentPort) throw new Error("Usage ledger worker requires a parent port");
const port = parentPort;
let queue = Promise.resolve();

// Keep all large parsing, validation, aggregation and JSON encoding in this
// worker. Only transferable response bytes cross back to the request loop.
port.on("message", (message: { id: number; refresh: boolean }) => {
  if (!message || !Number.isSafeInteger(message.id) || typeof message.refresh !== "boolean") return;
  queue = queue.then(async () => {
    let mode: UsageLedgerMode = process.env.PI_USAGE_DATA_DIR?.trim() ? "legacy-central" : "native-local";
    try {
      const result = await readUsageByEngine(message.refresh ? refreshUsageLedger : getUsageLedger, undefined, message.refresh);
      mode = result.mode;
      let pricing;
      try { pricing = await getUsagePricing(); }
      catch { console.warn("[usage-ledger] Pricing snapshot unavailable"); }
      const body = new TextEncoder().encode(JSON.stringify(pricing ? { ...result.ledger, pricing } : result.ledger));
      const compressed = new Uint8Array(gzipSync(body));
      port.postMessage({ id: message.id, mode, body, compressed, status: 200 }, [body.buffer, compressed.buffer]);
    } catch (error) {
      const markedMode = (error as { mode?: unknown } | null)?.mode;
      if (markedMode === "legacy-central" || markedMode === "native-local") mode = markedMode;
      console.warn("[usage-ledger] Snapshot computation failed");
      const body = new TextEncoder().encode(JSON.stringify({ error: "未能获取到有效的账本快照数据" }));
      port.postMessage({ id: message.id, mode, body, status: 503 }, [body.buffer]);
    }
  });
});
