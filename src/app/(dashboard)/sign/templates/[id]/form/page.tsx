"use client";

import { use } from "react";

import { FormBuilder } from "@/components/sign/form-builder/form-builder";

// The form builder of a template. `params` is a Promise in this version of Next: read it with `use`.
export default function TemplateFormPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <FormBuilder key={id} templateId={id} />;
}
