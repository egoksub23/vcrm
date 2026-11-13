"use client";

import { HelpCircle } from "lucide-react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * A small "?" beside a control or heading. Hover it, or focus it with the keyboard, and one plain sentence says what the thing is for, so people do not
 * have to guess what a field or a button does.
 */
export function InfoTip({ text, className }: { text: string; className?: string }) {
  return (
    <TooltipProvider delay={150}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={text}
              className={`inline-flex shrink-0 rounded-full align-middle text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 ${className ?? ""}`}
            />
          }
        >
          <HelpCircle className="size-3.5" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent className="max-w-64 text-left leading-snug whitespace-normal">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
