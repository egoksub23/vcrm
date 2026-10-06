"use client";

// ============================================================
// Doc Sign, signing page, forms in parts: the controls where a person types or picks a date: text, a
// longer text, a number, an email address, a phone number and a date. Each uses the keyboard the phone
// should show (numbers, email, phone) and 16 px text, so the page does not zoom in on focus.
// ============================================================

import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatKey } from "@/lib/sign/client/signer-form";
import { MAX_SINGLE_LINE, MAX_TEXT } from "@/lib/sign/rules";

import { inputText, type ControlProps } from "./control-props";
import { useFormText } from "./form-ui";

type Kind = "text" | "number" | "email" | "phone" | "date";

const ATTRIBUTES: Record<Kind, { type: string; inputMode?: "text" | "decimal" | "email" | "tel" | "numeric"; autoComplete: string }> = {
  text: { type: "text", autoComplete: "off" },
  number: { type: "text", inputMode: "decimal", autoComplete: "off" },
  email: { type: "email", inputMode: "email", autoComplete: "email" },
  phone: { type: "tel", inputMode: "tel", autoComplete: "tel" },
  date: { type: "date", autoComplete: "off" },
};

export function TextControl({ field, id, input, invalid, describedBy, onInput, onBlur }: ControlProps) {
  const t = useTranslations("Sign.signerForm");
  const text = useFormText();
  const value = inputText(input);
  const placeholder = text(field.placeholder) || (field.type === "phone" ? t("field.phonePlaceholder") : "");

  if (field.type === "multiline") {
    return (
      <Textarea
        id={id}
        value={value}
        rows={4}
        maxLength={Math.min(field.maxLength ?? MAX_TEXT, MAX_TEXT)}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className="min-h-28 text-base"
        onChange={(e) => onInput({ text: e.target.value })}
        onBlur={onBlur}
      />
    );
  }

  const kind: Kind = field.type === "number" || field.type === "email" || field.type === "phone" || field.type === "date" ? field.type : "text";
  const attrs = ATTRIBUTES[kind];
  // a text of digits gets the number pad as well
  const digits = kind === "text" && (formatKey(field.format) === "digits" || formatKey(field.format) === "postcode_my");
  return (
    <Input
      id={id}
      type={attrs.type}
      inputMode={digits ? "numeric" : attrs.inputMode}
      autoComplete={attrs.autoComplete}
      autoCapitalize={kind === "email" ? "none" : undefined}
      spellCheck={kind === "text" ? undefined : false}
      value={value}
      maxLength={kind === "date" ? undefined : kind === "number" ? 40 : kind === "email" ? 254 : Math.min(field.maxLength ?? MAX_SINGLE_LINE, MAX_SINGLE_LINE)}
      max={kind === "date" ? "9999-12-31" : undefined}
      placeholder={placeholder}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className="h-11 text-base"
      onChange={(e) => onInput({ text: e.target.value })}
      onBlur={onBlur}
    />
  );
}
