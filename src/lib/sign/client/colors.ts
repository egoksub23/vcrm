// ============================================================
// Doc Sign: the six role colours, defined once. A role has `color` 0..5; the editor, the signing page and
// the detail screen draw that role's fields and chips with it.
//
// Each colour has a light and a dark value. They are applied as CSS custom properties through
// `light-dark()`, which follows the app's own mode (html[data-mode] sets `color-scheme`), so a component
// needs no `dark:` class: put `roleColorStyle(n)` on an element and use the `ROLE_CLASS` strings (or
// `var(--rc-solid)`, `var(--rc-fill)`, `var(--rc-text)`, `var(--rc-ring)`) inside it.
// Colour is never the only signal: the screens always also show the role's label.
// ============================================================

import type { CSSProperties } from "react";

export interface RoleColor {
  /** A plain name for tests and for the colour picker's label key. */
  name: "violet" | "teal" | "amber" | "rose" | "sky" | "lime";
  light: { solid: string; fill: string; text: string };
  dark: { solid: string; fill: string; text: string };
}

export const ROLE_COLORS: readonly RoleColor[] = [
  { name: "violet", light: { solid: "#7c3aed", fill: "rgba(124, 58, 237, 0.13)", text: "#5b21b6" }, dark: { solid: "#a78bfa", fill: "rgba(167, 139, 250, 0.22)", text: "#ddd6fe" } },
  { name: "teal", light: { solid: "#0d9488", fill: "rgba(13, 148, 136, 0.13)", text: "#0f766e" }, dark: { solid: "#2dd4bf", fill: "rgba(45, 212, 191, 0.20)", text: "#99f6e4" } },
  { name: "amber", light: { solid: "#d97706", fill: "rgba(217, 119, 6, 0.14)", text: "#92400e" }, dark: { solid: "#fbbf24", fill: "rgba(251, 191, 36, 0.20)", text: "#fde68a" } },
  { name: "rose", light: { solid: "#e11d48", fill: "rgba(225, 29, 72, 0.12)", text: "#9f1239" }, dark: { solid: "#fb7185", fill: "rgba(251, 113, 133, 0.22)", text: "#fecdd3" } },
  { name: "sky", light: { solid: "#0284c7", fill: "rgba(2, 132, 199, 0.13)", text: "#075985" }, dark: { solid: "#38bdf8", fill: "rgba(56, 189, 248, 0.20)", text: "#bae6fd" } },
  { name: "lime", light: { solid: "#65a30d", fill: "rgba(101, 163, 13, 0.15)", text: "#3f6212" }, dark: { solid: "#a3e635", fill: "rgba(163, 230, 53, 0.18)", text: "#d9f99d" } },
];

/** The colour of the sender (static text and values filled in by the sender): neutral, never one of the six. */
export const SENDER_COLOR: Omit<RoleColor, "name"> & { name: "slate" } = {
  name: "slate",
  light: { solid: "#64748b", fill: "rgba(100, 116, 139, 0.12)", text: "#334155" },
  dark: { solid: "#94a3b8", fill: "rgba(148, 163, 184, 0.18)", text: "#e2e8f0" },
};

export const ROLE_COLOR_COUNT = ROLE_COLORS.length;

/** A colour slot made safe: anything that is not 0..5 is wrapped into range. */
export function roleColorIndex(color: number): number {
  if (!Number.isFinite(color)) return 0;
  const n = Math.trunc(color) % ROLE_COLOR_COUNT;
  return n < 0 ? n + ROLE_COLOR_COUNT : n;
}

export function roleColor(color: number): RoleColor {
  return ROLE_COLORS[roleColorIndex(color)];
}

function varsOf(c: Omit<RoleColor, "name"> & { name: string }, scheme: "auto" | "light"): CSSProperties {
  const pair = (k: "solid" | "fill" | "text") => (scheme === "light" ? c.light[k] : `light-dark(${c.light[k]}, ${c.dark[k]})`);
  return {
    ["--rc-solid" as string]: pair("solid"),
    ["--rc-fill" as string]: pair("fill"),
    ["--rc-text" as string]: pair("text"),
  };
}

/**
 * Inline style that defines `--rc-solid`, `--rc-fill` and `--rc-text` for a role's colour (`null`: the sender).
 * `scheme: "light"` always uses the light values: for things drawn on a page of the document, which is white
 * paper in dark mode too.
 */
export function roleColorStyle(color: number | null, scheme: "auto" | "light" = "auto"): CSSProperties {
  return varsOf(color === null ? SENDER_COLOR : roleColor(color), scheme);
}

/**
 * Class strings for elements inside an element carrying `roleColorStyle`. They are literal strings so the
 * Tailwind scanner finds them.
 */
export const ROLE_CLASS = {
  /** A box over a page: coloured edge and a light wash. */
  box: "border-[color:var(--rc-solid)] bg-[var(--rc-fill)] text-[color:var(--rc-text)]",
  /** A chip or a dot. */
  chip: "border-[color:var(--rc-solid)] bg-[var(--rc-fill)] text-[color:var(--rc-text)]",
  dot: "bg-[var(--rc-solid)]",
  handle: "border-[color:var(--rc-solid)] bg-background",
} as const;
