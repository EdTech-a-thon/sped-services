import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { normalizeKey, parseWorkbook } from "./parse";
import { buildEligibility, isPullable } from "./permissions";
import { buildTeamPlan } from "./team";
import { SPED_ROOM, type TeamPlacement } from "./teamPlace";
import {
  isParapro,
  isSlcTeacher,
  readTeamRules,
  schedulableStaff,
} from "./teamRules";
import { DAYS, type Day, type StaffEvent } from "./types";

const WORKBOOK = "Service Scheduler Template - Colleen.xlsx";

const input = await parseWorkbook(
  new Blob([await readFile(WORKBOOK)]),
  WORKBOOK,
);
const plan = buildTeamPlan(input);

const staff = schedulableStaff(input.staff);
const slc = staff.find(isSlcTeacher)!;
const paraKeys = new Set(
  staff.filter(isParapro).map((member) => normalizeKey(member.name)),
);

const ledBy = (name: string) =>
  plan.placements.filter(
    (placement) => normalizeKey(placement.staff) === normalizeKey(name),
  );

const overlaps = (
  a: { start: number; end: number },
  b: { start: number; end: number },
) => a.start < b.end && a.end > b.start;

/** Every commitment a staff member has on a day: sessions plus lunch and break. */
function commitments(
  name: string,
  day: Day,
): { start: number; end: number; what: string }[] {
  const key = normalizeKey(name);
  return [
    ...plan.placements
      .filter((p) => normalizeKey(p.staff) === key && p.day === day)
      .map((p) => ({ start: p.start, end: p.end, what: p.service })),
    ...plan.coverage
      .filter((c) => normalizeKey(c.staff) === key && c.day === day)
      .map((c) => ({ start: c.start, end: c.end, what: c.kind })),
  ].sort((a, b) => a.start - b.start);
}

describe("reading the Colleen workbook", () => {
  test("the Rules sheet is read as sections, not as speech rules", () => {
    // The parapro rule about groups "in the General Education classroom" used to
    // be mistaken for the speech grade-span rule and set it to 3.
    expect(input.ruleOverrides).toEqual({});
    expect(input.ruleRows.length).toBeGreaterThan(20);
    expect(new Set(input.ruleRows.map((row) => row.section))).toEqual(
      new Set(["Staff Rule", "Instruction Rule", "Compliance Rule"]),
    );
  });

  test("values on the Rules sheet drive the settings", () => {
    const reading = readTeamRules(input.ruleRows);
    expect(reading.settings.paraMaxGroupSize).toBe(3);
    expect(reading.settings.slcBreakChunks).toBe(2);
  });

  test("the student-specific rules are reported as not modelled", () => {
    expect(plan.unmodelledRules.length).toBe(3);
    expect(plan.unmodelledRules.join(" ")).toContain("JoAy and JaBe");
  });

  test("lead and alternate providers are read separately", () => {
    const row = input.requirements.find(
      (requirement) =>
        requirement.student === "JoAy" && requirement.service === "Writing",
    )!;
    expect(row.leadProvider).toBe("Panzer");
    expect(row.alternateProviders).toEqual([
      "Sloan",
      "Stone",
      "Georgie",
      "Mystery",
    ]);
  });

  test("general education teachers are not scheduled", () => {
    expect(staff.some((member) => /gen-?ed/i.test(member.providerType))).toBe(
      false,
    );
    expect(plan.staff.length).toBe(9);
  });
});

describe("staff cannot be in two places at once", () => {
  test("no staff member is double-booked, counting lunch and break", () => {
    for (const member of staff) {
      for (const day of DAYS) {
        const spans = commitments(member.name, day);
        for (let i = 1; i < spans.length; i++) {
          expect({
            staff: member.name,
            day,
            a: spans[i - 1],
            b: spans[i],
            clash: overlaps(spans[i - 1], spans[i]),
          }).toMatchObject({ clash: false });
        }
      }
    }
  });

  test("no student is in two sessions at once", () => {
    for (const day of DAYS) {
      const today = plan.placements.filter((p) => p.day === day);
      for (let i = 0; i < today.length; i++) {
        for (let j = i + 1; j < today.length; j++) {
          if (!overlaps(today[i], today[j])) continue;
          const shared = today[i].members.filter((member) =>
            today[j].members.some(
              (other) => normalizeKey(other) === normalizeKey(member),
            ),
          );
          expect(shared).toEqual([]);
        }
      }
    }
  });

  test("nobody is booked outside their working hours", () => {
    for (const placement of plan.placements) {
      const member = staff.find(
        (candidate) =>
          normalizeKey(candidate.name) === normalizeKey(placement.staff),
      )!;
      expect(placement.start).toBeGreaterThanOrEqual(member.startMinutes!);
      expect(placement.end).toBeLessThanOrEqual(member.endMinutes!);
    }
  });
});

describe("who may lead a session", () => {
  test("every session's leader is named on every member's Minutes row", () => {
    for (const placement of plan.placements) {
      for (const member of placement.members) {
        const row = input.requirements.find(
          (requirement) =>
            normalizeKey(requirement.student) === normalizeKey(member) &&
            normalizeKey(requirement.service) ===
              normalizeKey(placement.service) &&
            requirement.model === placement.model,
        );
        if (!row) continue;
        expect(
          row.providers.some(
            (name) => normalizeKey(name) === normalizeKey(placement.staff),
          ),
        ).toBe(true);
      }
    }
  });

  test("a parapro only covers for someone else where the sheet allows it", () => {
    for (const placement of plan.placements) {
      if (!paraKeys.has(normalizeKey(placement.staff))) continue;
      for (const member of placement.members) {
        const row = input.requirements.find(
          (requirement) =>
            normalizeKey(requirement.student) === normalizeKey(member) &&
            normalizeKey(requirement.service) ===
              normalizeKey(placement.service) &&
            requirement.model === placement.model,
        );
        if (!row) continue;
        const isOwnAssignment =
          normalizeKey(row.leadProvider) === normalizeKey(placement.staff);
        expect(isOwnAssignment || row.canParaLead).toBe(true);
      }
    }
  });

  test("a parapro never leads a group bigger than the cap", () => {
    for (const placement of plan.placements) {
      if (!paraKeys.has(normalizeKey(placement.staff))) continue;
      expect(placement.members.length).toBeLessThanOrEqual(
        plan.settings.paraMaxGroupSize,
      );
    }
  });
});

describe("parapro supervision", () => {
  const paraPullOut = plan.placements.filter(
    (placement) =>
      paraKeys.has(normalizeKey(placement.staff)) &&
      placement.location === SPED_ROOM,
  );

  test("the workbook actually exercises this rule", () => {
    expect(paraPullOut.length).toBeGreaterThan(0);
  });

  test("every parapro pull-out happens inside the SLC teacher's hours", () => {
    for (const placement of paraPullOut) {
      expect(placement.start).toBeGreaterThanOrEqual(slc.startMinutes!);
      expect(placement.end).toBeLessThanOrEqual(slc.endMinutes!);
    }
  });

  test("the SLC teacher is never on lunch or break during one", () => {
    const away = plan.coverage.filter(
      (event) => normalizeKey(event.staff) === normalizeKey(slc.name),
    );
    for (const placement of paraPullOut) {
      const clash = away.some(
        (event) => event.day === placement.day && overlaps(event, placement),
      );
      expect({ ...describePlacement(placement), clash }).toMatchObject({
        clash: false,
      });
    }
  });

  test("the SLC teacher is never pushing into a classroom during one", () => {
    const elsewhere = ledBy(slc.name).filter(
      (placement) => placement.location !== SPED_ROOM,
    );
    for (const placement of paraPullOut) {
      const clash = elsewhere.some(
        (session) =>
          session.day === placement.day && overlaps(session, placement),
      );
      expect({ ...describePlacement(placement), clash }).toMatchObject({
        clash: false,
      });
    }
  });

  test("the lead provider takes one session and parapros carry the repeats", () => {
    // A group the lead only has to attend once should not have the lead on
    // every session while parapros who may lead it stand idle.
    const repeats = plan.placements.filter(
      (placement) => !placement.isLeadSession,
    );
    expect(repeats.length).toBeGreaterThan(0);

    const paraLed = plan.placements.filter((placement) =>
      paraKeys.has(normalizeKey(placement.staff)),
    );
    // Every parapro on the Staff sheet is actually used.
    const working = new Set(paraLed.map((p) => normalizeKey(p.staff)));
    expect(working.size).toBe(paraKeys.size);
  });
});

function describePlacement(placement: TeamPlacement) {
  return {
    staff: placement.staff,
    service: placement.service,
    day: placement.day,
    start: placement.start,
  };
}

describe("the MTSS whole group owns the pull-out room", () => {
  test("nothing else is in the room while it runs", () => {
    const mtss = plan.placements.filter(
      (placement) =>
        placement.location === SPED_ROOM &&
        placement.model === "Pull-Out" &&
        /mtss/i.test(placement.service) &&
        plan.groups.find((group) => group.id === placement.groupId)
          ?.groupType === "Whole Group",
    );
    expect(mtss.length).toBeGreaterThan(0);

    for (const session of mtss) {
      const others = plan.placements.filter(
        (placement) =>
          placement !== session &&
          placement.location === SPED_ROOM &&
          placement.day === session.day &&
          overlaps(placement, session),
      );
      expect(others.map(describePlacement)).toEqual([]);
    }
  });
});

describe("lunches and breaks", () => {
  const eventsFor = (name: string, kind: StaffEvent["kind"]) =>
    plan.coverage.filter(
      (event) =>
        normalizeKey(event.staff) === normalizeKey(name) && event.kind === kind,
    );

  test("every parapro gets a lunch and a break every day", () => {
    for (const member of staff.filter(isParapro)) {
      for (const kind of ["Lunch", "Break"] as const) {
        const days = new Set(
          eventsFor(member.name, kind).map((event) => event.day),
        );
        expect({ staff: member.name, kind, days: days.size }).toMatchObject({
          days: 5,
        });
      }
    }
  });

  test("parapro breaks avoid the first and last hour of the day", () => {
    for (const member of staff.filter(isParapro)) {
      for (const event of eventsFor(member.name, "Break")) {
        expect(event.start).toBeGreaterThanOrEqual(
          member.startMinutes! + plan.settings.paraBreakMinAfterStart,
        );
        expect(event.end).toBeLessThanOrEqual(
          member.endMinutes! - plan.settings.paraBreakMinBeforeEnd,
        );
      }
    }
  });

  test("a lunch outside the preferred window is reported, not hidden", () => {
    for (const event of plan.coverage) {
      if (event.kind !== "Lunch") continue;
      const outside =
        event.start < plan.settings.paraLunchStart ||
        event.start > plan.settings.paraLunchEnd;
      if (!outside) continue;
      expect(event.violates).toContain("para-lunch-window");
    }
  });

  test("coverage lasts as long as the Staff sheet says", () => {
    for (const member of staff) {
      if (!member.lunchMinutes && !member.breakMinutes) continue;
      for (const day of DAYS) {
        for (const kind of ["Lunch", "Break"] as const) {
          const want =
            kind === "Lunch" ? member.lunchMinutes : member.breakMinutes;
          if (!want) continue;
          const got = plan.coverage
            .filter(
              (event) =>
                normalizeKey(event.staff) === normalizeKey(member.name) &&
                event.kind === kind &&
                event.day === day,
            )
            .reduce((sum, event) => sum + (event.end - event.start), 0);
          const missing = plan.coverageGaps
            .filter(
              (gap) =>
                normalizeKey(gap.staff) === normalizeKey(member.name) &&
                gap.kind === kind &&
                gap.day === day,
            )
            .reduce((sum, gap) => sum + gap.minutes, 0);
          expect({
            staff: member.name,
            day,
            kind,
            total: got + missing,
          }).toMatchObject({ total: want });
        }
      }
    }
  });

  test("the SLC teacher's break may arrive in chunks, but no more than allowed", () => {
    for (const day of DAYS) {
      const pieces = plan.coverage.filter(
        (event) =>
          normalizeKey(event.staff) === normalizeKey(slc.name) &&
          event.kind === "Break" &&
          event.day === day,
      );
      expect(pieces.length).toBeLessThanOrEqual(plan.settings.slcBreakChunks);
    }
  });

  test("the SLC teacher is only away when the room is empty and a parapro is free", () => {
    const away = plan.coverage.filter(
      (event) => normalizeKey(event.staff) === normalizeKey(slc.name),
    );
    for (const event of away) {
      const inRoom = plan.placements.filter(
        (placement) =>
          placement.location === SPED_ROOM &&
          placement.day === event.day &&
          overlaps(placement, event),
      );
      expect(inRoom.map(describePlacement)).toEqual([]);

      const free = [...paraKeys].some((key) => {
        const busy = [
          ...plan.placements.filter(
            (placement) =>
              normalizeKey(placement.staff) === key &&
              placement.day === event.day,
          ),
          ...plan.coverage.filter(
            (other) =>
              normalizeKey(other.staff) === key && other.day === event.day,
          ),
        ];
        return !busy.some((span) => overlaps(span, event));
      });
      expect({ day: event.day, kind: event.kind, free }).toMatchObject({
        free: true,
      });
    }
  });
});

describe("what students may never miss", () => {
  const eligibility = buildEligibility(input.serviceMatches);

  test("Recess, Specials, Lunch and Dismissal are never pullable", () => {
    for (const schedule of Object.values(input.classes)) {
      for (const day of DAYS) {
        for (const block of schedule[day]) {
          if (!/^(recess|specials|lunch|dismissal)/i.test(block.subject)) {
            continue;
          }
          expect({
            subject: block.subject,
            pullable: isPullable(block, eligibility),
          }).toMatchObject({ pullable: false });
        }
      }
    }
  });

  test("no session displaces one of them", () => {
    for (const placement of plan.placements) {
      expect(placement.subject).not.toMatch(
        /recess|specials|dismissal|^lunch| lunch/i,
      );
    }
  });
});

describe("reporting rather than reducing", () => {
  test("required minutes always match the prescription", () => {
    for (const row of plan.compliance) {
      const prescribed = input.requirements.find(
        (requirement) =>
          normalizeKey(requirement.student) === normalizeKey(row.student) &&
          normalizeKey(requirement.service) === normalizeKey(row.service),
      )!;
      expect(row.requiredMinutes).toBe(
        prescribed.minutesPerWeek ||
          prescribed.sessionLength * prescribed.sessionsPerWeek,
      );
    }
  });

  test("every shortfall carries a reason", () => {
    expect(plan.unplaced.length).toBeGreaterThan(0);
    for (const row of plan.unplaced) {
      expect(Object.keys(row.reasons).length).toBeGreaterThan(0);
    }
  });

  test("a lead provider who never meets their student is reported", () => {
    for (const gap of plan.leadGaps) {
      const met = plan.placements.some(
        (placement) =>
          normalizeKey(placement.staff) === normalizeKey(gap.leadProvider) &&
          normalizeKey(placement.service) === normalizeKey(gap.service) &&
          placement.members.some(
            (member) => normalizeKey(member) === normalizeKey(gap.student),
          ),
      );
      expect({ ...gap, met }).toMatchObject({ met: false });
    }
    expect(plan.violations.some((v) => v.ruleId === "lead-sees-weekly")).toBe(
      plan.leadGaps.length > 0,
    );
  });

  test("where the lead provider did meet the group, it is marked", () => {
    const leadSessions = plan.placements.filter((p) => p.isLeadSession);
    expect(leadSessions.length).toBeGreaterThan(0);
    for (const session of leadSessions) {
      const leads = session.members
        .map((member) =>
          input.requirements.find(
            (requirement) =>
              normalizeKey(requirement.student) === normalizeKey(member) &&
              normalizeKey(requirement.service) ===
                normalizeKey(session.service) &&
              requirement.model === session.model,
          ),
        )
        .filter(Boolean)
        .map((row) => normalizeKey(row!.leadProvider));
      expect(leads).toContain(normalizeKey(session.staff));
    }
  });
});

describe("groups", () => {
  test("a group only forms where its members share enough free time", () => {
    for (const group of plan.groups) {
      expect(
        group.sharedWindows.some(
          (window) => window.end - window.start >= group.sessionLength,
        ),
      ).toBe(true);
    }
  });

  test("a push-in group meets in one classroom", () => {
    for (const group of plan.groups) {
      if (group.model !== "Push-In") continue;
      const rooms = new Set(
        group.members.map(
          (member) =>
            input.students.find(
              (student) => normalizeKey(student.name) === normalizeKey(member),
            )?.classKey,
        ),
      );
      expect(rooms.size).toBe(1);
    }
  });

  test("every placement belongs to a group and books its whole membership", () => {
    for (const placement of plan.placements) {
      const group = plan.groups.find(
        (entry) => entry.id === placement.groupId,
      )!;
      expect(group).toBeDefined();
      expect(placement.members).toEqual(group.members);
      expect(placement.end - placement.start).toBe(group.sessionLength);
    }
  });
});
