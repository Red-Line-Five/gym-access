/** All dates in this app are calendar dates in the gym's own timezone, as "YYYY-MM-DD" strings. */

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function parse(iso: string): { y: number; m: number; d: number } {
  const match = ISO.exec(iso);
  if (!match) throw new RangeError(`Expected YYYY-MM-DD, got "${iso}"`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new RangeError(`"${iso}" is not a real date`);
  }
  return { y, m, d };
}

function format(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function addDays(iso: string, days: number): string {
  const { y, m, d } = parse(iso);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return format(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Month arithmetic that clamps to the end of short months: Jan 31 + 1 month = Feb 28 (or 29). */
export function addMonths(iso: string, months: number): string {
  const { y, m, d } = parse(iso);
  const total = m - 1 + months;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const daysInMonth = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return format(ny, nm + 1, Math.min(d, daysInMonth));
}

/** Today's calendar date in the given IANA timezone, e.g. todayIn("Asia/Beirut"). */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** "2026-12-06" -> "06/12/2026", the way members read dates in the messages. */
export function formatDMY(iso: string): string {
  const { y, m, d } = parse(iso);
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
}

export interface Period {
  start: string;
  end: string;
}

/**
 * The period a payment buys.
 *  - Paying while still active (or on the last day): the new period starts the day AFTER the
 *    current end, so nobody loses days by paying early.
 *  - Paying after expiry (or the first time): it starts on the payment date.
 * The end date is INCLUSIVE: 1 month from 07/11 ends 06/12 (the door works until 23:59:59 that day).
 */
export function nextPeriod(currentEnd: string | null, paidOn: string, months = 1): Period {
  parse(paidOn);
  const start = currentEnd !== null && currentEnd >= paidOn ? addDays(currentEnd, 1) : paidOn;
  return { start, end: addDays(addMonths(start, months), -1) };
}
