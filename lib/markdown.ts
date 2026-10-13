import type { Options as ReactMarkdownOptions } from "react-markdown";
import rehypeKatex from "rehype-katex";
import { markdownRehypePluginsWithoutMath } from "./markdown-math.ts";

// Keep this entrypoint for server callers and existing tests. Client renderers
// import markdown-math directly and load KaTeX through the lazy runtime module.
export * from "./markdown-math.ts";

export const markdownRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  ...(markdownRehypePluginsWithoutMath ?? []),
  [rehypeKatex, { throwOnError: false, strict: false }],
];

export const markdownPreviewRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  ...markdownRehypePlugins,
];
