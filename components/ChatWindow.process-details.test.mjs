import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("keeps process details collapsed until opened or matched by search", () => {
  assert.match(source, /const \[expanded, setExpanded\] = useState\(false\)/);
  assert.match(source, /onClick=\{\(\) => setExpanded\(\(v\) => !v\)\}/);
  assert.match(source, /aria-expanded=\{expanded \|\| reveal\}/);
  assert.match(source, /\{\(expanded \|\| reveal\) && \(/);
  assert.match(
    source,
    /processPlan\.reveal \|\|= Boolean\(pendingSearchScroll && entryIds\[idx\] === pendingSearchScroll\.entryId && \(!searchBlock \|\| run\.message\.content\.includes\(searchBlock\)\)\)/,
  );
  assert.match(source, /<ProcessDetailsGroup toolStates=\{plan\.toolStates\} streamingThinking=\{plan\.streamingThinking\} reveal=\{plan\.reveal\}/);
});
