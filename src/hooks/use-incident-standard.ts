"use client";

// Loads the active incident standard for the current account.
// Falls back to BNM RMiT constants while loading or on error so
// existing views never break during the DB round-trip.

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  INCIDENT_TYPES,
  INCIDENT_SEVERITIES,
  INCIDENT_SEVERITY_LABEL,
  P2_MINIMUM_TYPES,
} from "@/lib/incidents/constants";
import type {
  IncidentStandardConfig,
  IncidentTypeCatalogueEntry,
  IncidentSeverityLevel,
} from "@/lib/incidents/standard-types";

// Module-level cache — avoids re-fetching on hook remount within the
// same session (standard config changes only when an admin switches it).
const _cache = new Map<string, IncidentStandardConfig>();

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

// ------------------------------------------------------------------

export interface UseIncidentStandardResult {
  types: IncidentTypeCatalogueEntry[];
  severities: IncidentSeverityLevel[];
  standardName: string;
  standardSlug: string;
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
        const { data: aisRow, error: aisError } = await supabase
          .from("account_incident_standards")
          .select("standard_id, incident_standards!inner(id, slug, name, regulatory_body, sector, description, is_system, created_at)")
          .eq("account_id", accountId!)
          .eq("is_active", true)
          .limit(1)
          .single();

        if (aisError || !aisRow) return;

        // PostgREST returns the joined row as an object; handle both
        const raw = aisRow.incident_standards;
        const std = Array.isArray(raw) ? raw[0] : raw;
        if (!std) return;

        const [typesRes, sevRes] = await Promise.all([
          supabase
            .from("incident_type_catalogue")
            .select("*")
            .eq("standard_id", std.id)
            .order("position"),
          supabase
            .from("incident_severity_levels")
            .select("*")
            .eq("standard_id", std.id)
            .order("position"),
        ]);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result: IncidentStandardConfig = {
          standard: std as IncidentStandardConfig["standard"],
          types: (typesRes.data ?? []) as IncidentTypeCatalogueEntry[],
          severities: (sevRes.data ?? []) as IncidentSeverityLevel[],
        };

        _cache.set(accountId!, result);
        setConfig(result);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [accountId]);

  return {
    types: config?.types.length ? config.types : _bnmFallbackTypes,
    severities: config?.severities.length ? config.severities : _bnmFallbackSeverities,
    standardName: config?.standard.name ?? "BNM RMiT",
    standardSlug: config?.standard.slug ?? "bnm_rmit",
    loading,
  };
}

/** Invalidates the cached config for an account (call after an admin switches standard). */
export function invalidateIncidentStandardCache(accountId: string) {
  _cache.delete(accountId);
}
