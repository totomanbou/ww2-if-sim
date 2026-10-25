export const DAY_MS = 86_400_000;
export const DEFAULT_STEP_DAYS = 3.5;

/** Existing coefficients stay in weeks; a production step is half a week. */
export function stepWeeks(config: { stepDays: number }): number { return config.stepDays / 7; }

/** Convert a weekly occurrence / relaxation probability to the chosen elapsed time. */
export function perStepProbability(weekly: number, weeks: number): number {
  const p = Math.max(0, Math.min(1, weekly));
  if (weeks === 1) return p;
  return -Math.expm1(Math.log1p(-p) * weeks);
}

/** Parses "YYYY-MM-DD" as UTC midnight (ms). */
export function parseDate(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Date (UTC ms) of a tick: 3.5 days by default, preserving the half-day in UTC. */
export function tickTime(startMs: number, tick: number, stepDays = DEFAULT_STEP_DAYS): number {
  return startMs + tick * stepDays * DAY_MS;
}

/** True if 1 September falls in [timeMs, timeMs + spanDays). The engine passes the half-step duration. */
export function weekContainsSept1(timeMs: number, spanDays = 7): boolean {
  const y = new Date(timeMs).getUTCFullYear();
  for (const year of [y, y + 1]) {
    const s = Date.UTC(year, 8, 1);
    if (s >= timeMs && s < timeMs + spanDays * DAY_MS) return true;
  }
  return false;
}
