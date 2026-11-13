"use client";

import type { ReactNode } from "react";

import { NoAccess } from "@/components/auth/no-access";
import { useAuth, useCapability } from "@/hooks/use-auth";

/** The frame every Setup page shares: a title, one line of help, and a guard on incidents.configure (the API enforces it again). */
export function SetupPage({ title, help, children }: { title: string; help: string; children: ReactNode }) {
  const { capabilitiesLoading } = useAuth();
  const allowed = useCapability("incidents.configure");
  if (capabilitiesLoading) return null;
  if (!allowed) return <NoAccess />;
  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-5">
      <header>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{help}</p>
      </header>
      {children}
    </div>
  );
}
