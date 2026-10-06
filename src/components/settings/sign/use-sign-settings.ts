"use client";

// Loads what the Doc Sign settings screens start from: the settings row (created on first use by the server)
// and the wording of the consent in force per language. Reloading keeps showing the old data until the new
// arrives, so a save never blanks the form.

import { useCallback, useEffect, useState } from "react";

import { signRequest } from "@/lib/sign/client/api";
import type { SignLocale, SignSettingsRow } from "@/lib/sign/types";

export interface ConsentInfo {
  text: string;
  custom: boolean;
  version: string;
}

export interface SignSettingsData {
  settings: SignSettingsRow;
  consent: Record<SignLocale, ConsentInfo>;
  consentDefaults: Record<SignLocale, ConsentInfo>;
}

type State = { status: "loading" } | { status: "error"; error: unknown } | { status: "ready"; data: SignSettingsData };

export function useSignSettings() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    signRequest<SignSettingsData>("/api/sign/settings")
      .then((data) => {
        if (live) setState({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (live) setState({ status: "error", error });
      });
    return () => {
      live = false;
    };
  }, [round]);

  const reload = useCallback(() => setRound((n) => n + 1), []);
  /** Put a row the browser just wrote into the screen without waiting for the reload. */
  const replaceSettings = useCallback((settings: SignSettingsRow) => {
    setState((s) => (s.status === "ready" ? { status: "ready", data: { ...s.data, settings } } : s));
  }, []);

  return { state, reload, replaceSettings };
}
