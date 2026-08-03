import type { Worksheet } from "exceljs";
import { toMinutes } from "./time";
import { readRuleOverrides } from "./rules";
import {
  DAYS,
  emptyClassSchedule,
  type ClassSchedule,
  type DeliveryModel,
  type GroupType,
  type SchedulerInput,
  type ServiceDefinition,
  type ServiceMatch,
  type ServiceRequirement,
  type ServiceSession,
  type StaffMember,
  type Student,
} from "./types";

/**
 * The "<Day> Grid" sheets are our output: never read as input, replaced on
 * export, and stripped from the blank template.
 */
export function isGeneratedSheet(name: string): boolean {
  return /\bgrid$/i.test(name.trim());
}

/**
 * Collapse a label to letters and digits so "K: Cave" (Students sheet) lines up
 * with "K Cave" (the tab name Excel produced when the colon was stripped).
 */
export function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Unwrap the shapes ExcelJS uses for cell values into a plain value. */
function cellValue(sheet: Worksheet, row: number, col: number): unknown {
  const value = sheet.getRow(row).getCell(col).value;
  if (value == null) return null;
  if (typeof value === "object" && !(value instanceof Date)) {
    const object = value as unknown as Record<string, unknown>;
    if ("result" in object) return object.result;
    if ("richText" in object) {
      const parts = object.richText as { text?: string }[];
      return parts.map((part) => part.text ?? "").join("");
    }
    if ("text" in object) return object.text;
    if ("error" in object) return null;
  }
  return value;
}

function cellText(sheet: Worksheet, row: number, col: number): string {
  const value = cellValue(sheet, row, col);
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function isTruthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return /^(true|yes|y|x|1)$/i.test(String(value ?? "").trim());
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** "Panzer, Stone" -> ["Panzer", "Stone"]. Also splits multi-student cells. */
function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Map normalized header text -> column index for the given header row. */
export function headerColumns(
  sheet: Worksheet,
  row: number,
): Map<string, number> {
  const columns = new Map<string, number>();
  for (let col = 1; col <= Math.max(sheet.columnCount, 1); col++) {
    const key = normalizeKey(cellText(sheet, row, col));
    if (key && !columns.has(key)) columns.set(key, col);
  }
  return columns;
}

export function findColumn(
  columns: Map<string, number>,
  names: string[],
  fallback: number,
): number {
  for (const name of names) {
    const col = columns.get(normalizeKey(name));
    if (col != null) return col;
  }
  return fallback;
}

function optionalColumn(
  columns: Map<string, number>,
  names: string[],
): number | null {
  for (const name of names) {
    const col = columns.get(normalizeKey(name));
    if (col != null) return col;
  }
  return null;
}

/* ---------- subject list tokenizing ---------- */

/**
 * Split a Service Matches subject list.
 *
 * Splitting on "," is wrong: one of the real subjects is literally
 * "SEL, Reading, or Math Facts", and the sheet only quotes it some of the time.
 * Instead, match known subject names against the text longest-first and claim
 * the characters each one consumes, so a long name always wins over the short
 * names nested inside it.
 */
export function tokenizeSubjects(text: string, subjects: string[]): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const haystack = trimmed.toLowerCase();
  const claimed = new Array<boolean>(haystack.length).fill(false);
  const found: { at: number; subject: string }[] = [];

  for (const subject of [...subjects].sort((a, b) => b.length - a.length)) {
    const needle = subject.toLowerCase();
    if (!needle) continue;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      from = at + 1;
      let free = true;
      for (let i = at; i < at + needle.length; i++) {
        if (claimed[i]) {
          free = false;
          break;
        }
      }
      if (!free) continue;
      for (let i = at; i < at + needle.length; i++) claimed[i] = true;
      found.push({ at, subject });
    }
  }

  return found.sort((a, b) => a.at - b.at).map((entry) => entry.subject);
}

/** Anything the tokenizer could not account for, ignoring list punctuation. */
function unmatchedSubjectText(text: string, matched: string[]): string {
  let rest = text;
  for (const subject of [...matched].sort((a, b) => b.length - a.length)) {
    rest = rest.replace(subject, " ");
  }
  return rest.replace(/["',;]/g, " ").trim();
}

/* ---------- readers ---------- */

/** "K Cave" -> 0, "3 Harris" -> 3, "K: Cave" -> 0. */
function parseGrade(className: string): number | null {
  const match = className.match(/^\s*(K|\d{1,2})\b/i);
  if (!match) return null;
  return /^k$/i.test(match[1]) ? 0 : Number(match[1]);
}

function readStudents(sheet: Worksheet, warnings: string[]): Student[] {
  const columns = headerColumns(sheet, 1);
  const nameCol = findColumn(columns, ["Student", "Name", "Student Name"], 1);
  const classCol = findColumn(columns, ["Class", "Classroom", "Teacher"], 2);

  const students: Student[] = [];
  const seen = new Set<string>();

  for (let row = 2; row <= sheet.rowCount; row++) {
    const name = cellText(sheet, row, nameCol);
    if (!name) continue;

    const key = normalizeKey(name);
    if (seen.has(key)) {
      warnings.push(
        `"${name}" is listed more than once on the Students sheet.`,
      );
      continue;
    }
    seen.add(key);

    const className = cellText(sheet, row, classCol);
    if (!className) {
      warnings.push(`"${name}" has no class listed on the Students sheet.`);
    }
    students.push({
      name,
      className,
      classKey: normalizeKey(className),
      grade: parseGrade(className),
    });
  }

  return students;
}

/**
 * Class sheets put the header on row 1 or row 2 depending on how the template
 * was last edited, so find it rather than assuming.
 */
export function findClassHeaderRow(sheet: Worksheet): number {
  const limit = Math.min(sheet.rowCount, 4);
  for (let row = 1; row <= limit; row++) {
    if (headerColumns(sheet, row).has("starttime")) return row;
  }
  return 1;
}

// Thursday repeats Tuesday's "T", so day headers have to be matched
// positionally — a keyed lookup would collapse the two.
const DAY_HEADER_ALIASES: string[][] = [
  ["m", "mon", "monday"],
  ["t", "tu", "tue", "tues", "tuesday"],
  ["w", "wed", "weds", "wednesday"],
  ["t", "th", "thu", "thur", "thurs", "thursday", "r"],
  ["f", "fri", "friday"],
];

/**
 * Newer class sheets replace the single Subject column with five day columns
 * (M T W T F). Find that run, or null when the sheet uses the old layout.
 */
export function findDayColumns(
  sheet: Worksheet,
  headerRow: number,
): number[] | null {
  const last = Math.max(sheet.columnCount, 1);
  for (let start = 1; start + 4 <= last; start++) {
    const columns: number[] = [];
    for (let index = 0; index < DAYS.length; index++) {
      const key = normalizeKey(cellText(sheet, headerRow, start + index));
      if (!DAY_HEADER_ALIASES[index].includes(key)) break;
      columns.push(start + index);
    }
    if (columns.length === DAYS.length) return columns;
  }
  return null;
}

/**
 * The old template's tri-state "Service Possible" column. Newer workbooks have
 * no such column and decide eligibility from Service Matches, so `null` means
 * "this sheet does not say".
 */
function readServicePossible(value: unknown): boolean | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/^never$/i.test(text)) return false;
  if (/^always$/i.test(text)) return true;
  if (/^some/i.test(text)) return true;
  return isTruthy(value);
}

function readClassSchedule(
  sheet: Worksheet,
  warnings: string[],
): ClassSchedule {
  const headerRow = findClassHeaderRow(sheet);
  const columns = headerColumns(sheet, headerRow);
  const startCol = findColumn(columns, ["Start Time", "Start"], 1);
  const endCol = findColumn(columns, ["End Time", "End"], 2);
  const dayCols = findDayColumns(sheet, headerRow);
  const subjectCol = findColumn(columns, ["Subject", "Activity", "Block"], 4);
  const possibleCol = optionalColumn(columns, [
    "Service Possible",
    "Can Pull",
    "Pull OK",
  ]);

  const schedule = emptyClassSchedule();

  for (let row = headerRow + 1; row <= sheet.rowCount; row++) {
    // ExcelJS reports the master's value for every cell of a merged range, so a
    // subject merged across M:F already reads back on all five days.
    const subjects = dayCols
      ? dayCols.map((col) => cellText(sheet, row, col))
      : DAYS.map(() => cellText(sheet, row, subjectCol));

    const start = toMinutes(cellValue(sheet, row, startCol));
    const end = toMinutes(cellValue(sheet, row, endCol));
    if (start == null || end == null) {
      // Blank spacer rows are normal; only complain when there was content.
      const named = subjects.find(Boolean);
      if (named) {
        warnings.push(
          `${sheet.name} row ${row} ("${named}") is missing a start or end time.`,
        );
      }
      continue;
    }
    if (end <= start) {
      warnings.push(
        `${sheet.name} row ${row} ends before it starts and was skipped.`,
      );
      continue;
    }

    const servicePossible =
      possibleCol == null
        ? null
        : readServicePossible(cellValue(sheet, row, possibleCol));

    subjects.forEach((subject, index) => {
      if (!subject) return;
      schedule[DAYS[index]].push({
        day: DAYS[index],
        start,
        end,
        subject,
        servicePossible,
      });
    });
  }

  for (const day of DAYS) schedule[day].sort((a, b) => a.start - b.start);
  return schedule;
}

/**
 * Service sheets (OT, PT, Resource, ...) lay day columns side by side: a merged
 * day name, then a Start Time / End Time / Student trio underneath. Locate that
 * header row so we can accept any number of days in any column order.
 */
export function findServiceHeaderRow(sheet: Worksheet): number | null {
  const limit = Math.min(sheet.rowCount, 5);
  for (let row = 2; row <= limit; row++) {
    const columns = headerColumns(sheet, row);
    if (!columns.has("starttime") || !columns.has("student")) continue;
    const dayRow = headerColumns(sheet, row - 1);
    if (DAYS.some((day) => dayRow.has(normalizeKey(day)))) return row;
  }
  return null;
}

function readServiceSheet(
  sheet: Worksheet,
  warnings: string[],
  headerRow: number,
): ServiceSession[] {
  const sessions: ServiceSession[] = [];

  for (let col = 1; col <= sheet.columnCount; col++) {
    if (normalizeKey(cellText(sheet, headerRow, col)) !== "starttime") continue;

    const endCol = col + 1;
    const studentCol = col + 2;
    if (normalizeKey(cellText(sheet, headerRow, studentCol)) !== "student") {
      warnings.push(
        `${sheet.name}: the columns at ${col} are not laid out as Start Time / End Time / Student and were skipped.`,
      );
      continue;
    }

    // The day name sits in a merged cell above the trio; ExcelJS repeats a
    // merged value across the span, so reading directly above works.
    const dayLabel = normalizeKey(cellText(sheet, headerRow - 1, col));
    const day = DAYS.find((candidate) => normalizeKey(candidate) === dayLabel);
    if (!day) {
      warnings.push(
        `${sheet.name}: a column group has no weekday heading and was skipped.`,
      );
      continue;
    }

    for (let row = headerRow + 1; row <= sheet.rowCount; row++) {
      const cell = cellText(sheet, row, studentCol);
      const start = toMinutes(cellValue(sheet, row, col));
      const end = toMinutes(cellValue(sheet, row, endCol));
      if (!cell && start == null && end == null) continue;
      if (!cell || start == null || end == null) {
        warnings.push(
          `${sheet.name} (${day}) row ${row} is incomplete and was skipped.`,
        );
        continue;
      }
      // One slot can hold a whole group: "Alex, Indy, Kate, Caroline".
      for (const student of splitList(cell)) {
        sessions.push({ day, start, end, student, service: sheet.name.trim() });
      }
    }
  }

  return sessions;
}

function readSubjects(sheet: Worksheet): string[] {
  const columns = headerColumns(sheet, 1);
  const nameCol = findColumn(columns, ["Subject", "Name"], 1);
  const subjects: string[] = [];
  const seen = new Set<string>();
  for (let row = 2; row <= sheet.rowCount; row++) {
    const name = cellText(sheet, row, nameCol);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    subjects.push(name);
  }
  return subjects;
}

function readStaff(sheet: Worksheet): StaffMember[] {
  const columns = headerColumns(sheet, 1);
  const nameCol = findColumn(columns, ["Staff", "Name"], 1);
  const roleCol = findColumn(columns, ["Role"], 2);
  const typeCol = findColumn(columns, ["Provider Type"], 3);
  const gradesCol = findColumn(columns, ["Preferred Grade(s)", "Grades"], 4);
  const startCol = findColumn(
    columns,
    ["Start Time - Monday", "Start Time", "Start"],
    5,
  );
  // The sheet heads both time columns "Start Time - Monday"; the second one is
  // really the end time, so take the column immediately after the start.
  const endCol =
    optionalColumn(columns, ["End Time - Monday", "End Time"]) ?? startCol + 1;
  const lunchCol = findColumn(columns, ["Lunch"], 7);
  const breakCol = findColumn(columns, ["Break"], 8);

  const staff: StaffMember[] = [];
  for (let row = 2; row <= sheet.rowCount; row++) {
    const name = cellText(sheet, row, nameCol);
    if (!name) continue;

    const startMinutes = toMinutes(cellValue(sheet, row, startCol));
    let endMinutes = toMinutes(cellValue(sheet, row, endCol));
    // End times are typed bare ("3:00"), which reads as 3 AM. A day that ends
    // before it starts is always an afternoon finish.
    if (
      endMinutes != null &&
      startMinutes != null &&
      endMinutes <= startMinutes
    ) {
      endMinutes += 12 * 60;
    }

    staff.push({
      name,
      role: cellText(sheet, row, roleCol),
      providerType: cellText(sheet, row, typeCol),
      preferredGrades: cellText(sheet, row, gradesCol),
      startMinutes,
      endMinutes,
      lunchMinutes: toNumber(cellValue(sheet, row, lunchCol)),
      breakMinutes: toNumber(cellValue(sheet, row, breakCol)),
    });
  }
  return staff;
}

function readModel(value: string): DeliveryModel {
  return /push/i.test(value) ? "Push-In" : "Pull-Out";
}

function readMinutes(
  sheet: Worksheet,
  warnings: string[],
): ServiceRequirement[] {
  const columns = headerColumns(sheet, 1);
  const studentCol = findColumn(columns, ["Student"], 1);
  const serviceCol = findColumn(columns, ["Service"], 2);
  const weekCol = findColumn(columns, ["Minutes/Week", "Minutes Per Week"], 3);
  const lengthCol = findColumn(
    columns,
    ["Session Length/ Minutes", "Session Length"],
    4,
  );
  const countCol = findColumn(
    columns,
    ["Sessions Needed/Week", "Sessions Needed"],
    5,
  );
  const providerCol = findColumn(columns, ["Provider(s)", "Provider"], 6);
  const paraLeadCol = findColumn(columns, ["Can Para Lead?"], 7);
  const paraSupportCol = findColumn(columns, ["Para Supports"], 8);
  const modelCol = findColumn(columns, ["Service Model"], 9);
  const groupCol = findColumn(columns, ["Group Type"], 10);
  const combineCol = findColumn(columns, ["Can Combine?"], 11);

  const requirements: ServiceRequirement[] = [];
  for (let row = 2; row <= sheet.rowCount; row++) {
    const student = cellText(sheet, row, studentCol);
    const service = cellText(sheet, row, serviceCol);
    if (!student && !service) continue;
    if (!student || !service) {
      warnings.push(`Minutes row ${row} is missing a student or a service.`);
      continue;
    }

    const sessionLength = toNumber(cellValue(sheet, row, lengthCol));
    const sessionsPerWeek = toNumber(cellValue(sheet, row, countCol));
    if (!sessionLength || !sessionsPerWeek) {
      warnings.push(
        `Minutes row ${row} (${student} / ${service}) has no session length or session count, so it cannot be scheduled.`,
      );
      continue;
    }

    const groupType = cellText(sheet, row, groupCol);
    requirements.push({
      student,
      service,
      minutesPerWeek: toNumber(cellValue(sheet, row, weekCol)) ?? 0,
      sessionLength,
      sessionsPerWeek,
      providers: splitList(cellText(sheet, row, providerCol)),
      canParaLead: isTruthy(cellValue(sheet, row, paraLeadCol)),
      paraSupports: isTruthy(cellValue(sheet, row, paraSupportCol)),
      model: readModel(cellText(sheet, row, modelCol)),
      groupType: (/whole/i.test(groupType)
        ? "Whole Group"
        : "Small Group") as GroupType,
      canCombine: isTruthy(cellValue(sheet, row, combineCol)),
    });
  }
  return requirements;
}

function readServiceMatches(
  sheet: Worksheet,
  subjects: string[],
  warnings: string[],
): ServiceMatch[] {
  const columns = headerColumns(sheet, 1);
  const serviceCol = findColumn(columns, ["Service"], 1);
  const modelCol = findColumn(columns, ["Delivery Model"], 2);
  const subjectCol = findColumn(columns, ["Subjects", "Subject"], 3);

  const matches: ServiceMatch[] = [];
  for (let row = 2; row <= sheet.rowCount; row++) {
    const service = cellText(sheet, row, serviceCol);
    if (!service) continue;

    const raw = cellText(sheet, row, subjectCol);
    const matched = tokenizeSubjects(raw, subjects);
    const leftover = unmatchedSubjectText(raw, matched);
    if (leftover) {
      warnings.push(
        `${sheet.name} row ${row} (${service}) lists "${leftover}", which is not on the Subject sheet.`,
      );
    }
    const model = readModel(cellText(sheet, row, modelCol));
    if (!matched.length) {
      // Name the model: a service usually has one row per model, and saying
      // which one is empty is the difference between an actionable warning and
      // the same sentence twice.
      warnings.push(
        `${service} (${model}) has no subjects listed on Service Matches, so it can never be scheduled that way.`,
      );
    }

    matches.push({ service, model, subjects: matched });
  }
  return matches;
}

function readServiceDefinitions(sheet: Worksheet): ServiceDefinition[] {
  const columns = headerColumns(sheet, 1);
  const serviceCol = findColumn(columns, ["Service"], 1);
  const parentCol = findColumn(columns, ["Parent Service"], 2);
  const locationCol = findColumn(columns, ["Location"], 3);
  const certCol = findColumn(columns, ["Requires Certified Teacher?"], 4);
  const paraNeededCol = findColumn(columns, ["Para Needed?"], 5);
  const paraDeliverCol = findColumn(columns, ["Para Can Deliver?"], 6);
  const pullCol = findColumn(columns, ["Pull-Out"], 7);
  const pushCol = findColumn(columns, ["Push-In"], 8);
  const coTeachCol = findColumn(columns, ["Co-Teach Classroom Required?"], 9);

  const definitions: ServiceDefinition[] = [];
  for (let row = 2; row <= sheet.rowCount; row++) {
    const service = cellText(sheet, row, serviceCol);
    if (!service) continue;
    definitions.push({
      service,
      parentService: cellText(sheet, row, parentCol) || service,
      location: cellText(sheet, row, locationCol),
      requiresCertifiedTeacher: isTruthy(cellValue(sheet, row, certCol)),
      paraNeeded: isTruthy(cellValue(sheet, row, paraNeededCol)),
      paraCanDeliver: isTruthy(cellValue(sheet, row, paraDeliverCol)),
      pullOut: isTruthy(cellValue(sheet, row, pullCol)),
      pushIn: isTruthy(cellValue(sheet, row, pushCol)),
      coTeachClassroomRequired: isTruthy(cellValue(sheet, row, coTeachCol)),
    });
  }
  return definitions;
}

/* ---------- entry point ---------- */

/** A problem worth showing to a teacher verbatim, unlike a library stack trace. */
export class WorkbookError extends Error {}

// The library ships as a CommonJS export, so its shape comes from the import
// itself rather than from `typeof import("exceljs")`.
async function importExcelJS() {
  return (await import("exceljs")).default;
}

type ExcelJS = Awaited<ReturnType<typeof importExcelJS>>;

let excelJS: Promise<ExcelJS> | null = null;

/**
 * ExcelJS is big, so it ships as its own chunk rather than blocking the page.
 * The schedule page starts this download as soon as it opens and the service
 * worker keeps the chunk cached, so dropping a workbook after the wifi has gone
 * still reaches the parser. If it genuinely never arrived, say so plainly
 * instead of letting it surface as "that file could not be read".
 */
export function loadExcelJS(): Promise<ExcelJS> {
  excelJS ??= importExcelJS().catch(() => {
    excelJS = null; // Let a later attempt retry once there is a connection.
    throw new WorkbookError(
      "The spreadsheet reader has not finished downloading, so this workbook could not be opened. Connect to the internet once and reload this page — after that it keeps working offline.",
    );
  });
  return excelJS;
}

export async function parseWorkbook(
  file: File | Blob,
  fileName: string,
): Promise<SchedulerInput> {
  const ExcelJS = await loadExcelJS();
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(await file.arrayBuffer());
  } catch {
    throw new WorkbookError(
      "This file could not be opened as an Excel workbook. Make sure it was saved as .xlsx and is not password protected.",
    );
  }

  const warnings: string[] = [];
  const byKey = new Map(
    workbook.worksheets.map((sheet) => [normalizeKey(sheet.name), sheet]),
  );

  const studentSheet = byKey.get("students");
  if (!studentSheet) {
    throw new WorkbookError(
      'This workbook has no "Students" sheet. It needs one sheet named Students listing each student and their class.',
    );
  }

  const students = readStudents(studentSheet, warnings);
  if (students.length === 0) {
    throw new WorkbookError(
      "No students were found on the Students sheet. Check that the first row is a header row with Student and Class columns.",
    );
  }

  // Class schedules: one sheet per distinct class named on the Students sheet.
  const classes: Record<string, ClassSchedule> = {};
  const classSheetNames: Record<string, string> = {};
  const consumed = new Set<string>(["students"]);

  for (const student of students) {
    if (!student.classKey || student.classKey in classes) continue;
    const sheet = byKey.get(student.classKey);
    if (!sheet) {
      warnings.push(
        `No schedule sheet found for class "${student.className}". Those students will show as unscheduled.`,
      );
      classes[student.classKey] = emptyClassSchedule();
      continue;
    }
    consumed.add(student.classKey);
    classSheetNames[student.classKey] = sheet.name;
    classes[student.classKey] = readClassSchedule(sheet, warnings);
  }

  // Reference sheets. Each is optional: a workbook without them still opens as
  // a plain availability grid, it just cannot be planned.
  const subjectSheet = byKey.get("subject");
  const subjects = subjectSheet ? readSubjects(subjectSheet) : [];
  const staffSheet = byKey.get("staff");
  const staff = staffSheet ? readStaff(staffSheet) : [];
  const minutesSheet = byKey.get("minutes");
  const requirements = minutesSheet ? readMinutes(minutesSheet, warnings) : [];
  // Service Matches may be split across several sheets — the workbook keeps
  // speech services on their own "Service Matches - Speech" tab — so take every
  // sheet whose name starts that way and read them as one list.
  const matchSheets = workbook.worksheets.filter((sheet) =>
    normalizeKey(sheet.name).startsWith("servicematches"),
  );
  const serviceMatches = matchSheets.flatMap((sheet) =>
    readServiceMatches(sheet, subjects, warnings),
  );
  const definitionsSheet = byKey.get("servicedefinitions");
  const serviceDefinitions = definitionsSheet
    ? readServiceDefinitions(definitionsSheet)
    : [];
  const rulesSheet = byKey.get("rules");
  const ruleOverrides = rulesSheet
    ? readRuleOverrides(
        (row, col) => cellText(rulesSheet, row, col),
        rulesSheet.rowCount,
      )
    : {};

  for (const key of [
    "subject",
    "staff",
    "minutes",
    "servicedefinitions",
    "rules",
  ]) {
    consumed.add(key);
  }
  for (const sheet of matchSheets) consumed.add(normalizeKey(sheet.name));

  const knownStudents = new Set(students.map((s) => normalizeKey(s.name)));
  for (const requirement of requirements) {
    if (!knownStudents.has(normalizeKey(requirement.student))) {
      warnings.push(
        `${requirement.student} has service minutes but is not on the Students sheet, so those minutes cannot be scheduled.`,
      );
    }
  }

  // Service sheets: anything left that is laid out as day columns.
  const services: ServiceSession[] = [];
  const serviceNames: string[] = [];
  const unknownNames = new Set<string>();

  for (const sheet of workbook.worksheets) {
    const key = normalizeKey(sheet.name);
    if (consumed.has(key) || isGeneratedSheet(sheet.name)) continue;
    const headerRow = findServiceHeaderRow(sheet);
    if (headerRow == null) continue;

    const sessions = readServiceSheet(sheet, warnings, headerRow);
    if (sessions.length === 0) continue;
    serviceNames.push(sheet.name.trim());
    for (const session of sessions) {
      if (!knownStudents.has(normalizeKey(session.student))) {
        unknownNames.add(`${session.student} (${session.service})`);
      }
      services.push(session);
    }
  }

  for (const name of unknownNames) {
    warnings.push(
      `${name} is not on the Students sheet, so those sessions were ignored.`,
    );
  }

  return {
    fileName,
    students,
    classes,
    classSheetNames,
    services,
    serviceNames,
    subjects,
    staff,
    requirements,
    serviceMatches,
    serviceDefinitions,
    ruleOverrides,
    // Deduplicated: the same sentence twice tells a teacher nothing, and the
    // pages key their warning lists by text.
    warnings: [...new Set(warnings)],
  };
}
