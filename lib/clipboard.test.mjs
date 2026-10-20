import assert from "node:assert/strict";
import test from "node:test";
import { copyText } from "./clipboard.ts";

test("copy confirms success, falls back on restricted browsers, and cleans up failures", async t => {
  const saved = Object.fromEntries(["navigator", "document", "HTMLElement"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }});
  let clipboard, allowed = true, value, nodes = [], focused = 0;
  class Element { focus() { focused++; } }
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: Element });
  Object.defineProperty(globalThis, "navigator", { configurable: true, get: () => ({ clipboard }) });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    activeElement: new Element(),
    createElement: () => ({ style: {}, select() {}, remove() { nodes = nodes.filter(n => n !== this); } }),
    body: { appendChild: node => nodes.push(node) },
    execCommand: () => { value = nodes[0].value; return allowed; },
  }});
  clipboard = { writeText: async text => { value = text; } };
  await copyText("直接复制"); assert.equal(value, "直接复制"); assert.equal(nodes.length, 0);
  clipboard = { writeText: async () => { throw Error("blocked"); } };
  await copyText("受限浏览器回退"); assert.equal(value, "受限浏览器回退"); assert.equal(nodes.length, 0);
  clipboard = undefined; allowed = false;
  await assert.rejects(copyText("手动复制"), /浏览器未允许复制/);
  assert.equal(nodes.length, 0); assert.equal(focused, 2);
});
