import { Calendar, CalendarCheck, ChevronsUpDown, Hash, ImageUp, PenLine, Signature, SquareCheck, TextCursorInput, Type, UserRound, type LucideIcon } from "lucide-react";

import type { FieldType } from "@/lib/sign/pdf/types";

export const FIELD_ICONS: Record<FieldType, LucideIcon> = {
  signature: Signature,
  initials: PenLine,
  name: UserRound,
  date_signed: CalendarCheck,
  date: Calendar,
  text: TextCursorInput,
  number: Hash,
  static_text: Type,
  checkbox: SquareCheck,
  dropdown: ChevronsUpDown,
  upload: ImageUp,
};

/** The palette order: what a sender reaches for most often first. */
export const PALETTE_ORDER: readonly FieldType[] = ["signature", "initials", "name", "date_signed", "date", "text", "number", "static_text", "checkbox", "dropdown", "upload"];
