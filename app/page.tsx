import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { PiWebEnhancementsRuntime } from "@/components/PiWebEnhancementsRuntime";
import { I18nProvider } from "@/hooks/useI18n";
import { readSessionList } from "@/lib/session-list";
import { readEnhancementState, getEnhancementStatePresence } from "@/lib/enhancement-state-api";

// User-specific state must never become a static or shared page snapshot.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Home() {
  const [catalog, decorations] = await Promise.all([
    readSessionList({ summary: true }).catch(() => null),
    Promise.resolve().then(() => readEnhancementState()).catch(() => null),
  ]);
  const bootstrap = catalog ? { ...catalog, decorations, renderedAt: Date.now() } : undefined;
  return (
    <Suspense>
      <I18nProvider>
        <AppShell bootstrap={bootstrap} />
      </I18nProvider>
      <PiWebEnhancementsRuntime initialState={decorations} durableStatePresent={getEnhancementStatePresence() === "present"} />
    </Suspense>
  );
}
