import { addDays } from "./dates.ts";

export interface MemberStatus {
  id: string;
  fullName: string;
  phone: string | null;
  /** Last day of the current subscription, null if they never paid. */
  endDate: string | null;
}

/** The idempotency key stored with each notification: one reminder per member per subscription period. */
export function reminderKey(member: Pick<MemberStatus, "id" | "endDate">): string {
  return `${member.id}:expiring:${member.endDate}`;
}

/**
 * Members who should get the "your subscription ends soon" message today:
 * their subscription ends within `daysBefore` days (today included), they have a phone,
 * and we have not already reminded them for THIS period.
 *
 * Using a window instead of "exactly 2 days before" means a missed cron run (server down,
 * deploy) still sends the reminder the next day instead of silently skipping it.
 */
export function dueForExpiryReminder(
  members: MemberStatus[],
  today: string,
  alreadySent: ReadonlySet<string>,
  daysBefore = 2,
): MemberStatus[] {
  const last = addDays(today, daysBefore);
  return members.filter(
    (m) =>
      m.endDate !== null &&
      m.phone !== null &&
      m.phone.trim() !== "" &&
      m.endDate >= today &&
      m.endDate <= last &&
      !alreadySent.has(reminderKey(m)),
  );
}

/**
 * When the gym is closed on `closedOn`, everyone whose subscription covers that day gets
 * `days` extra days so a closed day does not cost them a paid day.
 */
export function closureExtensions(
  members: MemberStatus[],
  closedOn: string,
  days = 1,
): Array<{ memberId: string; newEndDate: string }> {
  return members
    .filter((m) => m.endDate !== null && m.endDate >= closedOn)
    .map((m) => ({ memberId: m.id, newEndDate: addDays(m.endDate as string, days) }));
}
