"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createMarkdownMathPresencePlugin,
  markdownRehypePluginsWithoutMath,
  markdownRemarkPlugins,
  type MarkdownMathRehypePlugin,
} from "@/lib/markdown-math";

let markdownKatexPluginPromise: Promise<MarkdownMathRehypePlugin> | null = null;

function loadMarkdownKatexPlugin(): Promise<MarkdownMathRehypePlugin> {
  if (!markdownKatexPluginPromise) {
    markdownKatexPluginPromise = import("./MarkdownKatexRuntime").then(
      ({ markdownKatexPlugin }) => markdownKatexPlugin,
    );
  }
  return markdownKatexPluginPromise;
}

/**
 * Uses the remark AST as the trigger, so code and escaped delimiter text never
 * load the math renderer. Every markdown surface shares the same lazy chunk.
 */
export function useMarkdownMathPlugins() {
  const mathDetectedRef = useRef(false);
  const loadStartedRef = useRef(false);
  const [mathPlugin, setMathPlugin] = useState<MarkdownMathRehypePlugin | null>(null);

  // ReactMarkdown runs the remark plugin synchronously during this render.
  mathDetectedRef.current = false;
  const mathPresencePlugin = useMemo(
    () => createMarkdownMathPresencePlugin(() => {
      mathDetectedRef.current = true;
    }),
    [],
  );
  const remarkPlugins = useMemo(
    () => [...(markdownRemarkPlugins ?? []), mathPresencePlugin],
    [mathPresencePlugin],
  );
  const rehypePlugins = useMemo(
    () => mathPlugin
      ? [...(markdownRehypePluginsWithoutMath ?? []), mathPlugin]
      : markdownRehypePluginsWithoutMath,
    [mathPlugin],
  );

  // Running after every committed render also covers a FileViewer switching into
  // preview mode without changing its markdown source.
  useEffect(() => {
    if (!mathDetectedRef.current || loadStartedRef.current) return;
    loadStartedRef.current = true;
    void loadMarkdownKatexPlugin().then((plugin) => setMathPlugin(() => plugin)).catch(() => {
      // Keep the math source readable if the lazy chunk or stylesheet fails.
    });
  });

  return { remarkPlugins, rehypePlugins };
}
