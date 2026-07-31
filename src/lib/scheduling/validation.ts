import type { DataValidation, Worksheet } from "exceljs";

/**
 * Data-validation (dropdown) helpers.
 *
 * ExcelJS keeps validations keyed by individual cell address and regroups them
 * into rectangles when writing. That regrouping sorts addresses as strings, so
 * "A10" lands before "A2" and the same rule gets emitted twice over overlapping
 * ranges. Collapsing the model into explicit range keys ourselves sidesteps it:
 * a key containing ":" is written straight through untouched.
 */

const CELL_ADDRESS = /^([A-Z]+)([0-9]+)$/;

/** 1 -> "A", 27 -> "AA" */
export function columnLetter(column: number): string {
  let letters = "";
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

function decodeAddress(
  address: string,
): { column: number; row: number } | null {
  const match = CELL_ADDRESS.exec(address);
  if (!match) return null;
  let column = 0;
  for (const character of match[1]) {
    column = column * 26 + (character.charCodeAt(0) - 64);
  }
  return { column, row: Number(match[2]) };
}

/** Quote a sheet name for use in a formula, as Excel does for names with spaces. */
export function sheetReference(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)
    ? name
    : `'${name.replace(/'/g, "''")}'`;
}

/** `dataValidations` exists at runtime but is absent from ExcelJS's typings. */
function validationModel(sheet: Worksheet): Record<string, DataValidation> {
  const { dataValidations } = sheet as Worksheet & {
    dataValidations: { model: Record<string, DataValidation> };
  };
  return dataValidations.model;
}

/**
 * Rewrite a sheet's per-cell validations as one range key per contiguous run of
 * identical rules down a column, so each rule is written exactly once.
 */
export function collapseDataValidations(sheet: Worksheet): void {
  const model = validationModel(sheet);
  // column -> serialized rule -> rows
  const byColumn = new Map<number, Map<string, number[]>>();

  for (const [address, validation] of Object.entries(model)) {
    if (!validation) {
      delete model[address];
      continue;
    }
    // Anything already stored as a range is passed through by ExcelJS as-is.
    if (address.includes(":")) continue;

    const cell = decodeAddress(address);
    if (!cell) continue;

    const key = JSON.stringify(validation);
    const rules = byColumn.get(cell.column) ?? new Map<string, number[]>();
    byColumn.set(cell.column, rules);
    rules.set(key, [...(rules.get(key) ?? []), cell.row]);
    delete model[address];
  }

  for (const [column, rules] of byColumn) {
    const letter = columnLetter(column);
    for (const [key, rows] of rules) {
      const validation = JSON.parse(key) as DataValidation;
      rows.sort((a, b) => a - b);

      let start = rows[0];
      for (let index = 0; index <= rows.length; index++) {
        const row = rows[index];
        if (row === rows[index - 1] + 1) continue;
        if (index > 0) {
          const end = rows[index - 1];
          const range =
            start === end
              ? `${letter}${start}`
              : `${letter}${start}:${letter}${end}`;
          model[range] = validation;
        }
        start = row;
      }
    }
  }
}

/**
 * Apply one rule down a whole column, replacing anything already covering it.
 * The range deliberately runs past the last filled row so rows a teacher adds
 * later still get the dropdown.
 */
export function setColumnValidation(
  sheet: Worksheet,
  column: number,
  firstRow: number,
  lastRow: number,
  validation: DataValidation,
): void {
  const model = validationModel(sheet);

  for (const address of Object.keys(model)) {
    const [start, end] = address.split(":");
    const from = decodeAddress(start);
    const to = decodeAddress(end ?? start);
    if (!from || !to) continue;
    if (from.column <= column && to.column >= column) delete model[address];
  }

  const letter = columnLetter(column);
  model[`${letter}${firstRow}:${letter}${lastRow}`] = validation;
}
