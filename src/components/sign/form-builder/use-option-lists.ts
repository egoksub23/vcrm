"use client";

// The workspace's option lists for the form builder: which exist (so a field can name one and a missing one is reported), and
// the items of one (a preview, and the options a field gets when it names the list). The summaries are shared by every
// field of the screen and kept for half a minute, so selecting a field never asks the server again.

import { useEffect, useState } from "react";

import { loadList, loadLists } from "@/lib/sign/client/lists-api";
import type { ListItem, OptionListSummary } from "@/lib/sign/lists/types";

type State = { status: "loading" } | { status: "error" } | { status: "ready"; lists: OptionListSummary[] };

let cache: { at: number; promise: Promise<OptionListSummary[]> } | null = null;
const FRESH_MS = 30_000;

function shared(): Promise<OptionListSummary[]> {
  if (!cache || Date.now() - cache.at > FRESH_MS) {
    const promise = loadLists();
    cache = { at: Date.now(), promise };
    promise.catch(() => {
      if (cache?.promise === promise) cache = null;
    });
  }
  return cache.promise;
}

/** Forget what was read (after a list was made or changed in this session). */
export const forgetOptionLists = (): void => {
  cache = null;
};

export function useOptionLists(): State {
  const [state, setState] = useState<State>({ status: "loading" });
  useEffect(() => {
    let live = true;
    shared()
      .then((lists) => live && setState({ status: "ready", lists }))
      .catch(() => live && setState({ status: "error" }));
    return () => {
      live = false;
    };
  }, []);
  return state;
}

type Items = { status: "idle" | "loading" | "error" } | { status: "ready"; items: ListItem[]; version: number };

/** The items of one list; idle while `key` is empty. */
export function useListItems(key: string | undefined): Items {
  const [state, setState] = useState<{ key: string; value: Items } | null>(null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    loadList(key)
      .then((r) => live && setState({ key, value: { status: "ready", items: r.list.items, version: r.list.version } }))
      .catch(() => live && setState({ key, value: { status: "error" } }));
    return () => {
      live = false;
    };
  }, [key]);
  if (!key) return { status: "idle" };
  return state && state.key === key ? state.value : { status: "loading" };
}
