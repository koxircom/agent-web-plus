export interface RowRectMetric {
  top: number;
  bottom: number;
  height: number;
  offsetTop: number;
}

export interface ContainerBounds {
  top: number;
  bottom: number;
  height: number;
}

export interface DragCalculationInput {
  pointerY: number;
  startY: number;
  scrollTop: number;
  startScrollTop: number;
  dragIndex: number;
  dragKind: "steer" | "follow-up";
  rows: readonly { kind: "steer" | "follow-up" }[];
  rowRects: readonly (RowRectMetric | null | undefined)[];
  containerBounds?: ContainerBounds | null;
}

export interface DragCalculationResult {
  offset: number;
  slot: number;
  targetIndex: number;
  hasMoved: boolean;
  dropLine: {
    top: number;
    visible: boolean;
  };
  autoScrollDirection: -1 | 0 | 1;
}

/**
 * Pure geometric calculation for queue drag and drop indicator line.
 * Eliminates sibling shifting and calculates target index based on original row midlines.
 */
export function calculateDragMetrics({
  pointerY,
  startY,
  scrollTop,
  startScrollTop,
  dragIndex,
  dragKind,
  rows,
  rowRects,
  containerBounds,
}: DragCalculationInput): DragCalculationResult {
  const kindIndices: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind === dragKind) {
      kindIndices.push(i);
    }
  }

  // Not enough items to reorder
  if (kindIndices.length <= 1 || dragIndex < 0 || dragIndex >= rows.length) {
    return {
      offset: 0,
      slot: 0,
      targetIndex: dragIndex,
      hasMoved: false,
      dropLine: { top: 0, visible: false },
      autoScrollDirection: 0,
    };
  }

  const rawOffset = pointerY - startY + (scrollTop - startScrollTop);
  const dragRect = rowRects[dragIndex];

  // Calculate clamp boundaries
  let minTop = dragRect?.offsetTop ?? 0;
  let maxBottom = (dragRect?.offsetTop ?? 0) + (dragRect?.height ?? 0);

  for (const idx of kindIndices) {
    const r = rowRects[idx];
    if (r) {
      if (r.offsetTop < minTop) minTop = r.offsetTop;
      const b = r.offsetTop + r.height;
      if (b > maxBottom) maxBottom = b;
    }
  }

  const myTop = dragRect?.offsetTop ?? 0;
  const myHeight = dragRect?.height ?? 0;
  const minOffset = minTop - myTop;
  const maxOffset = maxBottom - (myTop + myHeight);
  const offset = Math.max(minOffset - 12, Math.min(maxOffset + 12, rawOffset));

  const hasMoved = Math.abs(rawOffset) >= 4;

  // Other items of the same kind (excluding the dragged row)
  const otherIndices = kindIndices.filter((idx) => idx !== dragIndex);
  const otherCenters = otherIndices.map((idx) => {
    const r = rowRects[idx];
    return {
      index: idx,
      midY: r ? (r.top + r.bottom) / 2 : 0,
    };
  });

  // Calculate slot in range [0, otherIndices.length]
  let slot = 0;
  if (otherCenters.length > 0) {
    if (pointerY < otherCenters[0].midY) {
      slot = 0;
    } else if (pointerY >= otherCenters[otherCenters.length - 1].midY) {
      slot = otherCenters.length;
    } else {
      for (let j = 1; j < otherCenters.length; j++) {
        if (pointerY < otherCenters[j].midY) {
          slot = j;
          break;
        }
      }
    }
  }

  // Map slot directly to target index in the full rows array
  const targetIndex = kindIndices[slot] ?? dragIndex;

  // Drop indicator line positioning
  let dropLineTop = 0;
  const isLineVisible = hasMoved && targetIndex !== dragIndex && otherIndices.length > 0;

  if (isLineVisible) {
    if (slot === 0) {
      // Above the first remaining item
      const firstOther = rowRects[otherIndices[0]];
      dropLineTop = firstOther?.offsetTop ?? 0;
    } else if (slot === otherIndices.length) {
      // Below the last remaining item
      const lastOther = rowRects[otherIndices[otherIndices.length - 1]];
      dropLineTop = (lastOther?.offsetTop ?? 0) + (lastOther?.height ?? 0);
    } else {
      // Between otherIndices[slot - 1] and otherIndices[slot]
      const targetOther = rowRects[otherIndices[slot]];
      dropLineTop = targetOther?.offsetTop ?? 0;
    }
  }

  // Edge auto-scroll detection
  let autoScrollDirection: -1 | 0 | 1 = 0;
  if (containerBounds && hasMoved) {
    const edge = Math.min(32, Math.max(16, containerBounds.height / 4));
    if (pointerY < containerBounds.top + edge) {
      autoScrollDirection = -1;
    } else if (pointerY > containerBounds.bottom - edge) {
      autoScrollDirection = 1;
    }
  }

  return {
    offset,
    slot,
    targetIndex,
    hasMoved,
    dropLine: {
      top: dropLineTop,
      visible: isLineVisible,
    },
    autoScrollDirection,
  };
}

/**
 * Optimistically reorders a list following splice(from, 1) -> splice(target, 0) semantics.
 */
export function optimisticReorder<T>(list: readonly T[], fromIndex: number, targetIndex: number): T[] {
  if (
    fromIndex < 0 ||
    targetIndex < 0 ||
    fromIndex >= list.length ||
    targetIndex >= list.length ||
    fromIndex === targetIndex
  ) {
    return [...list];
  }
  const copy = [...list];
  const [item] = copy.splice(fromIndex, 1);
  copy.splice(targetIndex, 0, item);
  return copy;
}
