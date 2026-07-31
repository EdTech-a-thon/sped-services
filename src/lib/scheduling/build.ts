import { normalizeKey } from "./parse";
import { formatRange } from "./time";
import {
  DAYS,
  type DayGrid,
  type GridCell,
  type GridSettings,
  type GridSlot,
  type ScheduleResult,
  type SchedulerInput,
} from "./types";

const DEFAULT_START = 7 * 60 + 30; // 7:30 AM
const DEFAULT_END = 15 * 60; // 3:00 PM
const DEFAULT_SLOT = 15;

/**
 * Pick a grid window that covers everything in the workbook, rounded out to the
 * nearest slot boundary. Falls back to a standard 7:30–3:00 school day.
 */
export function defaultSettings(input: SchedulerInput): GridSettings {
  const starts: number[] = [];
  const ends: number[] = [];

  for (const blocks of Object.values(input.classes)) {
    for (const block of blocks) {
      starts.push(block.start);
      ends.push(block.end);
    }
  }
  for (const session of input.services) {
    starts.push(session.start);
    ends.push(session.end);
  }

  if (starts.length === 0) {
    return {
      startMinutes: DEFAULT_START,
      endMinutes: DEFAULT_END,
      slotMinutes: DEFAULT_SLOT,
    };
  }

  const start = Math.min(...starts, DEFAULT_START);
  const end = Math.max(...ends, DEFAULT_END);
  return {
    startMinutes: Math.floor(start / DEFAULT_SLOT) * DEFAULT_SLOT,
    endMinutes: Math.ceil(end / DEFAULT_SLOT) * DEFAULT_SLOT,
    slotMinutes: DEFAULT_SLOT,
  };
}

function buildSlots(settings: GridSettings): GridSlot[] {
  const { startMinutes, endMinutes, slotMinutes } = settings;
  const slots: GridSlot[] = [];
  if (slotMinutes <= 0 || endMinutes <= startMinutes) return slots;

  // Guard against a pathological range producing a runaway grid.
  const maxSlots = 24 * 60;
  for (
    let time = startMinutes;
    time < endMinutes && slots.length < maxSlots;
    time += slotMinutes
  ) {
    const end = Math.min(time + slotMinutes, endMinutes);
    slots.push({ start: time, end, label: formatRange(time, end) });
  }
  return slots;
}

/**
 * Build the five day grids. A cell shows the service a student is already
 * booked into, otherwise whatever their class is doing — coloured by whether
 * that block is a good time to pull them.
 */
export function buildSchedule(
  input: SchedulerInput,
  settings: GridSettings,
): ScheduleResult {
  const slots = buildSlots(settings);

  // Index sessions by day so each cell lookup stays cheap.
  const sessionsByDay = new Map<string, typeof input.services>();
  for (const day of DAYS) sessionsByDay.set(day, []);
  for (const session of input.services) {
    sessionsByDay.get(session.day)?.push(session);
  }

  const studentKeys = input.students.map((student) =>
    normalizeKey(student.name),
  );

  const grids: DayGrid[] = DAYS.map((day) => {
    const sessions = sessionsByDay.get(day) ?? [];

    const rows = slots.map((slot) =>
      input.students.map((student, index): GridCell => {
        const booked = sessions.find(
          (session) =>
            normalizeKey(session.student) === studentKeys[index] &&
            session.start <= slot.start &&
            session.end > slot.start,
        );
        if (booked) return { label: booked.service, status: "booked" };

        const block = (input.classes[student.classKey] ?? []).find(
          (candidate) =>
            candidate.start <= slot.start && candidate.end > slot.start,
        );
        if (!block) return { label: "", status: "empty" };

        return {
          label: block.subject,
          status: block.servicePossible ? "available" : "unavailable",
        };
      }),
    );

    return { day, slots, rows };
  });

  return { students: input.students, settings, grids };
}
