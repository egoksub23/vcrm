"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { formatDistanceToNowStrict } from "date-fns";
import { Check, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { api } from "@/components/incidents/setup/api";

interface Task {
  id: string;
  incidentId: string;
  reference: string;
  title: string;
  description: string | null;
  roleKey: string | null;
  dueAt: string | null;
  overdue: boolean;
}

/** My tasks: the required steps that belong to the roles I hold. Tick one off here, no need to open the incident. */
export function TasksScreen() {
  const t = useTranslations("IncidentPlatform.tasks");
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ tasks: Task[] }>("/api/incidents/tasks");
    if (res.ok) {
      setTasks(res.data.tasks);
      setError(null);
    } else setError(res.error);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of server data
    void load();
  }, [load]);

  const complete = async (task: Task) => {
    const res = await api(`/api/incidents/${task.incidentId}/obligations`, "PATCH", { oblId: task.id, status: "done" });
    if (!res.ok) return void toast.error(res.error);
    setTasks((cur) => (cur ?? []).filter((x) => x.id !== task.id));
  };

  if (error) return <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!tasks) return <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("loading")} />;

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("help")}</p>
      </header>
      {tasks.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-start gap-3 px-4 py-3">
              <button
                type="button"
                onClick={() => void complete(task)}
                aria-label={t("markDone", { title: task.title })}
                className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border border-border hover:border-emerald-500 hover:bg-emerald-500/10"
              >
                <Check className="size-3.5 opacity-0 hover:opacity-100" />
              </button>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{task.title}</p>
                {task.description ? <p className="mt-0.5 text-xs text-muted-foreground">{task.description}</p> : null}
                <p className="mt-1 text-xs text-muted-foreground">
                  <Link href={`/incidents/${task.incidentId}`} className="font-mono underline-offset-2 hover:underline">{task.reference}</Link>
                  {task.dueAt ? (
                    <span className={cn("ml-2", task.overdue && "font-semibold text-red-600 dark:text-red-400")}>
                      {task.overdue ? t("overdueBy", { time: formatDistanceToNowStrict(new Date(task.dueAt)) }) : t("dueIn", { time: formatDistanceToNowStrict(new Date(task.dueAt)) })}
                    </span>
                  ) : null}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
