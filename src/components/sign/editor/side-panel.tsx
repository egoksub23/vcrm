"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import type { Issue } from "@/lib/sign/rules";
import type { FieldType, PlacedField } from "@/lib/sign/pdf/types";
import type { FormDefinition } from "@/lib/sign/forms/types";
import type { SignLocale, SignerKind, SignRole } from "@/lib/sign/types";
import { cn } from "@/lib/utils";

import { DataFieldsPanel } from "./data-fields-panel";
import { FieldsList } from "./fields-list";
import { IssuesPanel } from "./issues-panel";
import { PropertiesPanel, type FieldChange } from "./properties-panel";
import { RolesPanel } from "./roles-panel";

export type PanelTab = "field" | "data" | "fields" | "roles" | "issues";
const TABS: readonly PanelTab[] = ["field", "fields", "roles", "issues"];
/** With a form there is one more tab: the form's data fields, to place them on the pages. */
const FORM_TABS: readonly PanelTab[] = ["field", "data", "fields", "roles", "issues"];

export interface SidePanelProps {
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  fields: readonly PlacedField[];
  roles: readonly SignRole[];
  selected: PlacedField | null;
  readOnly: boolean;
  /** The roles are the collection's people (see `RolesPanel`): read-only, and none can be added. */
  rolesLocked?: boolean;
  typeLabels: Record<FieldType, string>;
  senderLabel: string;
  mergeKeys: readonly string[];
  pageCount: number;
  issues: readonly Issue[];
  issueKeys: ReadonlySet<string>;
  onSelectFromList: (key: string) => void;
  onFieldChange: (change: FieldChange, coalesceKey?: string) => void;
  onDuplicate: () => void;
  onCopyToPages: () => void;
  onDelete: () => void;
  onAddRole: (kind: SignerKind) => void;
  onPatchRole: (key: string, patch: Partial<Pick<SignRole, "label" | "kind" | "color">>) => void;
  onDeleteRole: (key: string, reassignTo: string | null) => void;
  /** Forms: the template's form (adds the data tab, the parts each role holds, and "Fill with answer"). */
  form?: FormDefinition | null;
  /** The language the form's labels are shown in. */
  labelLocale?: SignLocale;
  /** Forms: the pages are loaded and another field fits, so a data field can be placed. */
  canPlaceData?: boolean;
  onPlaceData?: (dataKey: string) => void;
  onShowData?: (dataKey: string) => void;
  /** Shown above the tabs (the preview notice, for example). */
  banner?: ReactNode;
}

export function SidePanel(p: SidePanelProps) {
  const t = useTranslations("Sign.editor");
  const tf = useTranslations("Sign.formBuilder");
  const TABS_NOW = p.form ? FORM_TABS : TABS;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {p.banner}
      <div role="tablist" aria-label={t("panel.label")} className="flex shrink-0 border-b">
        {TABS_NOW.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            id={`sign-tab-${tab}`}
            aria-selected={p.tab === tab}
            aria-controls="sign-tabpanel"
            onClick={() => p.onTab(tab)}
            onKeyDown={(e) => {
              const i = TABS_NOW.indexOf(tab);
              const next = e.key === "ArrowRight" ? TABS_NOW[(i + 1) % TABS_NOW.length] : e.key === "ArrowLeft" ? TABS_NOW[(i + TABS_NOW.length - 1) % TABS_NOW.length] : null;
              if (next) {
                e.preventDefault();
                p.onTab(next);
                document.getElementById(`sign-tab-${next}`)?.focus();
              }
            }}
            className={cn("relative flex-1 px-1 py-2 text-xs font-medium outline-none focus-visible:bg-muted", p.tab === tab ? "text-foreground after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:bg-primary" : "text-muted-foreground hover:text-foreground")}
          >
            {tab === "data" ? tf("editor.panelData") : t(`panel.${tab}`)}
            {tab === "issues" && p.issues.length > 0 ? <span className="ml-1 rounded-full bg-amber-500/20 px-1.5 text-amber-700 dark:text-amber-300">{p.issues.length}</span> : null}
          </button>
        ))}
      </div>
      <div id="sign-tabpanel" role="tabpanel" aria-labelledby={`sign-tab-${p.tab}`} className="min-h-0 flex-1 overflow-y-auto">
        {p.tab === "field" ? (
          <PropertiesPanel
            field={p.selected}
            fields={p.fields}
            roles={p.roles}
            readOnly={p.readOnly}
            typeLabels={p.typeLabels}
            mergeKeys={p.mergeKeys}
            pageCount={p.pageCount}
            senderLabel={p.senderLabel}
            form={p.form}
            labelLocale={p.labelLocale}
            onChange={p.onFieldChange}
            onDuplicate={p.onDuplicate}
            onCopyToPages={p.onCopyToPages}
            onDelete={p.onDelete}
          />
        ) : null}
        {p.tab === "data" && p.form ? <DataFieldsPanel form={p.form} placements={p.fields} locale={p.labelLocale ?? "en"} readOnly={p.readOnly} canPlace={!!p.canPlaceData} onPlace={(k) => p.onPlaceData?.(k)} onShow={(k) => p.onShowData?.(k)} /> : null}
        {p.tab === "fields" ? <FieldsList fields={p.fields} roles={p.roles} selectedKey={p.selected?.key ?? null} issueKeys={p.issueKeys} typeLabels={p.typeLabels} senderLabel={p.senderLabel} form={p.form} labelLocale={p.labelLocale} onSelect={p.onSelectFromList} /> : null}
        {p.tab === "roles" ? <RolesPanel roles={p.roles} fields={p.fields} form={p.form} labelLocale={p.labelLocale} readOnly={p.readOnly} rolesLocked={p.rolesLocked} onAdd={p.onAddRole} onPatch={p.onPatchRole} onDelete={p.onDeleteRole} /> : null}
        {p.tab === "issues" ? <IssuesPanel issues={p.issues} fields={p.fields} roles={p.roles} typeLabels={p.typeLabels} form={p.form} labelLocale={p.labelLocale} onSelectField={p.onSelectFromList} onSelectRole={() => p.onTab("roles")} /> : null}
      </div>
    </div>
  );
}
