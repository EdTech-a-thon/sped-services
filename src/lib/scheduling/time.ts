/**
 * Time helpers. Everything in the scheduler is "minutes after midnight" so the
 * grid never has to think about dates or time zones.
 */

const TEXT_TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]\.?M\.?)?$/i;

/**
 * Convert a spreadsheet cell into minutes after midnight, or `null` if the cell
 * does not hold a time.
 *
 * Cells reach us in three shapes: a `Date` (ExcelJS decodes time-formatted
 * cells against the 1899-12-30 epoch in UTC), a raw serial number (fraction of
 * a day), or free text a teacher typed such as "7:30 AM".
 */
export function toMinutes(value: unknown): number | null {
  if (value == null || value === "") return null;

  if (value instanceof Date) {
    return value.getUTCHours() * 60 + value.getUTCMinutes();
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // Excel serial: the fractional part is the time of day.
    const dayFraction = value - Math.floor(value);
    return Math.round(dayFraction * 24 * 60);
  }

  const match = String(value).trim().match(TEXT_TIME);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[4]?.replace(/\./g, "").toUpperCase();
  if (minutes > 59) return null;
  if (meridiem === "PM" && hours !== 12) hours += 12;
  if (meridiem === "AM" && hours === 12) hours = 0;
  if (hours > 23) return null;

  return hours * 60 + minutes;
}

/** 450 -> "7:30 AM" */
export function formatTime(minutes: number): string {
  const meridiem = minutes % (24 * 60) >= 12 * 60 ? "PM" : "AM";
  const hours = Math.floor(minutes / 60) % 12 || 12;
  return `${hours}:${String(minutes % 60).padStart(2, "0")} ${meridiem}`;
}

/** 450, 465 -> "7:30 AM - 7:45 AM" */
export function formatRange(start: number, end: number): string {
  return `${formatTime(start)} - ${formatTime(end)}`;
}

/** 450 -> "07:30", for `<input type="time">`. */
export function toTimeInput(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** "07:30" -> 450 */
export function fromTimeInput(value: string): number | null {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
