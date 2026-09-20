"use client";

import { forwardRef, useImperativeHandle, useRef, type KeyboardEvent, type TextareaHTMLAttributes } from "react";

import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { EmojiPicker } from "./emoji-picker";
import { useEmojiShortcut } from "./use-emoji-shortcut";

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
  /** Classes for the wrapper (`relative` is always applied), e.g. `flex-1` in a flex row. */
  containerClassName?: string;
  /** Render the design system's `Textarea` (used in settings forms) instead of a bare `<textarea>`. */
  ui?: boolean;
};

/**
 * A plain `<textarea>` with the emoji button in its top-right corner and the
 * ":" shortcut. Drop-in for the comment and note boxes: same props as a
 * textarea, but `onValueChange(value)` replaces `onChange`.
 */
export const EmojiTextarea = forwardRef<HTMLTextAreaElement, Props>(function EmojiTextarea(
  { value, onValueChange, containerClassName, ui, className, onKeyDown, onSelect, onBlur, disabled, readOnly, maxLength, ...rest },
  ref,
) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => fieldRef.current as HTMLTextAreaElement);
  const off = !!disabled || !!readOnly;
  const emoji = useEmojiShortcut({ fieldRef, value, onValueChange, enabled: !off, maxLength });
  const Field = ui ? Textarea : "textarea";

  return (
    <div className={cn("relative", containerClassName)}>
      {emoji.suggestions}
      <Field
        {...rest}
        ref={fieldRef}
        value={value}
        maxLength={maxLength}
        disabled={disabled}
        readOnly={readOnly}
        onChange={emoji.handleChange}
        onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
          if (emoji.handleKeyDown(e)) return;
          onKeyDown?.(e);
        }}
        onSelect={(e) => {
          emoji.handleSelect(e);
          onSelect?.(e);
        }}
        onBlur={(e) => {
          emoji.handleBlur();
          onBlur?.(e);
        }}
        // pr-9 goes last so a caller's px-* does not swallow the room for the button.
        className={cn("w-full", className, "pr-9")}
      />
      <EmojiPicker
        disabled={off}
        onPick={emoji.insertEmoji}
        returnFocusTo={() => fieldRef.current}
        className="absolute right-1 top-1 h-7 w-7"
      />
    </div>
  );
});
