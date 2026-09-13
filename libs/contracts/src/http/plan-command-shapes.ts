import { type } from 'arktype';

import { commandDefinitions } from '../commands/definitions';
import { requestSchema } from './schema-shape';

/**
 * Structural wire commands, before the backend parser supplies defaults or checks
 * dates, numeric bounds, names and references. Directory batches intentionally
 * accept this same union so project_required retains the original command index.
 */
const command = type.or(
  ...Object.values(commandDefinitions).map((definition) => definition.schema),
);

/** Strict standalone command validation; derived numbering is never a writable property. */
export const planCommandSchema = requestSchema(command);

/** The batch cap belongs after semantic parsing; this declaration neither caps nor normalizes commands. */
// Proof: adding maxLength200 failed the 201-command structural control; the parser owns precedence.
const commandsBody = type({ commands: command.array() });
// Proof: bypassing deep strict validation lost invalid_body in the mounted structural-extra case.
export const planCommandsBody = requestSchema(commandsBody);

/** A command exactly as it appeared on the wire, including optional fields absent before normalization. */
export type { PlanCommandWire } from '../commands/definitions';
// Proof: replacing the derived batch with commands:unknown[] made its type-negative fixture report TS2578.
export type PlanCommandsBody = typeof commandsBody.infer;
