// One scheduled job's last-run summary, as the operator console shows it
// (GET /api/platform/cron). Kept out of the route file: a route module may
// only export HTTP handlers.
export interface CronJobStatus {
  job: string
  expected_seconds: number
  /** null = the job has never reported. */
  last_run_at: string | null
  last_ok_at: string | null
  last_status: 'ok' | 'error' | null
  last_duration_ms: number | null
  last_result: Record<string, unknown> | null
  /** Not seen for three expected intervals (or never). */
  late: boolean
}
