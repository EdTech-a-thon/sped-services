import type { Workbook, Worksheet } from "exceljs";
import { isGeneratedSheet, loadExcelJS, normalizeKey } from "./parse";
import type { TeamPlanResult } from "./team";
import { formatRange } from "./time";
import type {
  CellStatus,
  PlanResult,
  ScheduleResult,
  SchedulerInput,
} from "./types";
import { collapseDataValidations } from "./validation";

/** Matches the colours the original Apps Script wrote, so exports look familiar. */
const FILLS: Record<CellStatus, string | null> = {
  available: "FFB7E1CD",
  unavailable: "FFF4C7C3",
  booked: "FFF4C7C3",
  empty: null,
};

const TIME_COLUMN_WIDTH = 17.3;
const STUDENT_COLUMN_WIDTH = 15.9;

function writeDaySheet(
  sheet: Worksheet,
  result: ScheduleResult,
  index: number,
) {
  const grid = result.grids[index];

  sheet.addRow(["Time", ...result.students.map((student) => student.name)]);
  for (let row = 0; row < grid.slots.length; row++) {
    sheet.addRow([
      grid.slots[row].label,
      ...grid.rows[row].map((cell) => cell.label),
    ]);
  }

  for (let row = 0; row < grid.slots.length; row++) {
    const sheetRow = sheet.getRow(row + 2);
    grid.rows[row].forEach((cell, column) => {
      const fill = FILLS[cell.status];
      if (!fill) return;
      sheetRow.getCell(column + 2).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: fill },
      };
    });
  }

  sheet.getRow(1).font = { bold: true };
  sheet.columns.forEach((column, index) => {
    column.width = index === 0 ? TIME_COLUMN_WIDTH : STUDENT_COLUMN_WIDTH;
    column.alignment = { vertical: "middle" };
  });
  sheet.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];
}

/**
 * Produce the download. When the teacher's original file is available we hand
 * back that same workbook with its "<Day> Grid" sheets rebuilt, so every input
 * sheet they maintain by hand survives the round trip.
 */
export async function buildExport(
  result: ScheduleResult,
  originalFile?: ArrayBuffer,
): Promise<Blob> {
  const ExcelJS = await loadExcelJS();
  let workbook: Workbook;

  if (originalFile) {
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(originalFile);
    for (const sheet of [...workbook.worksheets]) {
      if (isGeneratedSheet(sheet.name)) {
        workbook.removeWorksheet(sheet.id);
        continue;
      }
      // Keep the teacher's dropdowns intact: left alone, ExcelJS rewrites each
      // rule twice over overlapping ranges when it saves.
      collapseDataValidations(sheet);
    }
  } else {
    workbook = new ExcelJS.Workbook();
    workbook.created = new Date();
  }

  result.grids.forEach((grid, index) => {
    writeDaySheet(workbook.addWorksheet(`${grid.day} Grid`), result, index);
  });

  const bytes = await workbook.xlsx.writeBuffer();
  return new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

const REPORT_SHEETS = [
  "Generated Schedule",
  "Conflicts",
  "Compliance Report",
] as const;

function writeReport(sheet: Worksheet, headers: string[], rows: unknown[][]) {
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  sheet.getRow(1).font = { bold: true };
  sheet.columns.forEach((column) => {
    column.width = 22;
  });
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

/**
 * Write the plan back into the teacher's own workbook, filling the three report
 * sheets it already carries. Their headings are reused verbatim; the one change
 * is that "Time Block" holds a readable time range rather than the opaque row
 * index the previous generator wrote.
 */
export async function buildPlanExport(
  input: SchedulerInput,
  plan: PlanResult,
  originalFile?: ArrayBuffer,
): Promise<Blob> {
  const ExcelJS = await loadExcelJS();
  const workbook = new ExcelJS.Workbook();

  if (originalFile) {
    await workbook.xlsx.load(originalFile);
    for (const sheet of [...workbook.worksheets]) {
      if (
        REPORT_SHEETS.some(
          (name) => normalizeKey(name) === normalizeKey(sheet.name),
        )
      ) {
        workbook.removeWorksheet(sheet.id);
        continue;
      }
      collapseDataValidations(sheet);
    }
  } else {
    workbook.created = new Date();
  }

  const classOf = new Map(
    input.students.map((student) => [
      normalizeKey(student.name),
      student.className,
    ]),
  );

  writeReport(
    workbook.addWorksheet("Generated Schedule"),
    [
      "Day",
      "Student",
      "Service",
      "Provider",
      "Classroom",
      "Time Block",
      "Subject",
      "Minutes",
    ],
    plan.placements.flatMap((placement) =>
      placement.members.map((member) => [
        placement.day,
        member,
        placement.service,
        plan.provider,
        classOf.get(normalizeKey(member)) ?? "",
        formatRange(placement.start, placement.end),
        placement.subject,
        placement.end - placement.start,
      ]),
    ),
  );

  writeReport(
    workbook.addWorksheet("Conflicts"),
    ["Student", "Service", "Provider", "Service Model", "Reasons"],
    plan.unplaced.map((row) => [
      row.student,
      row.service,
      plan.provider,
      row.model,
      JSON.stringify(row.reasons),
    ]),
  );

  writeReport(
    workbook.addWorksheet("Compliance Report"),
    [
      "Student",
      "Service",
      "Required Minutes",
      "Scheduled Minutes",
      "Difference",
      "Status",
    ],
    plan.compliance.map((row) => [
      row.student,
      row.service,
      row.requiredMinutes,
      row.scheduledMinutes,
      row.difference,
      row.status,
    ]),
  );

  const bytes = await workbook.xlsx.writeBuffer();
  return new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

const TEAM_REPORT_SHEETS = [
  ...REPORT_SHEETS,
  "Staff Coverage",
  "Rule Violations",
] as const;

/**
 * The team plan written back into the teacher's own workbook.
 *
 * The same three report sheets as `buildPlanExport`, except that "Provider" is
 * now the person who actually leads each session rather than a single name for
 * the whole plan, plus two sheets the single-provider export has no use for:
 * where everybody's lunch and break landed, and which soft rules had to bend.
 */
export async function buildTeamPlanExport(
  input: SchedulerInput,
  plan: TeamPlanResult,
  originalFile?: ArrayBuffer,
): Promise<Blob> {
  const ExcelJS = await loadExcelJS();
  const workbook = new ExcelJS.Workbook();

  if (originalFile) {
    await workbook.xlsx.load(originalFile);
    for (const sheet of [...workbook.worksheets]) {
      if (
        TEAM_REPORT_SHEETS.some(
          (name) => normalizeKey(name) === normalizeKey(sheet.name),
        )
      ) {
        workbook.removeWorksheet(sheet.id);
        continue;
      }
      collapseDataValidations(sheet);
    }
  } else {
    workbook.created = new Date();
  }

  const classOf = new Map(
    input.students.map((student) => [
      normalizeKey(student.name),
      student.className,
    ]),
  );

  writeReport(
    workbook.addWorksheet("Generated Schedule"),
    [
      "Day",
      "Student",
      "Service",
      "Provider",
      "Support",
      "Classroom",
      "Time Block",
      "Subject",
      "Minutes",
      "Lead Session?",
    ],
    plan.placements.flatMap((placement) =>
      placement.members.map((member) => [
        placement.day,
        member,
        placement.service,
        placement.staff,
        placement.supportStaff.join(", "),
        classOf.get(normalizeKey(member)) ?? "",
        formatRange(placement.start, placement.end),
        placement.subject,
        placement.end - placement.start,
        placement.isLeadSession ? "Yes" : "",
      ]),
    ),
  );

  writeReport(
    workbook.addWorksheet("Conflicts"),
    [
      "Student",
      "Service",
      "Service Model",
      "Sessions Short",
      "Minutes Short",
      "Reasons",
    ],
    plan.unplaced.map((row) => [
      row.student,
      row.service,
      row.model,
      row.missingSessions,
      row.missingMinutes,
      Object.entries(row.reasons)
        .map(([reason, count]) => `${reason} x${count}`)
        .join("; "),
    ]),
  );

  writeReport(
    workbook.addWorksheet("Compliance Report"),
    [
      "Student",
      "Service",
      "Required Minutes",
      "Scheduled Minutes",
      "Difference",
      "Status",
    ],
    plan.compliance.map((row) => [
      row.student,
      row.service,
      row.requiredMinutes,
      row.scheduledMinutes,
      row.difference,
      row.status,
    ]),
  );

  writeReport(
    workbook.addWorksheet("Staff Coverage"),
    ["Staff", "Role", "Day", "Kind", "Time Block", "Minutes", "Note"],
    [
      ...plan.coverage.map((event) => [
        event.staff,
        plan.staff.find(
          (member) => normalizeKey(member.name) === normalizeKey(event.staff),
        )?.role ?? "",
        event.day,
        event.kind,
        formatRange(event.start, event.end),
        event.end - event.start,
        event.violates.length ? "Outside the preferred window" : "",
      ]),
      ...plan.coverageGaps.map((gap) => [
        gap.staff,
        "",
        gap.day,
        gap.kind,
        "not placed",
        gap.minutes,
        gap.reason,
      ]),
    ],
  );

  writeReport(
    workbook.addWorksheet("Rule Violations"),
    ["Rule", "Summary", "Detail"],
    [
      ...plan.violations.map((violation) => [
        violation.ruleId,
        violation.summary,
        violation.detail,
      ]),
      ...plan.unmodelledRules.map((text) => [
        "not modelled",
        "This rule is not checked by the planner",
        text,
      ]),
    ],
  );

  const bytes = await workbook.xlsx.writeBuffer();
  return new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

/** "Template.xlsx" -> "Template - team plan.xlsx" */
export function teamPlanFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "") || "plan";
  return `${base} - team plan.xlsx`;
}

/** "Special Ed Scheduling.xlsx" -> "Special Ed Scheduling - schedules.xlsx" */
export function exportFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "") || "schedules";
  return `${base} - schedules.xlsx`;
}

/** "Template.xlsx", "Panzer" -> "Template - Panzer plan.xlsx" */
export function planFileName(fileName: string, provider: string): string {
  const base = fileName.replace(/\.[^.]+$/, "") || "plan";
  return `${base} - ${provider} plan.xlsx`;
}
