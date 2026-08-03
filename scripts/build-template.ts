/**
 * Regenerates the starter workbook teachers download from the site.
 *
 * It is the source workbook with the generated "<Day> Grid" sheets stripped and
 * its dropdowns repaired, so everything else a teacher relies on — headings,
 * formulas, formatting — survives. Re-run with `bun run template`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import ExcelJS from "exceljs";
import {
  findClassHeaderRow,
  findDayColumns,
  findServiceHeaderRow,
  headerColumns,
  isGeneratedSheet,
  normalizeKey,
  parseWorkbook,
} from "../src/lib/scheduling/parse";
import {
  collapseDataValidations,
  setColumnValidation,
  sheetReference,
} from "../src/lib/scheduling/validation";
import { DAYS } from "../src/lib/scheduling/types";

const SOURCE =
  "Service Scheduler Template - Subject-level Service Permissions.xlsx";
const TARGET = "static/service-scheduler-template.xlsx";

/**
 * Sheets the app produces. They ship stale in the source workbook, and the
 * planner rewrites them on export, so the starter file should not carry them.
 */
const GENERATED_SHEETS = [
  "Generated Schedule",
  "Student Schedules",
  "Validation Report",
  "Compliance Report",
  "Conflicts",
].map(normalizeKey);

/**
 * How far past the filled rows the dropdowns should reach, so a teacher adding
 * a class block or therapy session still gets one.
 */
const SPARE_ROWS = 100;

/** Generous enough that the student list never truncates in practice. */
const STUDENT_LIST_LAST_ROW = 1000;

/** Same, for the Subject sheet the class-sheet day columns point at. */
const SUBJECT_LIST_LAST_ROW = 200;

const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(SOURCE);

/* ---------- 1. drop the sheets we generate ---------- */

const removed: string[] = [];
for (const sheet of [...workbook.worksheets]) {
  const generated =
    isGeneratedSheet(sheet.name) ||
    GENERATED_SHEETS.includes(normalizeKey(sheet.name));
  if (!generated) continue;
  removed.push(sheet.name);
  workbook.removeWorksheet(sheet.id);
}

/* ---------- 2. repair the dropdowns ---------- */

// Reuse the app's own sheet detection so the template can never drift from what
// the parser expects to read back.
const input = await parseWorkbook(
  new Blob([await workbook.xlsx.writeBuffer()]),
  SOURCE,
);

const studentsSheet = workbook.worksheets.find(
  (sheet) => normalizeKey(sheet.name) === "students",
);
if (!studentsSheet)
  throw new Error("No Students sheet in the source workbook.");

const fixes: string[] = [];

// 2a. Class sheets. The current layout lists a subject per weekday and decides
// eligibility from Service Matches, so the day columns get a Subject dropdown.
// Older workbooks still carry a "Service Possible" column instead, which had no
// validation at all and so arrived in Google Sheets as bare TRUE/FALSE text.
const subjectSheet = workbook.worksheets.find(
  (sheet) => normalizeKey(sheet.name) === "subject",
);
const subjectRange = subjectSheet
  ? `${sheetReference(subjectSheet.name)}!$A$2:$A$${SUBJECT_LIST_LAST_ROW}`
  : null;

for (const sheetName of Object.values(input.classSheetNames)) {
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) continue;

  const headerRow = findClassHeaderRow(sheet);
  const columns = headerColumns(sheet, headerRow);
  const possible = ["Service Possible", "Can Pull", "Pull OK"]
    .map((name) => columns.get(normalizeKey(name)))
    .find((column) => column != null);

  if (possible != null) {
    setColumnValidation(
      sheet,
      possible,
      headerRow + 1,
      sheet.rowCount + SPARE_ROWS,
      {
        type: "list",
        allowBlank: true,
        formulae: ['"TRUE,FALSE"'],
        // Warn rather than reject: the cells already hold real booleans, and a
        // teacher pasting a column should not be blocked.
        showErrorMessage: false,
        showInputMessage: true,
        promptTitle: "Service possible?",
        prompt: "TRUE if a student may be pulled from this block for services.",
      },
    );
    fixes.push(
      `${sheet.name}: Service Possible dropdown on column ${possible}`,
    );
    continue;
  }

  const dayColumns = findDayColumns(sheet, headerRow);
  if (!dayColumns || !subjectRange) continue;
  dayColumns.forEach((column, index) => {
    setColumnValidation(
      sheet,
      column,
      headerRow + 1,
      sheet.rowCount + SPARE_ROWS,
      {
        type: "list",
        allowBlank: true,
        formulae: [subjectRange],
        showErrorMessage: true,
        errorTitle: "Unknown subject",
        error: "Pick a subject from the Subject sheet.",
        showInputMessage: true,
        promptTitle: `${DAYS[index]}`,
        prompt: "What this class is doing during this block.",
      },
    );
  });
  fixes.push(`${sheet.name}: Subject dropdowns on the five day columns`);
}

// 2b. The student dropdowns pointed at Students!$A$2:$A10, which cut the list
// off after nine students.
const studentRange = `${sheetReference(studentsSheet.name)}!$A$2:$A$${STUDENT_LIST_LAST_ROW}`;

for (const sheet of workbook.worksheets) {
  const headerRow = findServiceHeaderRow(sheet);
  if (headerRow == null) continue;

  const columns: number[] = [];
  for (let column = 1; column <= sheet.columnCount; column++) {
    const label = normalizeKey(
      String(sheet.getRow(headerRow).getCell(column).value ?? ""),
    );
    if (label !== "student") continue;
    columns.push(column);
    setColumnValidation(
      sheet,
      column,
      headerRow + 1,
      sheet.rowCount + SPARE_ROWS,
      {
        type: "list",
        allowBlank: true,
        formulae: [studentRange],
        showErrorMessage: true,
        errorTitle: "Unknown student",
        error: "Pick a student from the Students sheet.",
      },
    );
  }
  if (columns.length) {
    fixes.push(`${sheet.name}: student dropdowns -> ${studentRange}`);
  }
}

// ExcelJS regroups per-cell validations badly on write, emitting the same rule
// twice over overlapping ranges. Collapsing to explicit ranges avoids that.
for (const sheet of workbook.worksheets) collapseDataValidations(sheet);

/* ---------- 3. write ---------- */

await mkdir(dirname(TARGET), { recursive: true });
await writeFile(TARGET, Buffer.from(await workbook.xlsx.writeBuffer()));

console.log(`Removed: ${removed.join(", ") || "(nothing)"}`);
for (const fix of fixes) console.log(`Fixed:   ${fix}`);
console.log(`Kept:    ${workbook.worksheets.map((s) => s.name).join(", ")}`);
console.log(`Wrote    ${TARGET}`);
