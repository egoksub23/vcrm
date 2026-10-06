"use client";

// Building a rule from lists, never typed code: "Show if [field] [is / is not / is one of / is empty / is not
// empty] [value]", joined by "all of" / "any of" groups to the depth the server allows. The options of a choice
// field are offered as values, and the whole rule is read back in plain words underneath. The tree logic is in
// `src/lib/sign/client/form-rules.ts`.

import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ruleTargets } from "@/lib/sign/client/form-edit";
import {
  addCondition,
  addGroup,
  canAdd,
  changeLeafField,
  changeLeafOp,
  isBlankCondition,
  isLeaf,
  leafMessageKey,
  newCondition,
  operatorsFor,
  removeAt,
  setAt,
  setGroupJoin,
  setLeafValue,
  toggleLeafValue,
  unwrapNot,
  valueChoices,
  type LeafOp,
  type LeafRule,
  type RulePath,
} from "@/lib/sign/client/form-rules";
import { pick } from "@/lib/sign/forms/text";
import type { DataField, FormDefinition, Rule } from "@/lib/sign/forms/types";
import type { SignLocale } from "@/lib/sign/types";
import { cn } from "@/lib/utils";

import { NativeSelect } from "./form-bits";
import { useRuleText } from "./use-rule-text";

interface RuleEditorProps {
  /** The heading: what the rule decides ("Show this field only if"). */
  title: string;
  /** The message key (under `rule`) of the sentence that reads the rule back: showWhen, requiredWhen or partShowWhen. */
  sentence: "showWhen" | "requiredWhen" | "partShowWhen";
  rule: Rule | undefined;
  form: FormDefinition;
  /** The field the rule belongs to (it may not look at itself). */
  ownerKey?: string;
  lang: SignLocale;
  disabled?: boolean;
  coalesceKey: string;
  onChange: (rule: Rule | undefined, coalesceKey: string) => void;
}

export function RuleEditor({ title, sentence, rule, form, ownerKey, lang, disabled, coalesceKey, onChange }: RuleEditorProps) {
  const t = useTranslations("Sign.formBuilder");
  const targets = useMemo(() => ruleTargets(form, ownerKey), [form, ownerKey]);
  const first = targets[0];

  const readBack = useRuleText(form, lang);

  const commit = (next: Rule | undefined) => onChange(next, coalesceKey);

  if (!rule) {
    return (
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{title}</p>
        {targets.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("rule.noFields")}</p>
        ) : (
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => first && commit(newCondition(first))}>
            <Plus />
            {t("rule.add")}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{title}</p>
        {disabled ? null : (
          <Button type="button" variant="ghost" size="xs" onClick={() => commit(undefined)}>
            <Trash2 />
            {t("rule.remove")}
          </Button>
        )}
      </div>
      <NodeView rule={rule} root={rule} path={[]} targets={targets} form={form} lang={lang} disabled={!!disabled} onCommit={commit} />
      <p className="rounded-md bg-muted/60 px-2 py-1.5 text-xs text-muted-foreground" aria-label={t("rule.inWords")}>
        <span className="font-medium text-foreground">{t("rule.inWords")}: </span>
        {t(`rule.${sentence}`, { rule: readBack(rule) })}
      </p>
    </div>
  );
}

interface NodeProps {
  rule: Rule;
  root: Rule;
  path: RulePath;
  targets: DataField[];
  form: FormDefinition;
  lang: SignLocale;
  disabled: boolean;
  onCommit: (next: Rule | undefined) => void;
}

function NodeView(p: NodeProps) {
  const { rule, root, path, disabled, onCommit } = p;
  const t = useTranslations("Sign.formBuilder");
  const first = p.targets[0];

  if (isLeaf(rule)) {
    return (
      <div className="space-y-1.5">
        <ConditionRow {...p} leaf={rule} />
        {path.length === 0 && !disabled && first ? (
          <div className="flex flex-wrap gap-1.5">
            <Button type="button" variant="outline" size="xs" disabled={!canAdd(root, path, "condition")} onClick={() => onCommit(addCondition(root, path, newCondition(first)))}>
              <Plus />
              {t("rule.addCondition")}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  if (rule.op === "not") {
    return (
      <div className="space-y-1.5 rounded-md border border-dashed p-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium">{t("rule.notHeading")}</span>
          {disabled ? null : (
            <Button type="button" variant="ghost" size="xs" onClick={() => onCommit(unwrapNot(root, path))}>
              {t("rule.unwrapNot")}
            </Button>
          )}
        </div>
        <NodeView {...p} rule={rule.rule} path={[...path, 0]} />
      </div>
    );
  }

  const nested = path.length > 0;
  return (
    <div className={cn("space-y-1.5", nested && "rounded-md border border-l-2 border-l-primary/50 p-2")}>
      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor={`rule-join-${path.join("-") || "root"}`}>
          {t("rule.joinLabel")}
        </label>
        <NativeSelect id={`rule-join-${path.join("-") || "root"}`} className="h-7 w-auto" value={rule.op} disabled={disabled} onChange={(e) => onCommit(setGroupJoin(root, path, e.target.value as "and" | "or"))}>
          <option value="and">{t("rule.joinAnd")}</option>
          <option value="or">{t("rule.joinOr")}</option>
        </NativeSelect>
        {nested && !disabled ? (
          <Button type="button" variant="ghost" size="icon-xs" className="ml-auto" aria-label={t("rule.removeGroup")} title={t("rule.removeGroup")} onClick={() => onCommit(removeAt(root, path))}>
            <Trash2 />
          </Button>
        ) : null}
      </div>
      <ul className="space-y-1.5">
        {rule.rules.map((child, i) => (
          <li key={i}>
            <NodeView {...p} rule={child} path={[...path, i]} />
          </li>
        ))}
      </ul>
      {disabled || !first ? null : (
        <div className="flex flex-wrap gap-1.5">
          <Button type="button" variant="outline" size="xs" disabled={!canAdd(root, path, "condition")} onClick={() => onCommit(addCondition(root, path, newCondition(first)))}>
            <Plus />
            {t("rule.addCondition")}
          </Button>
          <Button type="button" variant="outline" size="xs" disabled={!canAdd(root, path, "group")} onClick={() => onCommit(addGroup(root, path, rule.op === "and" ? "or" : "and", newCondition(first)))}>
            <Plus />
            {t("rule.addGroup")}
          </Button>
        </div>
      )}
      {!disabled && (!canAdd(root, path, "condition") || !canAdd(root, path, "group")) ? <p className="text-[11px] text-muted-foreground">{t("rule.limit")}</p> : null}
    </div>
  );
}

function ConditionRow(p: NodeProps & { leaf: LeafRule }) {
  const { leaf, root, path, targets, form, lang, disabled, onCommit } = p;
  const t = useTranslations("Sign.formBuilder");
  const field = form.fields.find((f) => f.key === leaf.field);
  const choices = valueChoices(field);
  const missing = !field || !targets.some((f) => f.key === leaf.field);
  const blank = isBlankCondition(leaf);
  const idBase = `rule-${path.join("-") || "root"}`;
  const ops: LeafOp[] = operatorsFor(field?.type ?? null);
  const opLabel = (op: LeafOp) => t(`rule.ops.${leafMessageKey(op, field?.type ?? "text")}`);
  const set = (next: LeafRule) => onCommit(setAt(root, path, next));
  const partTitle = (key: string) => {
    const part = form.parts.find((x) => x.key === key);
    return part ? pick(part.title, lang) || part.key : key;
  };
  const labelOf = (f: DataField) => pick(f.label, lang) || f.key;

  return (
    <div className={cn("space-y-1.5 rounded-md border bg-background p-2", (missing || blank) && "border-destructive/60")}>
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1 space-y-1.5">
          <label className="sr-only" htmlFor={`${idBase}-field`}>
            {t("rule.fieldLabel")}
          </label>
          <NativeSelect id={`${idBase}-field`} value={leaf.field} disabled={disabled} aria-invalid={missing || undefined} onChange={(e) => {
            const next = form.fields.find((f) => f.key === e.target.value);
            if (next) set(changeLeafField(leaf, next));
          }}>
            {missing ? <option value={leaf.field}>{t("rule.missingField", { field: leaf.field })}</option> : null}
            {form.parts.map((part) => {
              const inPart = targets.filter((f) => f.part === part.key);
              if (inPart.length === 0) return null;
              return (
                <optgroup key={part.key} label={partTitle(part.key)}>
                  {inPart.map((f) => (
                    <option key={f.key} value={f.key}>
                      {labelOf(f)}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </NativeSelect>
          <div className="grid grid-cols-2 gap-1.5">
            <div>
              <label className="sr-only" htmlFor={`${idBase}-op`}>
                {t("rule.operatorLabel")}
              </label>
              <NativeSelect id={`${idBase}-op`} value={leaf.op} disabled={disabled} onChange={(e) => set(changeLeafOp(leaf, e.target.value as LeafOp, field))}>
                {ops.map((op) => (
                  <option key={op} value={op}>
                    {opLabel(op)}
                  </option>
                ))}
                {!ops.includes(leaf.op) ? <option value={leaf.op}>{opLabel(leaf.op)}</option> : null}
              </NativeSelect>
            </div>
            <div>
              {leaf.op === "eq" || leaf.op === "ne" ? (
                choices ? (
                  <>
                    <label className="sr-only" htmlFor={`${idBase}-value`}>
                      {t("rule.valueLabel")}
                    </label>
                    <NativeSelect id={`${idBase}-value`} value={leaf.value} disabled={disabled} aria-invalid={blank || undefined} onChange={(e) => set(setLeafValue(leaf, e.target.value))}>
                      {!choices.some((c) => c.value === leaf.value) ? <option value={leaf.value}>{leaf.value === "" ? t("rule.pickValue") : t("rule.staleValue", { value: leaf.value })}</option> : null}
                      {choices.map((c) => (
                        <option key={c.value} value={c.value}>
                          {pick(c.label, lang) || c.value}
                        </option>
                      ))}
                    </NativeSelect>
                  </>
                ) : (
                  <>
                    <label className="sr-only" htmlFor={`${idBase}-value`}>
                      {t("rule.valueLabel")}
                    </label>
                    <Input id={`${idBase}-value`} value={leaf.value} disabled={disabled} maxLength={200} placeholder={t("rule.valuePlaceholder")} aria-invalid={blank || undefined} onChange={(e) => set(setLeafValue(leaf, e.target.value))} className="h-8" />
                  </>
                )
              ) : null}
            </div>
          </div>
          {leaf.op === "in" ? (
            <fieldset className="space-y-1" aria-invalid={blank || undefined}>
              <legend className="sr-only">{t("rule.valuesLabel")}</legend>
              {(choices ?? []).map((c) => (
                <label key={c.value} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={leaf.values.includes(c.value)} disabled={disabled} onCheckedChange={(v) => set(toggleLeafValue(leaf, c.value, v === true, (choices ?? []).map((x) => x.value)))} />
                  {pick(c.label, lang) || c.value}
                </label>
              ))}
              {leaf.values
                .filter((v) => !(choices ?? []).some((c) => c.value === v))
                .map((v) => (
                  <label key={v} className="flex items-center gap-2 text-sm text-destructive">
                    <Checkbox checked disabled={disabled} onCheckedChange={() => set(toggleLeafValue(leaf, v, false))} />
                    {t("rule.staleValue", { value: v })}
                  </label>
                ))}
              {choices && choices.length === 0 ? <p className="text-xs text-muted-foreground">{t("rule.noOptions")}</p> : null}
            </fieldset>
          ) : null}
        </div>
        {disabled ? null : (
          <Button type="button" variant="ghost" size="icon-xs" aria-label={t("rule.removeCondition")} title={t("rule.removeCondition")} onClick={() => onCommit(removeAt(root, path))}>
            <Trash2 />
          </Button>
        )}
      </div>
      {blank ? <p className="text-[11px] text-destructive">{t("rule.completeThis")}</p> : null}
      {missing ? <p className="text-[11px] text-destructive">{t("rule.fieldGone")}</p> : null}
    </div>
  );
}
