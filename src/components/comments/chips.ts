/** Small tags shared by the post list, the thread and the flat list. Colours use light-dark() (Tailwind dark: variants do not apply in this app). */
export const chip = "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap";

export const TONE = {
  muted: "bg-muted text-muted-foreground",
  primary: "bg-primary/15 text-primary",
  danger: "bg-destructive/15 text-destructive",
  warn: "bg-[color:light-dark(#fef3c7,#78350f66)] text-[light-dark(#92400e,#fcd34d)]",
  ok: "bg-[color:light-dark(#d1fae5,#064e3b66)] text-[light-dark(#047857,#6ee7b7)]",
  sample: "bg-[color:light-dark(#ede9fe,#4c1d9566)] text-[light-dark(#6d28d9,#c4b5fd)]",
} as const;
