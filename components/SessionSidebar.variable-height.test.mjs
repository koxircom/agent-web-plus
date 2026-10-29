import assert from "node:assert/strict";
import test from "node:test";
import {createJiti} from "jiti";
const {getSessionListIndices} = await createJiti(import.meta.url, {jsx:{runtime:"automatic"},tsconfigPaths:true}).import("./SessionSidebar.tsx");


test("variable-height windows keep visible addon rows mounted and preserve focused editors", () => {
  const heights = Array.from({ length: 2000 }, (_, i) => i % 11 === 0 ? 1500 : 72);
  const tops = [0];
  for (const height of heights) tops.push(tops[tops.length - 1] + height);
  for (const scrollTop of [0, 1000, 1600, 10000, 50000]) {
    const indices = getSessionListIndices(heights.length, scrollTop, 335, 1999, tops);
    for (let i = 0; i < heights.length; i++) {
      if (tops[i] < scrollTop + 335 && tops[i + 1] > scrollTop) assert.ok(indices.includes(i), `missing visible row ${i} at ${scrollTop}`);
    }
    assert.ok(indices.includes(1999));
    assert.ok(indices.length < 32);
    assert.equal(new Set(indices).size, indices.length);
  }
});
