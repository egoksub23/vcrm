"use client";

import { use } from "react";

import { TemplateEditorScreen } from "@/components/sign/editor/template-editor-screen";

// The full-screen template editor. `params` is a Promise in this version of Next: read it with `use`.
export default function TemplateEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <TemplateEditorScreen key={id} templateId={id} />;
}
