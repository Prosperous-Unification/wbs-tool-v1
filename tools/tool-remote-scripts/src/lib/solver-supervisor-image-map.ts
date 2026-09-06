import type { BackendContainerIdentity } from './solver-supervisor-docker-output';

const DIGEST_PINNED_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;
const CALLER_NAMES = ['be-01-blue', 'be-01-green', 'wbs-dev-src'] as const;
const RULE_KEYS = ['callerName', 'callerImage', 'solverImage'] as const;

export interface SupervisorImageRule {
  readonly callerName: string;
  /** Exact for prod colours; null only for the contract-checked dev source container. */
  readonly callerImage: string | null;
  readonly solverImage: string;
}

export interface SupervisorImagePolicy {
  readonly allowedNamePatterns: readonly RegExp[];
  imageFor(identity: BackendContainerIdentity): string;
}

function defect(message: string): Error {
  return new Error(`solver supervisor image map: ${message}`);
}

function recordOf(value: unknown, index: number): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw defect(`rule ${String(index)} is not an object`);
  }
  return value as Record<string, unknown>;
}

function decodeRule(value: unknown, index: number): SupervisorImageRule {
  const rule = recordOf(value, index);
  const unknown = Object.keys(rule).filter((key) => !RULE_KEYS.includes(key as never));
  if (unknown.length > 0)
    throw defect(`rule ${String(index)} has unknown key ${unknown.sort()[0]}`);
  const missing = RULE_KEYS.filter((key) => !Object.hasOwn(rule, key));
  if (missing.length > 0) throw defect(`rule ${String(index)} has missing key ${missing[0]}`);

  const callerName = rule['callerName'];
  if (typeof callerName !== 'string' || !CALLER_NAMES.includes(callerName as never)) {
    throw defect(`rule ${String(index)} has unsupported callerName`);
  }
  const solverImage = rule['solverImage'];
  if (typeof solverImage !== 'string' || !DIGEST_PINNED_IMAGE.test(solverImage)) {
    throw defect(`rule ${String(index)} solverImage is not digest-pinned`);
  }
  const callerImage = rule['callerImage'];
  if (callerName === 'wbs-dev-src') {
    if (callerImage !== null) throw defect('wbs-dev-src callerImage must be null');
  } else if (typeof callerImage !== 'string' || !DIGEST_PINNED_IMAGE.test(callerImage)) {
    throw defect(`rule ${String(index)} callerImage is not digest-pinned`);
  }
  return { callerName, callerImage, solverImage };
}

function exactNamePattern(name: string): RegExp {
  return new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

/** Decodes host-owned rules once and returns the only runtime image authority. */
export function supervisorImagePolicy(value: unknown): SupervisorImagePolicy {
  if (!Array.isArray(value) || value.length === 0) throw defect('rules must be a non-empty array');
  const rules = value.map(decodeRule);
  const names = rules.map((rule) => rule.callerName);
  if (new Set(names).size !== names.length) throw defect('rules contain a duplicate callerName');
  const byName = new Map(rules.map((rule) => [rule.callerName, rule] as const));

  return {
    allowedNamePatterns: names.map(exactNamePattern),
    imageFor(identity) {
      const rule = byName.get(identity.name);
      if (rule === undefined) throw defect(`no rule for authenticated caller ${identity.name}`);
      if (rule.callerImage !== null && rule.callerImage !== identity.image) {
        // Proof: solver-supervisor-image-map.test.ts presents a different valid
        // digest for the allowed blue name and requires refusal before spawn.
        throw defect(`authenticated caller ${identity.name} image does not match its mapping`);
      }
      return rule.solverImage;
    },
  };
}
