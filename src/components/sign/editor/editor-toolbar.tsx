"use client";

import { Eye, EyeOff, PanelRight, Redo2, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { stepZoom, ZOOM_STEPS, type Zoom } from "@/lib/sign/client/editor-pages";

import { NativeSelect } from "./form-bits";

interface ToolbarProps {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  zoom: Zoom;
  fitPercent: number;
  onZoom: (z: Zoom) => void;
  preview: boolean;
  onPreview: (on: boolean) => void;
  readOnly: boolean;
  /** Small screens: a page jumper and a button for the side panel. */
  compact: boolean;
  pageCount: number;
  currentPage: number;
  onGoto: (index: number) => void;
  panelOpen: boolean;
  onPanel: () => void;
  /** No side panel at all (a phone). */
  noPanel?: boolean;
  extra?: ReactNode;
}

export function EditorToolbar(p: ToolbarProps) {
  const t = useTranslations("Sign.editor");
  const zoomValue = p.zoom === "fit" ? "fit" : String(p.zoom);
  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-card px-3 py-1.5">
      {p.readOnly ? null : (
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" disabled={!p.canUndo} onClick={p.onUndo} aria-label={t("toolbar.undo")} title={`${t("toolbar.undo")} (Ctrl+Z)`}>
            <Undo2 />
          </Button>
          <Button type="button" variant="ghost" size="icon" disabled={!p.canRedo} onClick={p.onRedo} aria-label={t("toolbar.redo")} title={`${t("toolbar.redo")} (Ctrl+Shift+Z)`}>
            <Redo2 />
          </Button>
        </div>
      )}
      <div className="flex items-center gap-1">
        <Button type="button" variant="ghost" size="icon" onClick={() => p.onZoom(stepZoom(p.zoom, p.fitPercent, -1))} aria-label={t("toolbar.zoomOut")}>
          <ZoomOut />
        </Button>
        <label htmlFor="sign-zoom" className="sr-only">
          {t("toolbar.zoom")}
        </label>
        <NativeSelect id="sign-zoom" className="h-8 w-28" value={zoomValue} onChange={(e) => p.onZoom(e.target.value === "fit" ? "fit" : Number(e.target.value))}>
          <option value="fit">{t("toolbar.fitWidth")}</option>
          {ZOOM_STEPS.map((z) => (
            <option key={z} value={z}>
              {z}%
            </option>
          ))}
        </NativeSelect>
        <Button type="button" variant="ghost" size="icon" onClick={() => p.onZoom(stepZoom(p.zoom, p.fitPercent, 1))} aria-label={t("toolbar.zoomIn")}>
          <ZoomIn />
        </Button>
      </div>
      {p.compact && p.pageCount > 1 ? (
        <div className="flex items-center gap-1">
          <label htmlFor="sign-page-jump" className="sr-only">
            {t("toolbar.page")}
          </label>
          <NativeSelect id="sign-page-jump" className="h-8 w-28" value={p.currentPage} onChange={(e) => p.onGoto(Number(e.target.value))}>
            {Array.from({ length: p.pageCount }, (_, i) => (
              <option key={i} value={i}>
                {t("toolbar.pageOf", { page: i + 1, count: p.pageCount })}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : null}
      <Button type="button" variant={p.preview ? "default" : "outline"} size="sm" aria-pressed={p.preview} onClick={() => p.onPreview(!p.preview)}>
        {p.preview ? <EyeOff /> : <Eye />}
        {p.preview ? t("toolbar.previewOff") : t("toolbar.previewOn")}
      </Button>
      <div className="ml-auto flex items-center gap-2">
        {p.extra}
        {p.compact && !p.noPanel ? (
          <Button type="button" variant={p.panelOpen ? "default" : "outline"} size="sm" aria-pressed={p.panelOpen} onClick={p.onPanel}>
            <PanelRight />
            {t("toolbar.panel")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
