"use client";

import { useEffect, useState } from "react";
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

const _cache = new Map<string, IncidentStandardConfig>();
const _catalogueCache = new Map<string, StandardCatalogue>();
const _cataloguePending = new Map<string, Promise<StandardCatalogue | null>>();

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

export function loadStandardCatalogue(
  standardId: string,
): Promise<StandardCatalogue | null> {
  const hit = _catalogueCache.get(standardId);
  if (hit) return Promise.resolve(hit);
  const pending = _cataloguePending.get(standardId);
  if (pending) return pending;

  const request = (async () => {
    try {
      const res = await fetch(`/api/account/incident-catalogue/${standardId}`);
      const { catalogue } = (await res.json()) as { catalogue?: StandardCatalogue | null };
      if (!catalogue) return null;
      _catalogueCache.set(standardId, catalogue);
      return catalogue;
    } catch {
      return null;
    } finally {
      _cataloguePending.delete(standardId);
    }
  })();
  _cataloguePending.set(standardId, request);
  return request;
}

export function useStandardCatalogue(standardId: string | null | undefined): StandardCatalogue | null {
  const [fetched, setFetched] = useState<{ id: string; catalogue: StandardCatalogue | null } | null>(null);
  const cached = standardId ? (_catalogueCache.get(standardId) ?? null) : null;

  useEffect(() => {
    if (!standardId || _catalogueCache.has(standardId)) return;
    let cancelled = false;
    void loadStandardCatalogue(standardId).then((catalogue) => {
      if (!cancelled) setFetched({ id: standardId, catalogue });
    });
    return () => {
      cancelled = true;
    };
  }, [standardId]);

  if (!standardId) return null;
  return cached ?? (fetched?.id === standardId ? fetched.catalogue : null);
}

export interface UseIncidentStandardResult {
  types: IncidentTypeCatalogueEntry[];
  severities: IncidentSeverityLevel[];
  standardId: string | null;
  standardName: string;
  standardSlug: string;
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

    setLoading(true);
    fetch("/api/account/incident-standard")
      .then((r) => r.json())
      .then(({ config: result }: { config?: IncidentStandardConfig | null }) => {
        if (!result) return;
        _cache.set(accountId, result);
        setConfig(result);
      })
      .catch(() => {/* ignore */})
      .finally(() => setLoading(false));
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

export function invalidateIncidentStandardCache(accountId: string) {
  _cache.delete(accountId);
}
