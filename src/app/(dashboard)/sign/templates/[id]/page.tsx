"use client";

import { use } from "react";

import { TemplateEditorScreen } from "@/components/sign/editor/template-editor-screen";

// The full-screen template editor. `params` and `searchParams` are Promises in this version of Next: read them with `use`.
// `?focus=<placement key>` opens on that placement (the form builder's "Printed on the form" link).
export default function TemplateEditorPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ focus?: string | string[] }> }) {
  const { id } = use(params);
  const { focus } = use(searchParams);
  return <TemplateEditorScreen key={id} templateId={id} focus={Array.isArray(focus) ? focus[0] : focus} />;
}
