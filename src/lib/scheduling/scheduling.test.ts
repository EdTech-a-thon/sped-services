import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  buildCandidatePool,
  checkCompatibility,
  findPartners,
  isCompatible,
  previewGroup,
} from "./explain";
import { normalizeKey, parseWorkbook, tokenizeSubjects } from "./parse";
import { buildEligibility, canServe } from "./permissions";
import { buildPlan } from "./plan";
import { buildWeekWindows, buildWindowContext } from "./windows";
import {
  DAYS,
  type Candidate,
  type ClassBlock,
  type RuleSettings,
  type ServiceRequirement,
} from "./types";

const WORKBOOK = "Service Scheduler Template.xlsx";

const input = await parseWorkbook(
  new Blob([await readFile(WORKBOOK)]),
  WORKBOOK,
);

const kCave = input.classes.kcave;

function subjectAt(day: keyof typeof kCave, start: number): string {
  return kCave[day].find((block) => block.start === start)?.subject ?? "";
}

describe("merged day cells", () => {
  // The class sheets merge a subject across the days it repeats on. Exporting
  // to CSV flattens that to the first day only; ExcelJS reports the master's
  // value for every cell in the range, and the parser has to keep it that way.
  test("a subject merged across Tuesday and Wednesday lands on both", () => {
    const noon = 12 * 60;
    expect(subjectAt("Monday", noon)).toBe("Math Co-Teach");
    expect(subjectAt("Tuesday", noon)).toBe("Specials");
    expect(subjectAt("Wednesday", noon)).toBe("Specials");
    expect(subjectAt("Thursday", noon)).toBe("Math Co-Teach");
    expect(subjectAt("Friday", noon)).toBe("Math Co-Teach");
  });

  test("a subject merged Monday-Thursday leaves Friday alone", () => {
    const afterNoon = 12 * 60 + 45;
    expect(subjectAt("Monday", afterNoon)).toBe("Math MTSS");
    expect(subjectAt("Thursday", afterNoon)).toBe("Math MTSS");
    expect(subjectAt("Friday", afterNoon)).toBe("Dismissal");
  });

  test("every class has a full week of blocks", () => {
    for (const schedule of Object.values(input.classes)) {
      expect(schedule.Monday.length).toBeGreaterThan(0);
      expect(schedule.Friday.length).toBe(schedule.Monday.length);
    }
  });
});

describe("Service Matches subject lists", () => {
  // One of the real subjects is literally "SEL, Reading, or Math Facts", so a
  // naive split on "," shreds it into three subjects that do not exist.
  test("keeps a subject name that contains commas intact", () => {
    expect(
      tokenizeSubjects(
        'Morning Meeting, SEL/Misc, "SEL, Reading, or Math Facts", Cafeteria',
        input.subjects,
      ),
    ).toEqual([
      "Morning Meeting",
      "SEL/Misc",
      "SEL, Reading, or Math Facts",
      "Cafeteria",
    ]);
  });

  test("prefers the longest matching subject over the names inside it", () => {
    expect(tokenizeSubjects("Reading MTSS", input.subjects)).toEqual([
      "Reading MTSS",
    ]);
    expect(tokenizeSubjects("Science/Social Studies", input.subjects)).toEqual([
      "Science/Social Studies",
    ]);
  });

  test("an empty list yields nothing rather than a bogus subject", () => {
    expect(tokenizeSubjects("", input.subjects)).toEqual([]);
  });
});

describe("eligibility", () => {
  const eligibility = buildEligibility(input.serviceMatches);
  const definitions = new Map(
    input.serviceDefinitions.map((definition) => [
      definition.service.toLowerCase().replace(/[^a-z0-9]/g, ""),
      definition,
    ]),
  );

  const block = (subject: string): ClassBlock => ({
    day: "Monday",
    start: 0,
    end: 30,
    subject,
    servicePossible: null,
  });

  const requirement = (
    service: string,
    model: ServiceRequirement["model"] = "Pull-Out",
  ): ServiceRequirement => ({
    student: "Alex",
    service,
    minutesPerWeek: 60,
    sessionLength: 30,
    sessionsPerWeek: 2,
    providers: ["Panzer"],
    leadProvider: "Panzer",
    alternateProviders: [],
    canParaLead: false,
    paraSupports: false,
    model,
    groupType: "Small Group",
  });

  const allows = (service: string, subject: string) =>
    canServe(block(subject), requirement(service), eligibility, definitions);

  test("a service may displace a subject Service Matches lists for it", () => {
    expect(allows("Writing", "Science/Social Studies")).toBe(true);
    expect(allows("Reading MTSS", "Reading MTSS")).toBe(true);
    expect(allows("Social", "SEL, Reading, or Math Facts")).toBe(true);
  });

  test("a service may not displace a subject it is not listed against", () => {
    expect(allows("Writing", "Reading MTSS")).toBe(false);
    expect(allows("Reading MTSS", "Writing")).toBe(false);
  });

  test("protected parts of the day are never eligible", () => {
    for (const subject of ["Lunch", "Recess", "Specials", "Out of School"]) {
      for (const service of ["Writing", "Reading MTSS", "Behavior", "Social"]) {
        expect(allows(service, subject)).toBe(false);
      }
    }
  });
});

describe("windows", () => {
  const context = buildWindowContext(
    input,
    buildEligibility(input.serviceMatches),
  );

  const find = (student: string, service: string) => {
    const requirement = input.requirements.find(
      (candidate) =>
        candidate.student === student && candidate.service === service,
    );
    if (!requirement) throw new Error(`no ${service} row for ${student}`);
    return requirement;
  };

  test("adjacent eligible blocks merge into one longer window", () => {
    // Behavior may displace both Cafeteria (7:30-8:00) and Morning Meeting
    // (8:00-8:30). Treated separately they are two half-hours; merged they are
    // the single hour they actually are, which is what lets a session longer
    // than either block fit.
    const requirement = find("Alex", "Behavior");

    const { windows } = buildWeekWindows(requirement, context);
    const morning = windows.find(
      (window) => window.day === "Monday" && window.start === 7 * 60 + 30,
    );
    expect(morning).toBeDefined();
    expect(morning!.end).toBe(8 * 60 + 30);
    expect(morning!.subjects).toEqual(["Cafeteria", "Morning Meeting"]);
  });

  test("a window is only offered when the session actually fits", () => {
    const requirement = find("Alex", "Behavior");
    for (const window of buildWeekWindows(requirement, context).windows) {
      expect(window.end - window.start).toBeGreaterThanOrEqual(
        requirement.sessionLength,
      );
    }
  });

  test("outside bookings are carved out of the windows", () => {
    const requirement = find("Kate", "Writing");
    const { windows } = buildWeekWindows(requirement, context);
    const clashes = input.services.filter(
      (session) =>
        session.student === "Kate" &&
        windows.some(
          (window) =>
            window.day === session.day &&
            window.start < session.end &&
            window.end > session.start,
        ),
    );
    expect(clashes).toEqual([]);
  });
});

describe("plan", () => {
  const plan = buildPlan(input, "Panzer");

  test("no placement double-books the provider", () => {
    for (const day of DAYS) {
      const today = plan.placements
        .filter((placement) => placement.day === day)
        .sort((a, b) => a.start - b.start);
      for (let i = 1; i < today.length; i++) {
        expect(today[i].start).toBeGreaterThanOrEqual(today[i - 1].end);
      }
    }
  });

  test("no placement double-books a student", () => {
    const seen = new Map<string, { start: number; end: number }[]>();
    for (const placement of plan.placements) {
      for (const member of placement.members) {
        const key = `${member}|${placement.day}`;
        const list = seen.get(key) ?? [];
        for (const other of list) {
          expect(
            placement.start >= other.end || placement.end <= other.start,
          ).toBe(true);
        }
        list.push(placement);
        seen.set(key, list);
      }
    }
  });

  test("a student is never pulled from a block the service cannot displace", () => {
    const eligibility = buildEligibility(input.serviceMatches);
    for (const placement of plan.placements) {
      const allowed = eligibility.bySubject.get(
        `${normalizeKey(placement.service)}|${placement.model}`,
      );
      for (const subject of placement.subject.split(" / ")) {
        expect(allowed?.has(normalizeKey(subject))).toBe(true);
      }
    }
  });

  test("consecutive pull-out sessions leave rule 10's transition time", () => {
    for (const day of DAYS) {
      const today = plan.placements
        .filter((placement) => placement.day === day)
        .sort((a, b) => a.start - b.start);
      for (let i = 1; i < today.length; i++) {
        expect(today[i].start - today[i - 1].end).toBeGreaterThanOrEqual(
          plan.settings.pullOutTransitionMinutes,
        );
      }
    }
  });

  test("the provider stays inside rule 8's minute cap", () => {
    expect(plan.capacity.scheduledMinutesPerWeek).toBeLessThanOrEqual(
      plan.settings.maxMinutesPerWeek,
    );
  });

  test("prescribed minutes are reported, never quietly reduced", () => {
    for (const row of plan.compliance) {
      expect(row.requiredMinutes).toBeGreaterThan(0);
      expect(row.difference).toBe(row.scheduledMinutes - row.requiredMinutes);
      if (row.scheduledMinutes < row.requiredMinutes) {
        expect(row.status).not.toBe("OK");
      }
    }
  });

  test("every shortfall carries a reason", () => {
    for (const row of plan.unplaced) {
      expect(Object.keys(row.reasons).length).toBeGreaterThan(0);
    }
  });
});

describe("explaining who may group with whom", () => {
  const plan = buildPlan(input, "Panzer");
  const settings = plan.settings;
  const pool = buildCandidatePool(input);

  const pick = (student: string, service: string) => {
    const candidate = pool.find(
      (entry) =>
        entry.student.name === student && entry.requirement.service === service,
    );
    if (!candidate) throw new Error(`no ${service} row for ${student}`);
    return candidate;
  };

  const checkFor = (
    group: Candidate[],
    candidate: Candidate,
    label: string,
    overrides?: Partial<RuleSettings>,
  ) => {
    const check = checkCompatibility(group, candidate, {
      ...settings,
      ...overrides,
    }).find((entry) => entry.label === label);
    if (!check) throw new Error(`no "${label}" check`);
    return check;
  };

  // The whole point of the explanation is that it cannot drift from the
  // behaviour: every group the planner actually built must survive the checks
  // the UI shows, member by member.
  test("the checks agree with every group the planner built", () => {
    for (const group of plan.groups) {
      const members = group.members.map((member) =>
        pick(member, group.service),
      );
      for (let i = 1; i < members.length; i++) {
        const checks = checkCompatibility(
          members.slice(0, i),
          members[i],
          settings,
        );
        expect(checks.filter((check) => check.status === "fail")).toEqual([]);
      }
    }
  });

  test("two students one grade apart with the same session length may group", () => {
    // Alex and Eloise both need 30-minute Behavior and are one grade apart, so
    // every rule that could separate them passes.
    const alex = pick("Alex", "Behavior");
    const eloise = pick("Eloise", "Behavior");

    expect(checkFor([alex], eloise, "Grade span").status).toBe("pass");
    expect(checkFor([alex], eloise, "Session length span").status).toBe("pass");
    expect(checkFor([alex], eloise, "Shared free time").status).toBe("pass");
    expect(isCompatible([alex], eloise, settings)).toBe(true);
  });

  test("a grade-span block names the knob that would unblock it", () => {
    const eloise = pick("Eloise", "Behavior"); // 1 Clayton
    const bennett = pick("Bennett", "Behavior"); // 3 Harris

    const blocked = checkFor([eloise], bennett, "Grade span");
    expect(blocked.status).toBe("fail");
    expect(blocked.setting).toBe("gradeDeltaGenEd");
    expect(blocked.rule).toBe(3);
    expect(isCompatible([eloise], bennett, settings)).toBe(false);

    // Widening exactly that knob is enough; nothing else was in the way.
    const loosened = { gradeDeltaGenEd: 2 };
    expect(checkFor([eloise], bennett, "Grade span", loosened).status).toBe(
      "pass",
    );
    expect(isCompatible([eloise], bennett, { ...settings, ...loosened })).toBe(
      true,
    );
  });

  test("whole-group services report the small-group limits as not applying", () => {
    const caroline = pick("Caroline", "Reading MTSS"); // 3 Harris, Whole Group
    const hannah = pick("Hannah", "Reading MTSS"); // 2 Pryor

    for (const label of ["Group size", "Session length span", "Grade span"]) {
      expect(checkFor([caroline], hannah, label).status).toBe("n/a");
    }
    expect(checkFor([caroline], hannah, "Shared free time").status).toBe(
      "pass",
    );
  });

  test("a partner list explains everyone, eligible or not", () => {
    const alex = pick("Alex", "Behavior");
    const partners = findPartners(alex, [], pool, settings);

    // Everyone else prescribed Behavior appears, nobody silently dropped.
    expect(partners.map((partner) => partner.candidate.student.name).sort()) //
      .toEqual(["Bennett", "Eloise", "Franklin", "Lola"]);
    for (const partner of partners) {
      expect(partner.eligible).toBe(partner.blockers.length === 0);
      for (const blocker of partner.blockers) {
        expect(blocker.detail).not.toBe("");
      }
    }
  });

  test("adding a partner never widens the group's usable time", () => {
    const eloise = pick("Eloise", "Behavior");
    const lola = pick("Lola", "Behavior");

    const alone = previewGroup(eloise, []);
    const paired = previewGroup(eloise, [lola]);

    expect(paired.sharedWindows.length).toBeLessThanOrEqual(
      alone.sharedWindows.length,
    );
    // And what is left is genuinely time Eloise was already free for.
    for (const window of paired.sharedWindows) {
      expect(
        alone.ownWindows.some(
          (own) =>
            own.day === window.day &&
            own.start <= window.start &&
            own.end >= window.end,
        ),
      ).toBe(true);
    }
  });

  test("a previewed window is always long enough to hold the session", () => {
    const preview = previewGroup(pick("Kate", "Writing"), [
      pick("Jackie", "Writing"),
    ]);
    for (const window of preview.sharedWindows) {
      expect(window.end - window.start).toBeGreaterThanOrEqual(
        preview.sessionLength,
      );
    }
    for (const window of preview.tooShort) {
      expect(window.end - window.start).toBeLessThan(preview.sessionLength);
    }
  });
});
