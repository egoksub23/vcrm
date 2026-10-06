"use client";

// ============================================================
// Doc Sign, signing page, forms in parts: the control for a SENSITIVE data field (an ID number, a bank account). What is
// typed is hidden as it is typed, with a button to show it for a moment (checked before they send). The page asks the
// browser not to remember it (`autoComplete="off"` and the hints password managers honour), nothing about it is put in
// the address or in an attribute but the field's own value, and the server stores it encrypted and shows it masked to
// the sender. A list takes the same switch (ListControl `secret`); a longer text is hidden with the browser's own
// text-security style, which not every browser has, so there the text stays visible.
// ============================================================

import { useState } from "react";
import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MAX_SINGLE_LINE, MAX_TEXT } from "@/lib/sign/rules";

import { inputText, type ControlProps } from "./control-props";
import { useFormText } from "./form-ui";
import { ListControl } from "./list-control";
import { NO_REMEMBER, RevealButton } from "./reveal-button";

const MODE: Record<string, "text" | "decimal" | "email" | "tel" | "numeric"> = { number: "decimal", email: "email", phone: "tel" };

export function SensitiveControl(props: ControlProps) {
  const { field, id, input, invalid, describedBy, onInput, onBlur } = props;
  const t = useTranslations("Sign.signerForm");
  const text = useFormText();
  const [shown, setShown] = useState(false);
  const noteId = `${id}-sensitive`;
  const described = [describedBy, noteId].filter(Boolean).join(" ");
  const label = text(field.label);
  const value = inputText(input);
  const placeholder = text(field.placeholder) || (field.type === "date" ? "YYYY-MM-DD" : "");

  const note = (
    <p id={noteId} className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      {t("sensitive.note")}
    </p>
  );

  if (field.type === "list") {
    return (
      <div className="space-y-2">
        <ListControl {...props} describedBy={described} secret />
        {note}
      </div>
    );
  }

  if (field.type === "multiline") {
    return (
      <div className="space-y-2">
        <div className="flex items-start gap-2">
          <Textarea
            id={id}
            value={value}
            rows={4}
            maxLength={Math.min(field.maxLength ?? MAX_TEXT, MAX_TEXT)}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={invalid || undefined}
            aria-describedby={described}
            style={shown ? undefined : ({ WebkitTextSecurity: "disc" } as React.CSSProperties)}
            className="min-h-28 min-w-0 flex-1 text-base"
            onChange={(e) => onInput({ text: e.target.value })}
            onBlur={onBlur}
          />
          <RevealButton shown={shown} onToggle={() => setShown((v) => !v)} controls={id} label={label} />
        </div>
        {note}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Input
          id={id}
          // a password-type input hides what is typed on every browser; "show" turns it into text
          type={shown ? "text" : "password"}
          inputMode={field.type === "text" ? undefined : MODE[field.type]}
          {...NO_REMEMBER}
          autoCapitalize="none"
          spellCheck={false}
          value={value}
          maxLength={field.type === "number" ? 40 : field.type === "email" ? 254 : field.type === "date" ? 10 : Math.min(field.maxLength ?? MAX_SINGLE_LINE, MAX_SINGLE_LINE)}
          placeholder={placeholder}
          aria-invalid={invalid || undefined}
          aria-describedby={described}
          className="h-11 min-w-0 flex-1 text-base"
          onChange={(e) => onInput({ text: e.target.value })}
          onBlur={onBlur}
        />
        <RevealButton shown={shown} onToggle={() => setShown((v) => !v)} controls={id} label={label} />
      </div>
      {note}
    </div>
  );
}
