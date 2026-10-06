"use client";

// The editing state of the form builder: the form, the template's placements kept in step with it, an undo
// history, and every operation the builder offers. Each operation goes through `commit`, which records an
// undo step. The pure work is in `src/lib/sign/client/form-*.ts` (tested); this hook only wires it to React.

import { useCallback, useRef, useState } from "react";

import type { DataField, DataFieldType, FormDefinition, FormPart } from "@/lib/sign/forms/types";
import type { PlacedField } from "@/lib/sign/pdf/types";
import {
  addField as addFieldTo,
  addPart as addPartTo,
  deleteField as deleteFieldFrom,
  deletePart as deletePartFrom,
  duplicateField as duplicateFieldIn,
  moveField as moveFieldIn,
  movePart as movePartIn,
  renameField,
  renamePartKey,
  retypeField,
  stepField as stepFieldIn,
  stepPart as stepPartIn,
  updateField,
  updatePart,
  type FormSeeds,
  type RuleChange,
} from "@/lib/sign/client/form-edit";
import { canRedoHist, canUndoHist, initHist, pushHist, redoHist, undoHist, type Hist } from "@/lib/sign/client/form-history";
import { keyFromLabel, takenDataKeys } from "@/lib/sign/client/form-keys";
import { applyPlacementOps, incompatibleBound, placementsBoundTo, type PlacementOp } from "@/lib/sign/client/form-printing";

export interface BuilderDoc {
  form: FormDefinition;
  /** The template's placements, with the changes this screen made to the ones that print a data field. */
  placements: PlacedField[];
  /** Those changes, so they can be replayed on a newer version of the template when saving. */
  ops: PlacementOp[];
  /** Keys that still follow the English label as it is typed ("f:<field key>", "p:<part key>"). */
  autoKeys: string[];
}

export interface RemovalNotice {
  fields: number;
  places: number;
  ruleChanges: RuleChange[];
}

const FIELD = (k: string) => `f:${k}`;
const PART = (k: string) => `p:${k}`;
const keysOf = (d: BuilderDoc) => takenDataKeys(d.form, d.placements);
/** The document with another form, or null (no change, no undo step) when the form came back the same. */
const withForm = (d: BuilderDoc, form: FormDefinition): BuilderDoc | null => (form === d.form ? null : { ...d, form });

export function useFormModel(initial: { form: FormDefinition; placements: PlacedField[] }, seeds: FormSeeds) {
  const [hist, setHist] = useState<Hist<BuilderDoc>>(() => initHist({ form: initial.form, placements: initial.placements, ops: [], autoKeys: [] }));
  const live = useRef(hist);

  const apply = useCallback((next: Hist<BuilderDoc>) => {
    live.current = next;
    setHist(next);
  }, []);

  const commit = useCallback(
    (make: (doc: BuilderDoc) => BuilderDoc | null, coalesceKey?: string): boolean => {
      const h = live.current;
      const next = make(h.present);
      if (!next || Object.is(next, h.present)) return false;
      apply(pushHist(h, next, { coalesceKey }));
      return true;
    },
    [apply],
  );

  const doc = hist.present;

  // ---- history --------------------------------------------------------------------------------------
  const undo = useCallback(() => apply(undoHist(live.current)), [apply]);
  const redo = useCallback(() => apply(redoHist(live.current)), [apply]);
  /** Replace everything (after a save or a reload): a fresh history. */
  const reset = useCallback((next: { form: FormDefinition; placements: PlacedField[] }) => apply(initHist({ form: next.form, placements: next.placements, ops: [], autoKeys: [] })), [apply]);

  // ---- parts ----------------------------------------------------------------------------------------
  const addPart = useCallback(
    (role: string): string | null => {
      let made: string | null = null;
      commit((d) => {
        const r = addPartTo(d.form, { title: seeds.newPart, role });
        if (!r) return null;
        made = r.key;
        return { ...d, form: r.form, autoKeys: [...d.autoKeys, PART(r.key)] };
      });
      return made;
    },
    [commit, seeds],
  );

  /** Change a part's title, description, role or rule. While its key still follows the title, the key follows it. */
  const patchPart = useCallback(
    (key: string, patch: Partial<Omit<FormPart, "key">> | ((p: FormPart) => FormPart), coalesceKey?: string): string => {
      let resultKey = key;
      commit((d) => {
        let form = updatePart(d.form, key, patch);
        let autoKeys = d.autoKeys;
        const part = form.parts.find((p) => p.key === key);
        if (part && autoKeys.includes(PART(key)) && part.title.en.trim()) {
          const taken = new Set(form.parts.filter((p) => p.key !== key).map((p) => p.key));
          const next = keyFromLabel(part.title.en, taken, "part");
          if (next !== key) {
            form = renamePartKey(form, key, next);
            autoKeys = autoKeys.map((k) => (k === PART(key) ? PART(next) : k));
            resultKey = next;
          }
        }
        return form === d.form ? null : { ...d, form, autoKeys };
      }, coalesceKey ? `${coalesceKey}:${key}` : undefined);
      if (resultKey !== key && coalesceKey) live.current = { ...live.current, lastKey: `${coalesceKey}:${resultKey}` };
      return resultKey;
    },
    [commit],
  );

  const movePart = useCallback((key: string, to: number) => commit((d) => withForm(d, movePartIn(d.form, key, to))), [commit]);
  const stepPart = useCallback((key: string, direction: -1 | 1) => commit((d) => withForm(d, stepPartIn(d.form, key, direction))), [commit]);

  /** Delete a part, its fields, the placements that printed them and the rules that named them. */
  const removePart = useCallback(
    (key: string): RemovalNotice | null => {
      let notice: RemovalNotice | null = null;
      commit((d) => {
        const r = deletePartFrom(d.form, key);
        const gone = new Set(r.removedFields);
        const bound = placementsBoundTo(d.placements, gone);
        notice = { fields: r.removedFields.length, places: bound.length, ruleChanges: r.ruleChanges };
        const ops: PlacementOp[] = r.removedFields.filter((f) => bound.some((p) => p.data === f)).map((data) => ({ type: "remove_bound", data }));
        return {
          form: r.form,
          placements: applyPlacementOps(d.placements, ops),
          ops: [...d.ops, ...ops],
          autoKeys: d.autoKeys.filter((k) => k !== PART(key) && !(k.startsWith("f:") && gone.has(k.slice(2)))),
        };
      });
      return notice;
    },
    [commit],
  );

  // ---- data fields ----------------------------------------------------------------------------------
  const addField = useCallback(
    (part: string, type: DataFieldType): string | null => {
      let made: string | null = null;
      commit((d) => {
        const r = addFieldTo(d.form, { part, type, seeds, taken: keysOf(d) });
        if (!r) return null;
        made = r.key;
        return { ...d, form: r.form, autoKeys: [...d.autoKeys, FIELD(r.key)] };
      });
      return made;
    },
    [commit, seeds],
  );

  /**
   * Change a data field. When its English label changes and its key still follows the label, the key follows too (rules and the placements
   * that print it follow the key). Returns the field's key after the change.
   */
  const patchField = useCallback(
    (key: string, patch: Partial<DataField> | ((f: DataField) => DataField), coalesceKey?: string): string => {
      let resultKey = key;
      commit((d) => {
        let form = updateField(d.form, key, patch);
        if (form === d.form) return null;
        let { ops, placements, autoKeys } = d;
        const field = form.fields.find((f) => f.key === key);
        if (field && autoKeys.includes(FIELD(key)) && field.label.en.trim()) {
          const taken = takenDataKeys({ ...form, fields: form.fields.filter((f) => f.key !== key) }, d.placements);
          const next = keyFromLabel(field.label.en, taken, "field");
          if (next !== key) {
            form = renameField(form, key, next);
            const op: PlacementOp = { type: "rename_data", from: key, to: next };
            if (placements.some((p) => p.data === key)) {
              ops = [...ops, op];
              placements = applyPlacementOps(placements, [op]);
            }
            autoKeys = autoKeys.map((k) => (k === FIELD(key) ? FIELD(next) : k));
            resultKey = next;
          }
        }
        return { form, placements, ops, autoKeys };
      }, coalesceKey ? `${coalesceKey}:${key}` : undefined);
      // typing a label renames the key at every keystroke: keep them one undo step
      if (resultKey !== key && coalesceKey) live.current = { ...live.current, lastKey: `${coalesceKey}:${resultKey}` };
      return resultKey;
    },
    [commit],
  );

  /** The sender chose a key by hand: it no longer follows the label. False when the key is not acceptable or already used. */
  const setFieldKey = useCallback(
    (key: string, next: string): boolean =>
      commit((d) => {
        if (next === key) return null;
        if (d.form.fields.some((f) => f.key === next) || d.placements.some((p) => p.key === next)) return null;
        const form = renameField(d.form, key, next);
        if (form === d.form) return null;
        const op: PlacementOp = { type: "rename_data", from: key, to: next };
        const bound = d.placements.some((p) => p.data === key);
        return {
          form,
          placements: bound ? applyPlacementOps(d.placements, [op]) : d.placements,
          ops: bound ? [...d.ops, op] : d.ops,
          autoKeys: d.autoKeys.filter((k) => k !== FIELD(key)),
        };
      }, `key:${key}`),
    [commit],
  );

  /** Change a field's type. Boxes on the pages that printed it and cannot print the new type are removed (and counted). */
  const changeType = useCallback(
    (key: string, type: DataFieldType): number => {
      let removed = 0;
      commit((d) => {
        const form = updateField(d.form, key, (f) => retypeField(f, type, seeds));
        if (form === d.form) return null;
        const field = form.fields.find((f) => f.key === key);
        const gone = field ? incompatibleBound(field, d.placements) : [];
        removed = gone.length;
        const ops: PlacementOp[] = gone.map((p) => ({ type: "remove_placement", key: p.key }));
        return { ...d, form, placements: applyPlacementOps(d.placements, ops), ops: [...d.ops, ...ops] };
      });
      return removed;
    },
    [commit, seeds],
  );

  /** Remove one box from the pages (to settle a problem the form builder cannot otherwise fix). */
  const removePlacement = useCallback(
    (key: string) =>
      commit((d) => {
        if (!d.placements.some((p) => p.key === key)) return null;
        const op: PlacementOp = { type: "remove_placement", key };
        return { ...d, placements: applyPlacementOps(d.placements, [op]), ops: [...d.ops, op] };
      }),
    [commit],
  );

  const duplicateField = useCallback(
    (key: string): string | null => {
      let made: string | null = null;
      commit((d) => {
        const r = duplicateFieldIn(d.form, key, keysOf(d), seeds);
        if (!r) return null;
        made = r.key;
        return { ...d, form: r.form };
      });
      return made;
    },
    [commit, seeds],
  );

  /** Delete a data field, the placements that print it and the rule conditions that named it. */
  const removeField = useCallback(
    (key: string): RemovalNotice | null => {
      let notice: RemovalNotice | null = null;
      commit((d) => {
        const r = deleteFieldFrom(d.form, key);
        if (r.form === d.form) return null;
        const bound = placementsBoundTo(d.placements, new Set([key]));
        notice = { fields: 1, places: bound.length, ruleChanges: r.ruleChanges };
        const ops: PlacementOp[] = bound.length > 0 ? [{ type: "remove_bound", data: key }] : [];
        return { form: r.form, placements: applyPlacementOps(d.placements, ops), ops: [...d.ops, ...ops], autoKeys: d.autoKeys.filter((k) => k !== FIELD(key)) };
      });
      return notice;
    },
    [commit],
  );

  const moveField = useCallback((key: string, target: { part: string; index: number }) => commit((d) => withForm(d, moveFieldIn(d.form, key, target))), [commit]);
  const stepField = useCallback((key: string, direction: -1 | 1) => commit((d) => withForm(d, stepFieldIn(d.form, key, direction))), [commit]);

  return {
    doc,
    form: doc.form,
    placements: doc.placements,
    canUndo: canUndoHist(hist),
    canRedo: canRedoHist(hist),
    undo,
    redo,
    reset,
    addPart,
    patchPart,
    movePart,
    stepPart,
    removePart,
    addField,
    patchField,
    setFieldKey,
    changeType,
    removePlacement,
    duplicateField,
    removeField,
    moveField,
    stepField,
    /** A field's key still follows its label (so the key box can say so). */
    followsLabel: (key: string) => doc.autoKeys.includes(FIELD(key)),
  };
}

export type FormModel = ReturnType<typeof useFormModel>;
