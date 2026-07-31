import type { Worksheet } from "exceljs";
import { toMinutes } from "./time";
import {
  DAYS,
  type ClassBlock,
  type SchedulerInput,
  type ServiceSession,
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

/* ---------- readers ---------- */

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
    students.push({ name, className, classKey: normalizeKey(className) });
  }

  return students;
}

function readClassSchedule(sheet: Worksheet, warnings: string[]): ClassBlock[] {
  const columns = headerColumns(sheet, 1);
  const startCol = findColumn(columns, ["Start Time", "Start"], 1);
  const endCol = findColumn(columns, ["End Time", "End"], 2);
  const subjectCol = findColumn(columns, ["Subject", "Activity", "Block"], 4);
  const possibleCol = findColumn(
    columns,
    ["Service Possible", "Can Pull", "Pull OK"],
    5,
  );

  const blocks: ClassBlock[] = [];
  for (let row = 2; row <= sheet.rowCount; row++) {
    const start = toMinutes(cellValue(sheet, row, startCol));
    const end = toMinutes(cellValue(sheet, row, endCol));
    const subject = cellText(sheet, row, subjectCol);
    if (start == null || end == null) {
      // Blank spacer rows are normal; only complain when there was content.
      if (subject) {
        warnings.push(
          `${sheet.name} row ${row} ("${subject}") is missing a start or end time.`,
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
    blocks.push({
      start,
      end,
      subject,
      servicePossible: isTruthy(cellValue(sheet, row, possibleCol)),
    });
  }

  return blocks.sort((a, b) => a.start - b.start);
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
      const student = cellText(sheet, row, studentCol);
      const start = toMinutes(cellValue(sheet, row, col));
      const end = toMinutes(cellValue(sheet, row, endCol));
      if (!student && start == null && end == null) continue;
      if (!student || start == null || end == null) {
        warnings.push(
          `${sheet.name} (${day}) row ${row} is incomplete and was skipped.`,
        );
        continue;
      }
      sessions.push({ day, start, end, student, service: sheet.name.trim() });
    }
  }

  return sessions;
}

/* ---------- entry point ---------- */

/** A problem worth showing to a teacher verbatim, unlike a library stack trace. */
export class WorkbookError extends Error {}

export async function parseWorkbook(
  file: File | Blob,
  fileName: string,
): Promise<SchedulerInput> {
  const ExcelJS = (await import("exceljs")).default;
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
  const classes: Record<string, ClassBlock[]> = {};
  const classSheetNames: Record<string, string> = {};
  const consumed = new Set<string>(["students"]);

  for (const student of students) {
    if (!student.classKey || student.classKey in classes) continue;
    const sheet = byKey.get(student.classKey);
    if (!sheet) {
      warnings.push(
        `No schedule sheet found for class "${student.className}". Those students will show as unscheduled.`,
      );
      classes[student.classKey] = [];
      continue;
    }
    consumed.add(student.classKey);
    classSheetNames[student.classKey] = sheet.name;
    classes[student.classKey] = readClassSchedule(sheet, warnings);
  }

  // Service sheets: anything left that is laid out as day columns.
  const services: ServiceSession[] = [];
  const serviceNames: string[] = [];
  const knownStudents = new Set(students.map((s) => normalizeKey(s.name)));
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
    warnings,
  };
}
