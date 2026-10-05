// The arithmetic behind the draggable inbox panels, kept apart from the component so it can be tested.

export const KEY_STEP_PX = 16;

/** Keeps a panel between its minimum and the most room there is; a tight screen wins over the maximum. */
export function clampPaneWidth(px: number, min: number, max: number): number {
  return Math.min(Math.max(px, min), Math.max(min, max));
}

/**
 * `dir` is +1 when the panel sits before the divider (dragging right widens it) and -1 when it
 * sits after (dragging left widens it).
 */
export function draggedPaneWidth(
  startWidth: number,
  startX: number,
  currentX: number,
  dir: 1 | -1,
  min: number,
  max: number,
): number {
  return clampPaneWidth(startWidth + dir * (currentX - startX), min, max);
}

export function steppedPaneWidth(width: number, key: "ArrowLeft" | "ArrowRight", dir: 1 | -1, min: number, max: number): number {
  const toward = key === "ArrowRight" ? 1 : -1;
  return clampPaneWidth(width + dir * toward * KEY_STEP_PX, min, max);
}
