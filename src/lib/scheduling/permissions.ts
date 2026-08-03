import { normalizeKey } from "./parse";
import type {
  ClassBlock,
  DeliveryModel,
  ServiceDefinition,
  ServiceMatch,
  ServiceRequirement,
} from "./types";

/**
 * Service Matches is the only authority on when a service may be delivered: a
 * service may displace a classroom block if — and only if — the sheet lists
 * that block's subject for the service and delivery model. Recess, Specials,
 * Lunch and Out of School need no special case; nothing lists them.
 */
export interface EligibilityIndex {
  /** "service|model" -> the subject keys that service may displace. */
  bySubject: Map<string, Set<string>>;
  /** Subjects some service may displace, for the "is this block pullable" grid. */
  anyService: Set<string>;
}

function indexKey(service: string, model: DeliveryModel): string {
  return `${normalizeKey(service)}|${model}`;
}

export function buildEligibility(matches: ServiceMatch[]): EligibilityIndex {
  const bySubject = new Map<string, Set<string>>();
  const anyService = new Set<string>();

  for (const match of matches) {
    const key = indexKey(match.service, match.model);
    const subjects = bySubject.get(key) ?? new Set<string>();
    for (const subject of match.subjects) {
      subjects.add(normalizeKey(subject));
      anyService.add(normalizeKey(subject));
    }
    bySubject.set(key, subjects);
  }

  return { bySubject, anyService };
}

export function buildDefinitionIndex(
  definitions: ServiceDefinition[],
): Map<string, ServiceDefinition> {
  return new Map(
    definitions.map((definition) => [
      normalizeKey(definition.service),
      definition,
    ]),
  );
}

/**
 * Could any service at all displace this block? This is what colours the
 * availability grid, which is not about one particular service.
 */
export function isPullable(
  block: ClassBlock,
  index: EligibilityIndex,
): boolean {
  // Older workbooks answer this directly with a "Service Possible" column.
  if (block.servicePossible != null) return block.servicePossible;
  return index.anyService.has(normalizeKey(block.subject));
}

/** May this requirement be delivered during this block? */
export function canServe(
  block: ClassBlock,
  requirement: ServiceRequirement,
  index: EligibilityIndex,
  definitions: Map<string, ServiceDefinition>,
): boolean {
  const subjects = index.bySubject.get(
    indexKey(requirement.service, requirement.model),
  );
  if (!subjects?.has(normalizeKey(block.subject))) return false;

  // Where a definition exists it must agree that the service supports this
  // delivery model; a missing definition is not treated as a veto.
  const definition = definitions.get(normalizeKey(requirement.service));
  if (definition) {
    if (requirement.model === "Pull-Out" && !definition.pullOut) return false;
    if (requirement.model === "Push-In" && !definition.pushIn) return false;
  }

  return true;
}
