import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { calculateDragMetrics, optimisticReorder } = await jiti.import("./composer-queue-drag.ts");

test("optimisticReorder moves item with splice(from, 1) and splice(target, 0)", () => {
  const items = ["A", "B", "C", "D"];
  // Move A (0) to C (2) -> [B, C, A, D]
  assert.deepEqual(optimisticReorder(items, 0, 2), ["B", "C", "A", "D"]);
  // Move D (3) to B (1) -> [A, D, B, C]
  assert.deepEqual(optimisticReorder(items, 3, 1), ["A", "D", "B", "C"]);
  // Move to same index -> unchanged
  assert.deepEqual(optimisticReorder(items, 2, 2), ["A", "B", "C", "D"]);
  // Out of bounds -> unchanged
  assert.deepEqual(optimisticReorder(items, -1, 2), ["A", "B", "C", "D"]);
  assert.deepEqual(optimisticReorder(items, 0, 99), ["A", "B", "C", "D"]);
});

test("calculateDragMetrics handles 3 follow-up items: top, middle, bottom slots and indicator line", () => {
  const rows = [
    { kind: "steer" }, // index 0 (steer)
    { kind: "follow-up" }, // index 1 (follow-up)
    { kind: "follow-up" }, // index 2 (follow-up)
    { kind: "follow-up" }, // index 3 (follow-up)
  ];

  // Assume row heights are 40px with top at 0, 40, 80, 120
  const rowRects = [
    { top: 100, bottom: 140, height: 40, offsetTop: 0 },
    { top: 140, bottom: 180, height: 40, offsetTop: 40 }, // mid = 160
    { top: 180, bottom: 220, height: 40, offsetTop: 80 }, // mid = 200
    { top: 220, bottom: 260, height: 40, offsetTop: 120 }, // mid = 240
  ];

  // Case 1: Dragging index 1 (top follow-up). Other follow-ups are index 2 (mid 200) and index 3 (mid 240).
  // Pointer is at Y=150 (above mid of index 2, which is 200) -> slot 0 -> targetIndex 1 (origin, no line)
  const res1 = calculateDragMetrics({
    pointerY: 150,
    startY: 160,
    scrollTop: 0,
    startScrollTop: 0,
    dragIndex: 1,
    dragKind: "follow-up",
    rows,
    rowRects,
  });
  assert.equal(res1.targetIndex, 1);
  assert.equal(res1.dropLine.visible, false); // Same as origin

  // Pointer moves down to Y=210 (between mid of index 2 [200] and index 3 [240]) -> slot 1 -> targetIndex 2
  const res2 = calculateDragMetrics({
    pointerY: 210,
    startY: 160,
    scrollTop: 0,
    startScrollTop: 0,
    dragIndex: 1,
    dragKind: "follow-up",
    rows,
    rowRects,
  });
  assert.equal(res2.slot, 1);
  assert.equal(res2.targetIndex, 2);
  assert.equal(res2.dropLine.visible, true);
  // Between otherIndices[0] (idx 2) and otherIndices[1] (idx 3) -> line top is offsetTop of idx 3 (120)
  assert.equal(res2.dropLine.top, 120);

  // Pointer moves further down to Y=255 (below mid of index 3 [240]) -> slot 2 -> targetIndex 3
  const res3 = calculateDragMetrics({
    pointerY: 255,
    startY: 160,
    scrollTop: 0,
    startScrollTop: 0,
    dragIndex: 1,
    dragKind: "follow-up",
    rows,
    rowRects,
  });
  assert.equal(res3.slot, 2);
  assert.equal(res3.targetIndex, 3);
  assert.equal(res3.dropLine.visible, true);
  // Below otherIndices[1] (idx 3) -> line top is 120 + 40 = 160
  assert.equal(res3.dropLine.top, 160);

  // Case 2: Dragging index 3 (bottom follow-up, startY=240) up to Y=170 (between idx 1 [mid 160] and idx 2 [mid 200])
  // Other follow-ups are idx 1 (mid 160) and idx 2 (mid 200).
  const res4 = calculateDragMetrics({
    pointerY: 170,
    startY: 240,
    scrollTop: 0,
    startScrollTop: 0,
    dragIndex: 3,
    dragKind: "follow-up",
    rows,
    rowRects,
  });
  assert.equal(res4.slot, 1);
  assert.equal(res4.targetIndex, 2);
  assert.equal(res4.dropLine.visible, true);
  // Line top at offsetTop of idx 2 (80)
  assert.equal(res4.dropLine.top, 80);

  // Dragging index 3 all the way to top: Y=150 (above idx 1 [mid 160])
  const res5 = calculateDragMetrics({
    pointerY: 150,
    startY: 240,
    scrollTop: 0,
    startScrollTop: 0,
    dragIndex: 3,
    dragKind: "follow-up",
    rows,
    rowRects,
  });
  assert.equal(res5.slot, 0);
  assert.equal(res5.targetIndex, 1);
  assert.equal(res5.dropLine.visible, true);
  // Line top at offsetTop of idx 1 (40)
  assert.equal(res5.dropLine.top, 40);
});

test("calculateDragMetrics handles autoScroll when near edges", () => {
  const rows = [{ kind: "follow-up" }, { kind: "follow-up" }];
  const rowRects = [
    { top: 100, bottom: 140, height: 40, offsetTop: 0 },
    { top: 140, bottom: 180, height: 40, offsetTop: 40 },
  ];
  const containerBounds = { top: 100, bottom: 300, height: 200 };

  // Near top edge (100 + 32 = 132) -> pointerY 110
  const topRes = calculateDragMetrics({
    pointerY: 110,
    startY: 160,
    scrollTop: 0,
    startScrollTop: 0,
    dragIndex: 1,
    dragKind: "follow-up",
    rows,
    rowRects,
    containerBounds,
  });
  assert.equal(topRes.autoScrollDirection, -1);

  // Near bottom edge (300 - 32 = 268) -> pointerY 280
  const btmRes = calculateDragMetrics({
    pointerY: 280,
    startY: 160,
    scrollTop: 0,
    startScrollTop: 0,
    dragIndex: 0,
    dragKind: "follow-up",
    rows,
    rowRects,
    containerBounds,
  });
  assert.equal(btmRes.autoScrollDirection, 1);

  // Center (pointerY 200) -> 0
  const midRes = calculateDragMetrics({
    pointerY: 200,
    startY: 160,
    scrollTop: 0,
    startScrollTop: 0,
    dragIndex: 0,
    dragKind: "follow-up",
    rows,
    rowRects,
    containerBounds,
  });
  assert.equal(midRes.autoScrollDirection, 0);
});
