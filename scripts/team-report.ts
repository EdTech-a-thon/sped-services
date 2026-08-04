/**
 * Headless run of the team planner against a workbook, for iterating faster
 * than dropping a file into the browser allows:
 *
 *   bun run scripts/team-report.ts "Service Scheduler Template - Colleen.xlsx"
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseWorkbook } from "../src/lib/scheduling/parse";
import { buildTeamPlan } from "../src/lib/scheduling/team";
import { formatRange } from "../src/lib/scheduling/time";
import { DAYS } from "../src/lib/scheduling/types";

const [path] = process.argv.slice(2);
if (!path) {
  throw new Error("usage: bun run scripts/team-report.ts <workbook.xlsx>");
}

const input = await parseWorkbook(
  new Blob([await readFile(path)]),
  basename(path),
);
const plan = buildTeamPlan(input);

const minutes = (value: number) => `${Math.round(value)} min`;

console.log(`# ${input.fileName}`);
console.log(
  `${input.students.length} students · ${Object.keys(input.classes).length} classes · ` +
    `${input.requirements.length} prescriptions · ${plan.staff.length} staff`,
);

console.log(`\n## Staff`);
for (const row of plan.load) {
  const cover = [...row.lunch, ...row.breaks]
    .filter((event) => event.day === "Monday")
    .map((event) => `${event.kind} ${formatRange(event.start, event.end)}`)
    .join(", ");
  console.log(
    `  ${row.staff.name.padEnd(10)} ${row.staff.role.padEnd(12)} ` +
      `leads ${String(row.leadRequirements).padStart(2)} rows · ` +
      `${String(row.sessions).padStart(3)} sessions · ` +
      `${minutes(row.scheduledMinutes).padStart(8)}/wk of ${minutes(row.availableMinutes)}` +
      (cover ? `  [${cover}]` : "  [no lunch or break]"),
  );
}

console.log(`\n## Groups (${plan.groups.length})`);
for (const group of plan.groups) {
  const placed = plan.placements.filter((p) => p.groupId === group.id);
  const leaders = [...new Set(placed.map((p) => p.staff))].join("/") || "—";
  console.log(
    `  ${group.service.padEnd(24)} ${group.groupType.padEnd(12)} ` +
      `${String(group.sessionLength).padStart(3)}min x${group.sessionsPerWeek} ` +
      `placed ${placed.length}/${group.sessionsPerWeek} by ${leaders.padEnd(20)} ${group.members.join(", ")}`,
  );
}

console.log(`\n## Week (${plan.placements.length} sessions)`);
for (const day of DAYS) {
  const sessions = plan.placements
    .filter((placement) => placement.day === day)
    .sort((a, b) => a.start - b.start);
  const cover = plan.coverage
    .filter((event) => event.day === day)
    .sort((a, b) => a.start - b.start);
  console.log(`  ${day}`);
  for (const placement of sessions) {
    console.log(
      `    ${formatRange(placement.start, placement.end).padEnd(20)} ` +
        `${placement.staff.padEnd(10)} ${placement.service.padEnd(24)} ` +
        `${placement.members.join(", ")}` +
        (placement.isLeadSession ? "  *lead*" : ""),
    );
  }
  for (const event of cover) {
    console.log(
      `    ${formatRange(event.start, event.end).padEnd(20)} ` +
        `${event.staff.padEnd(10)} ${event.kind}`,
    );
  }
  if (!sessions.length && !cover.length) console.log("    —");
}

const met = plan.compliance.filter((row) => row.status === "OK").length;
console.log(`\n## Compliance: ${met}/${plan.compliance.length} met`);
for (const row of plan.unplaced) {
  const reasons = Object.entries(row.reasons)
    .map(([reason, count]) => `${reason} x${count}`)
    .join("; ");
  console.log(
    `  ${row.student.padEnd(8)} ${row.service.padEnd(24)} short ${row.missingSessions}, ` +
      `${minutes(row.missingMinutes)}  [${reasons || "no reason recorded"}]`,
  );
}

console.log(`\n## Lead provider never met (${plan.leadGaps.length})`);
for (const gap of plan.leadGaps) {
  console.log(
    `  ${gap.leadProvider.padEnd(10)} never meets ${gap.student} for ${gap.service}`,
  );
}

console.log(`\n## Rule violations (${plan.violations.length})`);
for (const violation of plan.violations) {
  console.log(
    `  [${violation.ruleId}] ${violation.summary} — ${violation.detail}`,
  );
}

if (plan.unmodelledRules.length) {
  console.log(`\n## Rules not modelled (${plan.unmodelledRules.length})`);
  for (const text of plan.unmodelledRules) console.log(`  - ${text}`);
}

if (input.warnings.length) {
  console.log(`\n## Workbook warnings (${input.warnings.length})`);
  for (const warning of input.warnings) console.log(`  - ${warning}`);
}
