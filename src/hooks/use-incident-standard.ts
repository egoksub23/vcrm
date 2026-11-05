"use client";

// Loads the incident template (categories + severity scale) and the active
// frameworks (obligation rules) for the current account.
// Falls back to BNM RMiT constants while loading or on error so
// existing views never break during the DB round-trip.

import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  INCIDENT_TYPES,
  INCIDENT_SEVERITIES,
  INCIDENT_SEVERITY_LABEL,
  P2_MINIMUM_TYPES,
} from "@/lib/incidents/constants";
import type {
  IncidentObligationRule,
  IncidentSeverityLevel,
  IncidentStandard,
  IncidentStandardConfig,
  IncidentTypeCatalogueEntry,
  StandardCatalogue,
} from "@/lib/incidents/standard-types";

// Module-level cache — avoids re-fetching on hook remount within the
// same session (standard config changes only when an admin switches it).
const _cache = new Map<string, IncidentStandardConfig>();

// Catalogues by standard id. The catalogue tables are global reference data,
// so a row's own template can be looked up even after the account has
// switched to another one. Promises are cached so a list of 200 incidents
// asks the database once.
const _catalogueCache = new Map<string, StandardCatalogue>();
const _cataloguePending = new Map<string, Promise<StandardCatalogue | null>>();

// ---- BNM fallback ------------------------------------------------

const _bnmFallbackTypes: IncidentTypeCatalogueEntry[] = INCIDENT_TYPES.map(
  (t, i) => ({
    id: `fallback-${t.code}`,
    standard_id: "fallback",
    code: t.code,
    name: t.label,
    description: t.description,
    default_severity: "P3",
    min_severity: (P2_MINIMUM_TYPES as readonly string[]).includes(t.code) ? "P2" : null,
    notifiable: false,
    default_flags: [],
    position: i,
  }),
);

const _bnmFallbackSeverities: IncidentSeverityLevel[] = INCIDENT_SEVERITIES.map(
  (s, i) => ({
    id: `fallback-${s}`,
    standard_id: "fallback",
    slug: s,
    label: INCIDENT_SEVERITY_LABEL[s],
    color: null,
    escalate_hrs: null,
    regulatory_hrs: null,
    resolve_days: null,
    position: i,
  }),
);

const STANDARD_COLUMNS = "id, slug, name, regulatory_body, sector, description, is_system, kind, created_at";

// ---- loaders -----------------------------------------------------

/** One standard's categories and severity scale. Cached by id. */
export function loadStandardCatalogue(
  supabase: SupabaseClient,
  standardId: string,
): Promise<StandardCatalogue | null> {
  const hit = _catalogueCache.get(standardId);
  if (hit) return Promise.resolve(hit);
  const pending = _cataloguePending.get(standardId);
  if (pending) return pending;

  const request = (async () => {
    try {
      const [stdRes, typesRes, sevRes] = await Promise.all([
        supabase.from("incident_standards").select(STANDARD_COLUMNS).eq("id", standardId).maybeSingle(),
        supabase.from("incident_type_catalogue").select("*").eq("standard_id", standardId).order("position"),
        supabase.from("incident_severity_levels").select("*").eq("standard_id", standardId).order("position"),
      ]);
      if (!stdRes.data) return null;
      const result: StandardCatalogue = {
        standard: stdRes.data as IncidentStandard,
        types: (typesRes.data ?? []) as IncidentTypeCatalogueEntry[],
        severities: (sevRes.data ?? []) as IncidentSeverityLevel[],
      };
      _catalogueCache.set(standardId, result);
      return result;
    } catch {
      return null;
    } finally {
      _cataloguePending.delete(standardId);
    }
  })();
  _cataloguePending.set(standardId, request);
  return request;
}

/**
 * The catalogue an incident was raised under (its `standard_id`). Null while
 * loading, for legacy rows without a standard, or on error — callers fall
 * back to the BNM constants or the raw code.
 */
export function useStandardCatalogue(standardId: string | null | undefined): StandardCatalogue | null {
  const [fetched, setFetched] = useState<{ id: string; catalogue: StandardCatalogue | null } | null>(null);
  const cached = standardId ? (_catalogueCache.get(standardId) ?? null) : null;

  useEffect(() => {
    if (!standardId || _catalogueCache.has(standardId)) return;
    let cancelled = false;
    void loadStandardCatalogue(createClient(), standardId).then((catalogue) => {
      if (!cancelled) setFetched({ id: standardId, catalogue });
    });
    return () => {
      cancelled = true;
    };
  }, [standardId]);

  if (!standardId) return null;
  return cached ?? (fetched?.id === standardId ? fetched.catalogue : null);
}

// ------------------------------------------------------------------

export interface UseIncidentStandardResult {
  types: IncidentTypeCatalogueEntry[];
  severities: IncidentSeverityLevel[];
  standardId: string | null;
  standardName: string;
  standardSlug: string;
  /** Active frameworks (PDPA, ISO 45001 ...) and the obligation rules they carry. */
  frameworks: IncidentStandard[];
  rules: IncidentObligationRule[];
  loading: boolean;
}

export function useIncidentStandard(): UseIncidentStandardResult {
  const { accountId } = useAuth();
  const [config, setConfig] = useState<IncidentStandardConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!accountId) return;

    const cached = _cache.get(accountId);
    if (cached) {
      setConfig(cached);
      setLoading(false);
      return;
    }

    const supabase = createClient();

    async function load() {
      setLoading(true);
      try {
        const { data: rows, error } = await supabase
          .from("account_incident_standards")
          .select(`standard_id, incident_standards!inner(${STANDARD_COLUMNS})`)
          .eq("account_id", accountId!)
          .eq("is_active", true);

        if (error || !rows) return;

        const active: IncidentStandard[] = [];
        for (const row of rows) {
          // PostgREST returns the joined row as an object; handle both
          const raw = row.incident_standards as unknown;
          const std = (Array.isArray(raw) ? raw[0] : raw) as IncidentStandard | undefined;
          if (std) active.push(std);
        }
        const template = active.find((s) => s.kind === "template");
        if (!template) return;
        const frameworks = active.filter((s) => s.kind === "framework");

        const [catalogue, rulesRes] = await Promise.all([
          loadStandardCatalogue(supabase, template.id),
          frameworks.length
            ? supabase
                .from("incident_obligation_rules")
                .select("*")
                .in("standard_id", frameworks.map((f) => f.id))
                .order("position")
            : Promise.resolve({ data: [] as IncidentObligationRule[] }),
        ]);
        if (!catalogue) return;

        const result: IncidentStandardConfig = {
          standard: template,
          types: catalogue.types,
          severities: catalogue.severities,
          frameworks,
          rules: (rulesRes.data ?? []) as IncidentObligationRule[],
        };

        _cache.set(accountId!, result);
        setConfig(result);
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [accountId]);

  return {
    types: config?.types.length ? config.types : _bnmFallbackTypes,
    severities: config?.severities.length ? config.severities : _bnmFallbackSeverities,
    standardId: config?.standard.id ?? null,
    standardName: config?.standard.name ?? "BNM RMiT",
    standardSlug: config?.standard.slug ?? "bnm_rmit",
    frameworks: config?.frameworks ?? [],
    rules: config?.rules ?? [],
    loading,
  };
}

/** Invalidates the cached config for an account (call after an admin switches template or framework). */
export function invalidateIncidentStandardCache(accountId: string) {
  _cache.delete(accountId);
}
