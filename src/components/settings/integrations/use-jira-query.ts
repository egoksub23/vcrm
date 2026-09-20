"use client";

// A small GET loader for the Jira tabs: loads on mount and whenever the path
// changes (null = do not load), keeps the last answer while a manual reload
// runs, and never polls.

import { useCallback, useEffect, useRef, useState } from "react";

import { jiraFetch, type JiraApiError } from "./jira-api";

interface Answer<T> {
  path: string;
  data: T | null;
  error: JiraApiError | null;
}

export interface JiraQuery<T> {
  data: T | null;
  error: JiraApiError | null;
  /** True until the first answer for this path. */
  loading: boolean;
  /** True while a manual reload() runs. */
  refreshing: boolean;
  reload: () => Promise<void>;
}

export function useJiraQuery<T>(path: string | null): JiraQuery<T> {
  const [answer, setAnswer] = useState<Answer<T> | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const pathRef = useRef(path);
  useEffect(() => {
    pathRef.current = path;
  }, [path]);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    void jiraFetch<T>(path).then((res) => {
      if (cancelled) return;
      setAnswer(res.ok ? { path, data: res.data, error: null } : { path, data: null, error: res.error });
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const reload = useCallback(async () => {
    const p = pathRef.current;
    if (!p) return;
    setRefreshing(true);
    const res = await jiraFetch<T>(p);
    // Ignore an answer for a path the screen has moved on from.
    if (pathRef.current === p) {
      setAnswer(res.ok ? { path: p, data: res.data, error: null } : { path: p, data: null, error: res.error });
    }
    setRefreshing(false);
  }, []);

  // An answer for another path is not this path's answer.
  const current = answer && answer.path === path ? answer : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    loading: !!path && current === null,
    refreshing,
    reload,
  };
}
