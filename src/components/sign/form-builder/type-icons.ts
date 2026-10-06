import { AlignLeft, Calendar, CircleDot, FileCheck, Hash, ImageUp, List, ListChecks, Mail, Paperclip, Phone, TextCursorInput, ToggleLeft, type LucideIcon } from "lucide-react";

import type { DataFieldType } from "@/lib/sign/forms/types";

export const DATA_TYPE_ICONS: Record<DataFieldType, LucideIcon> = {
  text: TextCursorInput,
  multiline: AlignLeft,
  number: Hash,
  email: Mail,
  phone: Phone,
  choice: CircleDot,
  multichoice: ListChecks,
  yesno: ToggleLeft,
  date: Calendar,
  list: List,
  file: Paperclip,
  image: ImageUp,
  acknowledge: FileCheck,
};
