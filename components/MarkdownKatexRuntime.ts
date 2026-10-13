import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import type { MarkdownMathRehypePlugin } from "@/lib/markdown-math";

export const markdownKatexPlugin: MarkdownMathRehypePlugin = [
  rehypeKatex,
  { throwOnError: false, strict: false },
];
