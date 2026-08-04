import { normalizeKey } from "./parse";
import { deriveCapacity } from "./rules";
import {
  isParapro,
  isSlcTeacher,
  preferredGrades,
  type TeamSettings,
} from "./teamRules";
import type { WindowContext } from "./windows";
import {
  DAYS,
  emptyClassSchedule,
  type Day,
  type Group,
  type Placement,
  type ServiceRequirement,
  type StaffEvent,
  type StaffMember,
  type UnplacedReason,
  type Window,
} from "./types";

/** How finely a session may be nudged inside its window. */
const STEP_MINUTES = 5;

/** The pull-out room. Push-in sessions are located by class key instead. */
export const SPED_ROOM = "sped";

export interface TeamPlacement extends Placement {
  /** Who leads this session. */
  staff: string;
  /** Parapros holding the room alongside the leader, filled in at the end. */
  supportStaff: string[];
  /** Class key for push-in, `SPED_ROOM` for pull-out. */
  location: string;
  /** True when this is the session that satisfies the lead-provider rule. */
  isLeadSession: boolean;
}

interface Busy {
  start: number;
  end: number;
  location: string;
}

export interface TeamPlacementResult {
  placements: TeamPlacement[];
  failures: Map<string, Partial<Record<UnplacedReason, number>>>;
  /** Everything each staff member is committed to, sessions and coverage alike. */
  staffBusy: Map<string, Map<Day, Busy[]>>;
  /** When anything at all is happening in the pull-out room. */
  slcRoomBusy: Map<Day, Busy[]>;
}

function overlaps(
  a: { start: number; end: number },
  start: number,
  end: number,
) {
  return a.start < end && a.end > start;
}

/**
 * Pull-out needs transition time either side, because students walk to the SPED
 * room and back. Push-in that stays in the same classroom does not — nobody
 * moves, so no gap is needed.
 */
function clashes(
  busy: Busy[],
  start: number,
  end: number,
  location: string,
  transition: number,
): boolean {
  return busy.some((entry) => {
    const sameRoom = entry.location === location && location !== SPED_ROOM;
    const gap = sameRoom ? 0 : transition;
    return overlaps(entry, start - gap, end + gap);
  });
}

function record(
  failures: Map<string, Partial<Record<UnplacedReason, number>>>,
  groupId: string,
  reason: UnplacedReason,
) {
  const counts = failures.get(groupId) ?? {};
  counts[reason] = (counts[reason] ?? 0) + 1;
  failures.set(groupId, counts);
}

/** The classroom subject a placement displaces, read off the first member. */
function subjectAt(
  group: Group,
  day: Day,
  start: number,
  end: number,
  context: WindowContext,
): string {
  const student = context.studentsByKey.get(normalizeKey(group.members[0]));
  if (!student) return "";
  const schedule = context.classes[student.classKey] ?? emptyClassSchedule();
  const names = schedule[day]
    .filter((block) => block.start < end && block.end > start)
    .map((block) => block.subject);
  return [...new Set(names)].join(" / ");
}

/** Push-in happens in the members' own room, which is only stable if they share one. */
function groupLocation(group: Group, context: WindowContext): string {
  if (group.model !== "Push-In") return SPED_ROOM;
  const keys = new Set(
    group.members
      .map(
        (member) => context.studentsByKey.get(normalizeKey(member))?.classKey,
      )
      .filter(Boolean) as string[],
  );
  return keys.size === 1 ? [...keys][0] : SPED_ROOM;
}

/**
 * "During MTSS, the resource room is utilized as a whole-group instructional
 * period, not small groups" — so an MTSS whole group owns the room outright.
 */
function isMtssWholeGroup(group: Group): boolean {
  return group.groupType === "Whole Group" && /mtss/i.test(group.service);
}

/* ---------- per-group facts ---------- */

interface GroupPlan {
  group: Group;
  /** Distinct lead providers across the group's members. */
  leads: string[];
  /** Everyone allowed to lead a session of it: leads plus shared alternates. */
  eligible: string[];
  /** Only true when every member's row allows a parapro to lead. */
  canParaLead: boolean;
  location: string;
  mtss: boolean;
  /** Grades in the group, for the parapro preference. */
  grades: number[];
  placed: number;
  usedDays: Set<Day>;
  /** Leads who have taken their weekly session. */
  leadsMet: Set<string>;
}

function requirementFor(
  requirements: ServiceRequirement[],
  group: Group,
  member: string,
): ServiceRequirement | undefined {
  return requirements.find(
    (requirement) =>
      normalizeKey(requirement.student) === normalizeKey(member) &&
      normalizeKey(requirement.service) === normalizeKey(group.service) &&
      requirement.model === group.model &&
      requirement.groupType === group.groupType,
  );
}

function buildGroupPlans(
  groups: Group[],
  requirements: ServiceRequirement[],
  context: WindowContext,
): GroupPlan[] {
  return groups.map((group) => {
    const rows = group.members
      .map((member) => requirementFor(requirements, group, member))
      .filter(Boolean) as ServiceRequirement[];

    const leads = [
      ...new Map(
        rows.map((row) => [normalizeKey(row.leadProvider), row.leadProvider]),
      ).values(),
    ].filter(Boolean);

    // Everyone who may lead a session for the whole group has to be named on
    // every member's row — that is what "only provide services assigned to them
    // in the Minutes tab" means once students are grouped.
    const eligible = rows.length
      ? rows
          .map((row) => row.providers)
          .reduce((shared, providers) =>
            shared.filter((name) =>
              providers.some(
                (other) => normalizeKey(other) === normalizeKey(name),
              ),
            ),
          )
      : [];

    return {
      group,
      leads,
      eligible,
      canParaLead: rows.length > 0 && rows.every((row) => row.canParaLead),
      location: groupLocation(group, context),
      mtss: isMtssWholeGroup(group),
      grades: group.members
        .map((member) => context.studentsByKey.get(normalizeKey(member))?.grade)
        .filter((grade): grade is number => grade != null),
      placed: 0,
      usedDays: new Set<Day>(),
      leadsMet: new Set<string>(),
    };
  });
}

/**
 * The times a staff member is the only person who could possibly lead a group.
 *
 * Lunch is placed before sessions are, so without this it can land on the one
 * window somebody's sole assignment could ever run in — and that assignment
 * then has nowhere to go all week.
 */
export function soleProviderWindows(
  groups: Group[],
  requirements: ServiceRequirement[],
): Map<string, Window[]> {
  const critical = new Map<string, Window[]>();

  for (const group of groups) {
    const rows = group.members
      .map((member) => requirementFor(requirements, group, member))
      .filter(Boolean) as ServiceRequirement[];
    if (!rows.length) continue;

    const shared = rows
      .map((row) => row.providers)
      .reduce((names, providers) =>
        names.filter((name) =>
          providers.some((other) => normalizeKey(other) === normalizeKey(name)),
        ),
      );
    if (shared.length !== 1) continue;

    const key = normalizeKey(shared[0]);
    critical.set(key, [...(critical.get(key) ?? []), ...group.sharedWindows]);
  }

  return critical;
}

/* ---------- the search ---------- */

interface State {
  staffBusy: Map<string, Map<Day, Busy[]>>;
  staffDayMinutes: Map<string, Map<Day, number>>;
  staffWeekMinutes: Map<string, number>;
  studentBusy: Map<string, Busy[]>;
  /** Anything at all in the pull-out room, so supervision can be checked. */
  slcRoomBusy: Map<Day, Busy[]>;
  /** Parapro-led pull-out, which the SLC teacher may not walk out on. */
  paraPullOut: Map<Day, Busy[]>;
  /** The SLC teacher, if this workbook has one. */
  slc: StaffMember | undefined;
  /** Whole-group MTSS, which owns the room while it runs. */
  mtssBusy: Map<Day, Busy[]>;
  caps: Map<string, { day: number; week: number }>;
  byName: Map<string, StaffMember>;
}

const studentKey = (name: string, day: Day) => `${normalizeKey(name)}|${day}`;

function buildState(
  staff: StaffMember[],
  coverage: StaffEvent[],
  context: WindowContext,
): State {
  const state: State = {
    staffBusy: new Map(),
    staffDayMinutes: new Map(),
    staffWeekMinutes: new Map(),
    studentBusy: new Map(),
    slcRoomBusy: new Map(DAYS.map((day) => [day, [] as Busy[]])),
    paraPullOut: new Map(DAYS.map((day) => [day, [] as Busy[]])),
    slc: staff.find(isSlcTeacher),
    mtssBusy: new Map(DAYS.map((day) => [day, [] as Busy[]])),
    caps: new Map(),
    byName: new Map(),
  };

  for (const member of staff) {
    const key = normalizeKey(member.name);
    state.byName.set(key, member);
    state.staffBusy.set(key, new Map(DAYS.map((day) => [day, [] as Busy[]])));
    state.staffDayMinutes.set(key, new Map(DAYS.map((day) => [day, 0])));
    state.staffWeekMinutes.set(key, 0);
    const capacity = deriveCapacity(member);
    state.caps.set(key, {
      day: capacity.maxMinutesPerDay,
      week: capacity.maxMinutesPerWeek,
    });
  }

  // Lunches and breaks are commitments like any other.
  for (const event of coverage) {
    state.staffBusy
      .get(normalizeKey(event.staff))
      ?.get(event.day)
      ?.push({ start: event.start, end: event.end, location: "off" });
  }

  // Outside providers already own part of each student's week.
  for (const [key, sessions] of context.bookings) {
    state.studentBusy.set(
      key,
      sessions.map((session) => ({
        start: session.start,
        end: session.end,
        location: "outside",
      })),
    );
  }

  return state;
}

interface Slot {
  day: Day;
  start: number;
  score: number;
}

/**
 * Is the SLC teacher in the pull-out room for this whole stretch?
 *
 * She is, unless she is off the clock, on her lunch or break, or pushing into a
 * general education classroom. This is what a parapro-led group needs, and it
 * is also the thing her own lunch has to be placed around.
 */
function slcPresent(
  state: State,
  day: Day,
  start: number,
  end: number,
): boolean {
  const slc = state.slc;
  if (!slc) return false;
  if (slc.startMinutes != null && start < slc.startMinutes) return false;
  if (slc.endMinutes != null && end > slc.endMinutes) return false;

  const own = state.staffBusy.get(normalizeKey(slc.name))?.get(day) ?? [];
  return !own.some(
    (span) => span.location !== SPED_ROOM && overlaps(span, start, end),
  );
}

/**
 * The best time this group could meet with this staff member leading, or null.
 *
 * Every hard rule is a `continue` here rather than a filter afterwards, so a
 * rejected slot always records why — that is what fills the "not scheduled"
 * report with something a teacher can act on.
 */
function findSlot(
  entry: GroupPlan,
  staffName: string,
  asLead: boolean,
  state: State,
  settings: TeamSettings,
  failures: Map<string, Partial<Record<UnplacedReason, number>>>,
): Slot | null {
  const { group } = entry;
  const key = normalizeKey(staffName);
  const member = state.byName.get(key);
  if (!member) return null;

  const parapro = isParapro(member);
  // "Can Para Lead?" asks whether a parapro may cover for the provider who owns
  // the row. It says nothing about a parapro who *is* that provider — some
  // push-in support is assigned to a parapro outright, and they may run it.
  if (parapro && !asLead && !entry.canParaLead) return null;
  if (parapro && group.members.length > settings.paraMaxGroupSize) return null;

  const busy = state.staffBusy.get(key);
  const cap = state.caps.get(key);
  if (!busy || !cap) return null;

  const weekMinutes = state.staffWeekMinutes.get(key) ?? 0;
  const grades = preferredGrades(member);
  const preferred =
    grades && entry.grades.length
      ? entry.grades.every((grade) => grades.includes(grade))
      : false;

  let best: Slot | null = null;

  for (const window of group.sharedWindows) {
    const latest = window.end - group.sessionLength;
    for (let start = window.start; start <= latest; start += STEP_MINUTES) {
      const end = start + group.sessionLength;

      // The staff member has to actually be at work.
      if (member.startMinutes != null && start < member.startMinutes) continue;
      if (member.endMinutes != null && end > member.endMinutes) continue;

      if (weekMinutes + group.sessionLength > cap.week) {
        record(failures, group.id, "Provider minute cap reached");
        continue;
      }
      const dayMinutes = state.staffDayMinutes.get(key)?.get(window.day) ?? 0;
      if (dayMinutes + group.sessionLength > cap.day) {
        record(failures, group.id, "Provider minute cap reached");
        continue;
      }

      const own = busy.get(window.day) ?? [];
      if (
        own.some(
          (span) => span.location === "off" && overlaps(span, start, end),
        )
      ) {
        record(failures, group.id, "Staff on lunch or break");
        continue;
      }
      if (
        clashes(
          own,
          start,
          end,
          entry.location,
          settings.pullOutTransitionMinutes,
        )
      ) {
        record(failures, group.id, "Provider already busy");
        continue;
      }

      // The other side of the supervision rule: the SLC teacher cannot take a
      // push-in that would walk her out of the room while a parapro is
      // instructing in it.
      if (
        entry.location !== SPED_ROOM &&
        state.slc &&
        key === normalizeKey(state.slc.name) &&
        (state.paraPullOut.get(window.day) ?? []).some((span) =>
          overlaps(span, start, end),
        )
      ) {
        record(failures, group.id, "Parapro needs the SLC teacher present");
        continue;
      }

      if (entry.location === SPED_ROOM) {
        // Whole-group MTSS owns the pull-out room while it runs.
        const mtss = state.mtssBusy.get(window.day) ?? [];
        if (mtss.some((span) => overlaps(span, start, end))) {
          record(failures, group.id, "Provider already busy");
          continue;
        }
        if (entry.mtss) {
          const room = state.slcRoomBusy.get(window.day) ?? [];
          if (room.some((span) => overlaps(span, start, end))) {
            record(failures, group.id, "Provider already busy");
            continue;
          }
        }

        // A parapro may only instruct while the SLC teacher is in the room.
        // "Present" is not "teaching this group" or even "teaching at all" —
        // the SLC room is where she works, so she is there for the whole day
        // apart from her lunch, her break, and any push-in that takes her to a
        // classroom. Requiring her to be mid-session would mean a parapro could
        // only ever run a group inside one of hers, which is both stricter than
        // the sheet says and the thing that leaves parapros idle.
        if (parapro && !slcPresent(state, window.day, start, end)) {
          record(failures, group.id, "Parapro needs the SLC teacher present");
          continue;
        }
      }

      const memberClash = group.members.some((student) =>
        (state.studentBusy.get(studentKey(student, window.day)) ?? []).some(
          (span) => overlaps(span, start, end),
        ),
      );
      if (memberClash) {
        record(failures, group.id, "Student already receiving another service");
        continue;
      }

      // Spread a group's sessions across the week, then prefer a parapro who
      // works with this grade, then settle ties towards the start of the week.
      const score =
        (entry.usedDays.has(window.day) ? 0 : 10_000) +
        (preferred ? 500 : 0) -
        DAYS.indexOf(window.day) * 10 -
        start / 100;
      if (!best || score > best.score) {
        best = { day: window.day, start, score };
      }
    }
  }

  return best;
}

function commit(
  entry: GroupPlan,
  staffName: string,
  slot: Slot,
  isLeadSession: boolean,
  state: State,
  context: WindowContext,
  placements: TeamPlacement[],
) {
  const { group } = entry;
  const key = normalizeKey(staffName);
  const end = slot.start + group.sessionLength;
  const span = { start: slot.start, end, location: entry.location };

  placements.push({
    groupId: group.id,
    service: group.service,
    model: group.model,
    members: group.members,
    day: slot.day,
    start: slot.start,
    end,
    subject: subjectAt(group, slot.day, slot.start, end, context),
    staff: staffName,
    supportStaff: [],
    location: entry.location,
    isLeadSession,
  });

  entry.placed += 1;
  entry.usedDays.add(slot.day);
  if (isLeadSession) entry.leadsMet.add(normalizeKey(staffName));

  state.staffBusy.get(key)?.get(slot.day)?.push(span);
  const dayMinutes = state.staffDayMinutes.get(key);
  dayMinutes?.set(
    slot.day,
    (dayMinutes.get(slot.day) ?? 0) + group.sessionLength,
  );
  state.staffWeekMinutes.set(
    key,
    (state.staffWeekMinutes.get(key) ?? 0) + group.sessionLength,
  );

  if (entry.location === SPED_ROOM) {
    state.slcRoomBusy.get(slot.day)?.push(span);
    if (isParapro(state.byName.get(key)!)) {
      state.paraPullOut.get(slot.day)?.push(span);
    }
    if (entry.mtss) state.mtssBusy.get(slot.day)?.push(span);
  }

  for (const student of group.members) {
    const busyKey = studentKey(student, slot.day);
    const list = state.studentBusy.get(busyKey) ?? [];
    list.push(span);
    state.studentBusy.set(busyKey, list);
  }
}

/* ---------- entry point ---------- */

export interface TeamPlacementRequest {
  groups: Group[];
  requirements: ServiceRequirement[];
  staff: StaffMember[];
  coverage: StaffEvent[];
  context: WindowContext;
  settings: TeamSettings;
}

/**
 * Place every group's sessions and decide who leads each one.
 *
 * Two passes, and the order between them carries a rule. A parapro may only
 * instruct while the SLC teacher is in the room, so the SLC teacher's own
 * sessions have to exist before there is anywhere for a parapro-led group to
 * go. Pass one therefore places each group's lead-provider session — which is
 * also what "the lead provider meets each student every week" asks for — and
 * pass two fills the rest of the week around them.
 *
 * Nothing here reduces a student's prescribed minutes; a session that will not
 * fit is dropped and reported.
 */
export function placeTeam(request: TeamPlacementRequest): TeamPlacementResult {
  const { groups, requirements, staff, coverage, context, settings } = request;
  const placements: TeamPlacement[] = [];
  const failures = new Map<string, Partial<Record<UnplacedReason, number>>>();
  const state = buildState(staff, coverage, context);
  const plans = buildGroupPlans(groups, requirements, context);

  const isSlc = (name: string) => {
    const member = state.byName.get(normalizeKey(name));
    return member ? isSlcTeacher(member) : false;
  };

  /* Pass one: the lead provider's own session, SLC teacher first so that the
     room is populated before any parapro needs supervising. */
  const leadOrder = [...plans].sort(
    (a, b) =>
      Number(b.leads.some(isSlc)) - Number(a.leads.some(isSlc)) ||
      Number(b.mtss) - Number(a.mtss) ||
      new Set(a.group.sharedWindows.map((w) => w.day)).size -
        new Set(b.group.sharedWindows.map((w) => w.day)).size ||
      b.group.sessionsPerWeek - a.group.sessionsPerWeek,
  );

  for (const entry of leadOrder) {
    // A group whose members have different leads owes each of them a session.
    const ordered = [...entry.leads].sort(
      (a, b) => Number(isSlc(b)) - Number(isSlc(a)),
    );
    for (const lead of ordered) {
      if (entry.placed >= entry.group.sessionsPerWeek) break;
      const slot = findSlot(entry, lead, true, state, settings, failures);
      if (!slot) {
        record(
          failures,
          entry.group.id,
          "Lead provider could not meet this group",
        );
        continue;
      }
      commit(entry, lead, slot, true, state, context, placements);
    }
  }

  /* Pass two: the rest of the week, round-robin so that heavily contested
     windows are shared out rather than claimed by whichever group ran first. */
  const rounds = Math.max(
    0,
    ...plans.map((plan) => plan.group.sessionsPerWeek),
  );

  for (let round = 0; round < rounds; round++) {
    for (const entry of leadOrder) {
      if (entry.placed >= entry.group.sessionsPerWeek) continue;

      const isPara = (name: string) => {
        const member = state.byName.get(normalizeKey(name));
        return member ? isParapro(member) : false;
      };
      const isLead = (name: string) =>
        entry.leads.some((lead) => normalizeKey(lead) === normalizeKey(name));

      // A lead who still owes this group their weekly session comes first —
      // usually because pass one could not place it.
      const owing = entry.leads.filter(
        (lead) => !entry.leadsMet.has(normalizeKey(lead)),
      );
      const rest = entry.eligible.filter(
        (name) =>
          !owing.some((lead) => normalizeKey(lead) === normalizeKey(name)),
      );

      /*
       * Once the lead has taken their one session, everyone else goes ahead of
       * them — parapros first.
       *
       * That session is the rule's whole demand: the lead introduces the
       * instruction once a week, and the repeats are the reinforcement a
       * parapro is there to give. Letting the lead keep winning the remaining
       * sessions is what starved the parapros, because the lead can be placed
       * anywhere while a parapro can only fit inside a session the lead is
       * already running. So this is a strict preference order, not a contest of
       * scores — the first person who can take it, takes it.
       */
      // Among parapros who could all take it, the one whose preferred grade
      // matches goes first, then whoever is least booked so far. Without the
      // second test the first name on the Minutes row takes everything and the
      // others stand idle — which also costs sessions, because one busy parapro
      // cannot be in two groups at once while three free ones look on.
      const paras = rest.filter(isPara).sort((a, b) => {
        const gradeFit = (name: string) => {
          const member = state.byName.get(normalizeKey(name));
          const grades = member ? preferredGrades(member) : null;
          if (!grades || !entry.grades.length) return 0;
          return entry.grades.every((grade) => grades.includes(grade)) ? 1 : 0;
        };
        const booked = (name: string) =>
          state.staffWeekMinutes.get(normalizeKey(name)) ?? 0;
        return gradeFit(b) - gradeFit(a) || booked(a) - booked(b);
      });

      const candidates = [
        ...owing,
        ...paras,
        ...rest.filter((name) => !isPara(name)),
      ];

      let chosen: { name: string; slot: Slot } | null = null;
      for (const name of candidates) {
        const slot = findSlot(
          entry,
          name,
          isLead(name),
          state,
          settings,
          failures,
        );
        if (slot) {
          chosen = { name, slot };
          break;
        }
      }

      if (!chosen) {
        if (!candidates.length) {
          record(failures, entry.group.id, "No qualified staff available");
        }
        // Deliberately not marked as hopeless. For a single provider the week
        // only ever gets fuller, but here a parapro-led group needs the SLC
        // teacher to be teaching — so a later round, with more of her sessions
        // placed, can open a slot this round had nowhere to put.
        continue;
      }

      const key = normalizeKey(chosen.name);
      const isLeadSession =
        !entry.leadsMet.has(key) &&
        entry.leads.some((lead) => normalizeKey(lead) === key);

      commit(
        entry,
        chosen.name,
        chosen.slot,
        isLeadSession,
        state,
        context,
        placements,
      );
    }
  }

  assignSupport(placements, requirements, staff, state, settings);

  return {
    placements,
    failures,
    staffBusy: state.staffBusy,
    slcRoomBusy: state.slcRoomBusy,
  };
}

/**
 * Fill in the "Para Supports" column after the fact.
 *
 * No rule on the sheet makes a support parapro a condition of running a
 * session, so this never blocks a placement — it names a parapro who is
 * genuinely free, and leaves the column empty when nobody is.
 */
function assignSupport(
  placements: TeamPlacement[],
  requirements: ServiceRequirement[],
  staff: StaffMember[],
  state: State,
  settings: TeamSettings,
) {
  const parapros = staff.filter(isParapro);
  if (!parapros.length) return;

  const wantsSupport = (placement: TeamPlacement) =>
    placement.members.some((member) => {
      const row = requirements.find(
        (requirement) =>
          normalizeKey(requirement.student) === normalizeKey(member) &&
          normalizeKey(requirement.service) ===
            normalizeKey(placement.service) &&
          requirement.model === placement.model,
      );
      return row?.paraSupports ?? false;
    });

  for (const placement of placements) {
    if (!wantsSupport(placement)) continue;
    const leader = normalizeKey(placement.staff);

    for (const parapro of parapros) {
      const key = normalizeKey(parapro.name);
      if (key === leader) continue;
      if (
        parapro.startMinutes != null &&
        placement.start < parapro.startMinutes
      ) {
        continue;
      }
      if (parapro.endMinutes != null && placement.end > parapro.endMinutes)
        continue;

      const own = state.staffBusy.get(key)?.get(placement.day) ?? [];
      if (
        clashes(
          own,
          placement.start,
          placement.end,
          placement.location,
          settings.pullOutTransitionMinutes,
        )
      ) {
        continue;
      }

      own.push({
        start: placement.start,
        end: placement.end,
        location: placement.location,
      });
      placement.supportStaff.push(parapro.name);
      break;
    }
  }
}
