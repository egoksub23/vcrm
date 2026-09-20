"use client";

// The Jira connection and its settings for Settings > Integrations.
//
//   GET   connection        loaded on mount, and again on reload()
//   PATCH connection        patch(): the change shows at once (optimistic),
//                           the server's validated copy replaces it when the
//                           last save lands, and a failed save reloads the
//                           truth and says why in a toast
//   DELETE connection       disconnect(purge)

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { applySettingsPatch } from "@/lib/jira/settings";
import { DEFAULT_JIRA_SETTINGS, type JiraSettings } from "@/lib/jira/types";

import {
  jiraFetch,
  useJiraErrorText,
  type JiraApiError,
  type JiraConnectionPayload,
} from "./jira-api";

/** A partial settings object: sections merge one level deep on the server. */
export type JiraSettingsPatch = {
  [K in keyof JiraSettings]?: JiraSettings[K] extends Record<string, unknown>
    ? Partial<JiraSettings[K]>
    : JiraSettings[K];
};

export interface UseJiraSettings {
  data: JiraConnectionPayload | null;
  settings: JiraSettings;
  loading: boolean;
  loadError: JiraApiError | null;
  saving: boolean;
  reload: () => Promise<void>;
  /** Save part of the settings. `toastOnSuccess` for an explicit Save button. */
  patch: (patch: JiraSettingsPatch, opts?: { toastOnSuccess?: boolean }) => Promise<boolean>;
  disconnect: (purge: boolean) => Promise<boolean>;
}

export function useJiraSettings(): UseJiraSettings {
  const t = useTranslations("Settings.jira");
  const errorText = useJiraErrorText();
  const errorTextRef = useRef(errorText);
  useEffect(() => {
    errorTextRef.current = errorText;
  });

  const [data, setData] = useState<JiraConnectionPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<JiraApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(0);
  const dataRef = useRef<JiraConnectionPayload | null>(null);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const reload = useCallback(async () => {
    const res = await jiraFetch<JiraConnectionPayload>("connection");
    if (res.ok) {
      setData(res.data);
      setLoadError(null);
    } else {
      setLoadError(res.error);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    // The first load: the state it sets is the point of the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const patch = useCallback<UseJiraSettings["patch"]>(
    async (change, opts) => {
      if (!dataRef.current?.connection) return false;
      setData((d) => (d ? { ...d, settings: applySettingsPatch(d.settings, change) } : d));
      inFlight.current += 1;
      setSaving(true);
      const res = await jiraFetch<{ settings: JiraSettings; changed: string[] }>("connection", {
        method: "PATCH",
        body: { settings: change },
      });
      inFlight.current -= 1;
      if (inFlight.current === 0) setSaving(false);
      if (!res.ok) {
        toast.error(`${t("toasts.saveFailed")} ${errorTextRef.current(res.error)}`);
        // Put the screen back to what is really stored.
        await reload();
        return false;
      }
      if (inFlight.current === 0) {
        setData((d) => (d ? { ...d, settings: res.data.settings } : d));
      }
      if (opts?.toastOnSuccess) toast.success(t("toasts.saved"));
      return true;
    },
    [reload, t],
  );

  const disconnect = useCallback<UseJiraSettings["disconnect"]>(
    async (purge) => {
      const res = await jiraFetch<{ ok: boolean }>(`connection${purge ? "?purge=1" : ""}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error(`${t("toasts.disconnectFailed")} ${errorTextRef.current(res.error)}`);
        return false;
      }
      toast.success(t(purge ? "toasts.disconnectedPurged" : "toasts.disconnected"));
      await reload();
      return true;
    },
    [reload, t],
  );

  return {
    data,
    settings: data?.settings ?? DEFAULT_JIRA_SETTINGS,
    loading,
    loadError,
    saving,
    reload,
    patch,
    disconnect,
  };
}
