// ============================================================
// Doc Sign, browser side: the documents ticked in the list. Pure, so the rules (a limit, "all on this screen",
// what a tick on an already full selection does) are tested.
// ============================================================

/** Tick or untick one document. Ticking beyond `max` is refused (the selection stays as it was). */
export function toggleId(selected: readonly string[], id: string, max: number): string[] {
  if (selected.includes(id)) return selected.filter((x) => x !== id);
  return selected.length >= max ? [...selected] : [...selected, id];
}

/** Tick every one of `ids` (as many as fit under `max`, in the order given) or untick them all. */
export function toggleMany(selected: readonly string[], ids: readonly string[], on: boolean, max: number): string[] {
  if (!on) {
    const drop = new Set(ids);
    return selected.filter((x) => !drop.has(x));
  }
  const out = [...selected];
  for (const id of ids) {
    if (out.length >= max) break;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** How the "all" box on the screen looks: none, some or every one of `ids` ticked. */
export function allState(selected: readonly string[], ids: readonly string[]): "none" | "some" | "all" {
  if (ids.length === 0) return "none";
  const n = ids.filter((id) => selected.includes(id)).length;
  return n === 0 ? "none" : n === ids.length ? "all" : "some";
}
