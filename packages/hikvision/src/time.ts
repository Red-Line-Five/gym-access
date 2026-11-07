const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Format the device wants for Valid.beginTime / Valid.endTime (device local time). */
export const DEVICE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

function assertDate(date: string): void {
  if (!DATE_RE.test(date)) throw new RangeError(`Expected YYYY-MM-DD, got "${date}"`);
}

/** "2026-11-07" -> "2026-11-07T00:00:00" */
export function dayStart(date: string): string {
  assertDate(date);
  return `${date}T00:00:00`;
}

/** "2026-12-06" -> "2026-12-06T23:59:59" (a subscription ends at the END of its last day) */
export function dayEnd(date: string): string {
  assertDate(date);
  return `${date}T23:59:59`;
}
