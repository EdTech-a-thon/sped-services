/**
 * Headless run of the planner against a workbook, for iterating faster than
 * dropping a file into the browser allows:
 *
 *   bun run scripts/plan-report.ts "Service Scheduler Template - ....xlsx" [provider]
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseWorkbook } from "../src/lib/scheduling/parse";
import { buildPlan, providerNames } from "../src/lib/scheduling/plan";
import { formatRange } from "../src/lib/scheduling/time";
import { DAYS } from "../src/lib/scheduling/types";

const [path, providerArgument] = process.argv.slice(2);
if (!path) {
  throw new Error(
    "usage: bun run scripts/plan-report.ts <workbook.xlsx> [provider]",
  );
}

const input = await parseWorkbook(
  new Blob([await readFile(path)]),
  basename(path),
);
const provider = providerArgument ?? providerNames(input)[0] ?? "Panzer";
const plan = buildPlan(input, provider);

const minutes = (value: number) => `${Math.round(value)} min`;

console.log(`# ${input.fileName}`);
console.log(
  `${input.students.length} students · ${Object.keys(input.classes).length} classes · ` +
    `${input.requirements.length} requirements · ${input.services.length} outside bookings`,
);
console.log(`providers: ${providerNames(input).join(", ")}`);

const { capacity } = plan;
console.log(`\n## Capacity — ${provider}`);
console.log(`  requirements            ${capacity.requirementCount}`);
console.log(
  `  prescribed              ${minutes(capacity.studentMinutesPerWeek)}/wk over ${capacity.studentSessionsPerWeek} student-sessions`,
);
console.log(
  `  grouped demand          ${minutes(capacity.groupedMinutesPerWeek)}/wk`,
);
console.log(
  `  available (rule 8)      ${minutes(capacity.availableMinutesPerWeek)}/wk`,
);
console.log(
  `  demand vs capacity      ${Math.round((100 * capacity.groupedMinutesPerWeek) / capacity.availableMinutesPerWeek)}%`,
);
console.log(
  `  actually scheduled      ${minutes(capacity.scheduledMinutesPerWeek)}/wk`,
);

console.log(`\n## Groups (${plan.groups.length})`);
for (const group of plan.groups) {
  const placed = plan.placements.filter((p) => p.groupId === group.id).length;
  console.log(
    `  ${group.service.padEnd(22)} ${group.groupType.padEnd(12)} ` +
      `${String(group.sessionLength).padStart(3)}min x${group.sessionsPerWeek} ` +
      `placed ${placed}/${group.sessionsPerWeek}  ${group.members.join(", ")}`,
  );
}

console.log(`\n## Week (${plan.placements.length} sessions)`);
for (const day of DAYS) {
  const today = plan.placements
    .filter((placement) => placement.day === day)
    .sort((a, b) => a.start - b.start);
  console.log(`  ${day}`);
  for (const placement of today) {
    console.log(
      `    ${formatRange(placement.start, placement.end).padEnd(22)} ` +
        `${placement.service.padEnd(22)} ${placement.members.join(", ")}` +
        (placement.subject ? `  (during ${placement.subject})` : ""),
    );
  }
  if (!today.length) console.log("    —");
}

const missing = plan.compliance.filter((row) => row.status !== "OK");
console.log(
  `\n## Compliance: ${plan.compliance.length - missing.length}/${plan.compliance.length} met`,
);
for (const row of plan.unplaced) {
  const reasons = Object.entries(row.reasons)
    .map(([reason, count]) => `${reason} x${count}`)
    .join("; ");
  console.log(
    `  ${row.student.padEnd(10)} ${row.service.padEnd(22)} short ${row.missingSessions} session(s), ` +
      `${minutes(row.missingMinutes)}  [${reasons || "no reason recorded"}]`,
  );
}

if (plan.unseenStudents.length) {
  console.log(`\n## Never seen by ${provider} (rule 13)`);
  console.log(`  ${plan.unseenStudents.join(", ")}`);
}

if (input.warnings.length) {
  console.log(`\n## Warnings (${input.warnings.length})`);
  for (const warning of input.warnings) console.log(`  - ${warning}`);
}
