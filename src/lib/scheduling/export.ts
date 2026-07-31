import type { Workbook, Worksheet } from "exceljs";
import { isGeneratedSheet } from "./parse";
import type { CellStatus, ScheduleResult } from "./types";
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
  const ExcelJS = (await import("exceljs")).default;
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

/** "Special Ed Scheduling.xlsx" -> "Special Ed Scheduling - schedules.xlsx" */
export function exportFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "") || "schedules";
  return `${base} - schedules.xlsx`;
}
