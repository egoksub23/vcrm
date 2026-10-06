// ============================================================
// The keyboard of the search picker (components/sign/signer/form/search-picker.tsx), as a pure function so it can be tested
// without a browser: what each key does to "is the list open" and "which match is highlighted", and whether it picks.
// The pattern is the WAI-ARIA combobox with a list popup: the arrows move the highlight without leaving the text box, Enter picks
// the highlighted match (and never submits the form), Escape closes, Tab leaves.
// ============================================================

export interface PickerState {
  open: boolean;
  /** The index of the highlighted match. */
  active: number;
}

export interface PickerKeyResult {
  /** The key was used here: the page must not also act on it (no scroll, no submit). */
  handled: boolean;
  state: PickerState;
  /** Pick the highlighted match. */
  pick?: boolean;
  /** The list closed and the text typed is dropped. */
  cancel?: boolean;
}

export function pickerKey(key: string, state: PickerState, count: number): PickerKeyResult {
  const last = Math.max(count - 1, 0);
  const clamp = (n: number) => Math.min(Math.max(n, 0), last);
  switch (key) {
    case "ArrowDown":
      return { handled: true, state: state.open ? { open: true, active: clamp(state.active + 1) } : { open: true, active: clamp(state.active) } };
    case "ArrowUp":
      return { handled: true, state: state.open ? { open: true, active: clamp(state.active - 1) } : { open: true, active: clamp(state.active) } };
    case "Home":
      return state.open ? { handled: true, state: { open: true, active: 0 } } : { handled: false, state };
    case "End":
      return state.open ? { handled: true, state: { open: true, active: last } } : { handled: false, state };
    case "Enter":
      return state.open && count > 0 ? { handled: true, state: { open: true, active: clamp(state.active) }, pick: true } : { handled: true, state: { open: true, active: 0 } };
    case "Escape":
      return state.open ? { handled: true, state: { open: false, active: 0 }, cancel: true } : { handled: false, state };
    case "Tab":
      return { handled: false, state: { open: false, active: 0 }, cancel: true };
    default:
      return { handled: false, state };
  }
}
