"use client";

// A rule as one line of plain words in a language. The wording lives in the builder's messages (`rule.leaf.*`,
// `rule.and`, `rule.or`, `rule.not`); the structure comes from `describeRule`.

import { useTranslations } from "next-intl";
import { useCallback, useMemo } from "react";

import { describeRule, leafMessageKey, ruleText, type RuleTranslator } from "@/lib/sign/client/form-rules";
import type { FormDefinition, Rule } from "@/lib/sign/forms/types";
import type { SignLocale } from "@/lib/sign/types";

export function useRuleText(form: FormDefinition, lang: SignLocale): (rule: Rule) => string {
  const t = useTranslations("Sign.formBuilder");
  const translator = useMemo<RuleTranslator>(() => {
    const list = (labels: string[]) => {
      try {
        return new Intl.ListFormat(lang, { type: "disjunction" }).format(labels);
      } catch {
        return labels.join(", ");
      }
    };
    return {
      leaf: (w) => t(`rule.leaf.${leafMessageKey(w.op, w.fieldType)}`, { field: w.fieldLabel, value: list(w.values.map((v) => v.label)), count: w.values.length }),
      join: (join, parts) => parts.join(` ${t(join === "and" ? "rule.and" : "rule.or")} `),
      not: (text) => t("rule.not", { rule: text }),
    };
  }, [t, lang]);
  return useCallback((rule: Rule) => ruleText(describeRule(rule, form, lang), translator), [form, lang, translator]);
}
