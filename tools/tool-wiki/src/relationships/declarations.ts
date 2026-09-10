import { Buffer } from 'node:buffer';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';

import { parseOrThrow } from '@wbs/validation';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

import {
  RelationshipDeclaration,
  type RelationshipFact,
  type RelationshipRequest,
} from '../contracts/records';
import { hashCanonical } from '../evidence/content-manifest';
import type { CandidateSnapshot } from '../inventory/read-candidate';
import type { NxRelationships } from './nx';
import type { ExtractorIdentity } from './typescript';

type UnknownRecord = Record<string, unknown>;

interface FactProvenance {
  kind: 'declared' | 'extracted';
  declarationId: string;
  declarationPath: string;
  extractor: ExtractorIdentity;
}

interface ExtractedFact {
  factId: string;
  family: string;
  at: RelationshipFact['at'];
  selector: RelationshipFact;
  actual: unknown;
  provenance: FactProvenance;
  identity: string;
}

interface DeclaredEdge {
  relationshipId: string;
  kind: string;
  status: 'declared' | 'unresolved';
  source: unknown;
  target: unknown;
  reason?: string;
  provenance: FactProvenance;
  identity: string;
}

export interface DeclaredRelationships {
  coverage: { declarationId: string; scope: 'selected-facts-only'; families: string[] }[];
  facts: ExtractedFact[];
  edges: DeclaredEdge[];
  unresolved: { relationshipId: string; reason: string }[];
}

interface DeclarationSource {
  declaration: RelationshipDeclaration;
  path: string;
}

const compareText = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

function record(value: unknown, context: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  // The shape is checked immediately above at the parser boundary.
  return value as UnknownRecord;
}

function text(value: unknown, context: string): string {
  if (typeof value !== 'string') throw new Error(`${context} must be text`);
  return value;
}

function parseJson(bytes: Uint8Array, context: string): unknown {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${context} malformed: invalid UTF-8: ${detail}`, { cause });
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${context} malformed: ${detail}`, { cause });
  }
}

function currentBytes(
  workspace: string,
  factId: string,
  path: string,
  candidate: CandidateSnapshot,
): Uint8Array {
  const selected = candidate.entries.find((entry) => entry.path === path);
  const absolutePath = join(workspace, path);
  if (selected === undefined && !existsSync(absolutePath)) {
    throw new Error(`fact ${factId} authority absent: ${path}`);
  }
  // Proof: bypassing this guard made the host `node_modules/typescript/package.json` test
  // receive only the later resolved-target diagnostic, not its exact source candidate boundary.
  if (selected === undefined || selected.mode === '160000') {
    throw new Error(`fact ${factId} authority outside selected candidate: ${path}`);
  }
  // Proof: removing the existence branch made the absent-authority test receive
  // `authority unreadable ... ENOENT` instead of the required named absence.
  if (!existsSync(absolutePath)) throw new Error(`fact ${factId} authority absent: ${path}`);
  let target: string;
  try {
    target = relative(realpathSync(workspace), realpathSync(absolutePath));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`fact ${factId} authority unreadable: ${path}: ${detail}`, { cause });
  }
  const selectedTarget = candidate.entries.find((entry) => entry.path === target);
  // Proof: bypassing this guard made the selected symlink-to-Gitlink test receive
  // `authority unreadable ... EISDIR`, not its exact resolved candidate boundary.
  if (selectedTarget === undefined || selectedTarget.mode === '160000') {
    throw new Error(
      `fact ${factId} authority resolved outside selected candidate: ${path} -> ${target}`,
    );
  }
  try {
    return readFileSync(absolutePath);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    // Preserve the fact and authority names if the immutable materialization becomes unreadable.
    throw new Error(`fact ${factId} authority unreadable: ${path}: ${detail}`, { cause });
  }
}

function historicalBytes(
  repository: string,
  factId: string,
  revision: string,
  path: string,
): Uint8Array {
  const commit = Bun.spawnSync(
    ['git', '-C', repository, 'cat-file', '-e', `${revision}^{commit}`],
    {
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  // Proof: bypassing this preflight made the unavailable-history test misreport the fault as
  // `authority absent: .env.example at ffff...` instead of naming the unavailable base.
  if (commit.exitCode !== 0) {
    throw new Error(`fact ${factId} historical base unavailable: ${revision}`);
  }
  const selected = Bun.spawnSync(['git', '-C', repository, 'show', `${revision}:${path}`], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (selected.exitCode !== 0) {
    throw new Error(`fact ${factId} authority absent: ${path} at ${revision}`);
  }
  return selected.stdout;
}

function authorityBytes(
  repository: string,
  workspace: string,
  candidate: CandidateSnapshot,
  fact: RelationshipFact,
): Uint8Array {
  if (!('path' in fact)) {
    throw new Error(`fact ${fact.factId} has no executable authority path`);
  }
  // Proof: resolving both selectors from the current checkout made the historical production
  // CLI fail with `expected 3100; received 3200` in `resolves a historical selector`.
  return fact.at.kind === 'historical'
    ? historicalBytes(repository, fact.factId, fact.at.revision, fact.path)
    : currentBytes(workspace, fact.factId, fact.path, candidate);
}

function malformed(fact: RelationshipFact, cause: unknown): never {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const path =
    'path' in fact
      ? fact.path
      : fact.kind === 'nx-target'
        ? `${fact.project}:${fact.target}`
        : fact.system;
  throw new Error(`fact ${fact.factId} authority malformed: ${path}: ${detail}`, { cause });
}

function jsonAuthority(fact: RelationshipFact, bytes: Uint8Array): UnknownRecord {
  try {
    return record(
      parseJson(bytes, `fact ${fact.factId} authority`),
      `fact ${fact.factId} authority`,
    );
  } catch (cause) {
    return malformed(fact, cause);
  }
}

function yamlAuthority(fact: RelationshipFact, bytes: Uint8Array): UnknownRecord {
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return record(parseYaml(source), `fact ${fact.factId} authority`);
  } catch (cause) {
    return malformed(fact, cause);
  }
}

function envAuthority(fact: RelationshipFact, bytes: Uint8Array): Map<string, string> {
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const variables = new Map<string, string>();
    for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith('#')) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      // Proof: skipping a malformed line made the authority test report an unresolved selector
      // instead of `authority malformed: .env.example`.
      if (match === null) throw new Error(`line ${String(index + 1)} is not NAME=value`);
      if (variables.has(match[1])) throw new Error(`variable ${match[1]} is declared twice`);
      variables.set(match[1], match[2]);
    }
    return variables;
  } catch (cause) {
    return malformed(fact, cause);
  }
}

function dockerInstructions(
  fact: RelationshipFact & { kind: 'docker-instruction' },
  bytes: Uint8Array,
): { stage: string; instruction: string; value: string }[] {
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const logicalLines: string[] = [];
    let pending = '';
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || (pending.length === 0 && line.startsWith('#'))) continue;
      const continued = line.endsWith('\\');
      pending += `${pending.length === 0 ? '' : ' '}${continued ? line.slice(0, -1).trimEnd() : line}`;
      if (!continued) {
        logicalLines.push(pending);
        pending = '';
      }
    }
    if (pending.length > 0) throw new Error('unterminated line continuation');
    let stage = '<global>';
    let unnamedStage = 0;
    const instructions: { stage: string; instruction: string; value: string }[] = [];
    for (const line of logicalLines) {
      const match = /^([A-Za-z]+)\s+(.+)$/.exec(line);
      if (match === null) throw new Error(`instruction is malformed: ${line}`);
      const instruction = match[1].toUpperCase();
      const value = match[2].trim();
      if (instruction === 'FROM') {
        unnamedStage += 1;
        const alias = /\s+AS\s+([^\s]+)$/i.exec(value)?.[1];
        stage = alias ?? `#${String(unnamedStage)}`;
      }
      instructions.push({ stage, instruction, value });
    }
    return instructions;
  } catch (cause) {
    return malformed(fact, cause);
  }
}

function sourceFile(fact: RelationshipFact, bytes: Uint8Array): ts.SourceFile {
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed = ts.createSourceFile(
      'path' in fact ? fact.path : fact.factId,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    // TypeScript's parser exposes this runtime boundary but omits it from SourceFile's public type.
    const diagnostics = (parsed as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] })
      .parseDiagnostics;
    if (diagnostics !== undefined && diagnostics.length > 0) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n'));
    }
    return parsed;
  } catch (cause) {
    return malformed(fact, cause);
  }
}

function exportedCall(
  fact: RelationshipFact & { exportName: string },
  bytes: Uint8Array,
  callee: string,
): ts.CallExpression | undefined {
  const parsed = sourceFile(fact, bytes);
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (exported !== true) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === fact.exportName &&
        declaration.initializer !== undefined &&
        ts.isCallExpression(declaration.initializer) &&
        ts.isIdentifier(declaration.initializer.expression) &&
        declaration.initializer.expression.text === callee
      ) {
        return declaration.initializer;
      }
    }
  }
  return undefined;
}

function unsupported(fact: RelationshipFact, detail: string): never {
  throw new Error(`fact ${fact.factId} selector unsupported: ${detail}`);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let unwrapped = expression;
  while (
    ts.isParenthesizedExpression(unwrapped) ||
    ts.isAsExpression(unwrapped) ||
    ts.isTypeAssertionExpression(unwrapped) ||
    ts.isNonNullExpression(unwrapped) ||
    ts.isSatisfiesExpression(unwrapped)
  ) {
    unwrapped = unwrapped.expression;
  }
  return unwrapped;
}

function constInitializer(
  fact: RelationshipFact,
  source: ts.SourceFile,
  name: string,
): ts.Expression | undefined {
  const matches: ts.Expression[] = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer !== undefined
      ) {
        matches.push(declaration.initializer);
      }
    }
  }
  if (matches.length > 1) unsupported(fact, `HTTP constant ${name} is declared twice`);
  return matches.at(0);
}

function staticText(
  fact: RelationshipFact,
  source: ts.SourceFile,
  expression: ts.Expression,
  resolving: Set<string>,
): string | undefined {
  const selected = unwrapExpression(expression);
  if (ts.isStringLiteral(selected) || ts.isNoSubstitutionTemplateLiteral(selected)) {
    return selected.text;
  }
  if (!ts.isIdentifier(selected)) return undefined;
  if (resolving.has(selected.text)) {
    unsupported(fact, `HTTP constant cycle at ${selected.text}`);
  }
  const initializer = constInitializer(fact, source, selected.text);
  if (initializer === undefined) return undefined;
  resolving.add(selected.text);
  const value = staticText(fact, source, initializer, resolving);
  resolving.delete(selected.text);
  return value;
}

function propertyName(
  fact: RelationshipFact,
  source: ts.SourceFile,
  name: ts.PropertyName,
  resolving: Set<string>,
): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (!ts.isComputedPropertyName(name)) {
    return unsupported(fact, `HTTP property name ${name.getText(source)}`);
  }
  // Proof: treating a computed name as irrelevant made `['path']: '/computed'` leave the earlier
  // route certified; its production test expected exit 1 and received 0.
  const computed = staticText(fact, source, name.expression, resolving);
  if (computed === undefined) {
    return unsupported(fact, `HTTP computed property ${name.expression.getText(source)}`);
  }
  return computed;
}

function applyHttpObject(
  fact: RelationshipFact,
  source: ts.SourceFile,
  expression: ts.Expression,
  properties: Map<string, string>,
  resolving: Set<string>,
): void {
  const selected = unwrapExpression(expression);
  if (ts.isIdentifier(selected)) {
    if (resolving.has(selected.text)) unsupported(fact, `HTTP constant cycle at ${selected.text}`);
    const initializer = constInitializer(fact, source, selected.text);
    if (initializer === undefined) {
      // Proof: ignoring an unresolved spread made the dynamic-spread production CLI exit 0;
      // its named unsupported-selector test expected exit 1 and received 0.
      return unsupported(fact, `HTTP object spread ${selected.getText(source)}`);
    }
    resolving.add(selected.text);
    applyHttpObject(fact, source, initializer, properties, resolving);
    resolving.delete(selected.text);
    return;
  }
  if (!ts.isObjectLiteralExpression(selected)) {
    return unsupported(fact, `HTTP object spread ${selected.getText(source)}`);
  }
  for (const member of selected.properties) {
    if (ts.isSpreadAssignment(member)) {
      // Proof: skipping spread evaluation made the production CLI certify `/api/work-items`
      // despite the later `/changed`; its override test expected exit 1 and received 0.
      applyHttpObject(fact, source, member.expression, properties, resolving);
      continue;
    }
    if (ts.isPropertyAssignment(member)) {
      const name = propertyName(fact, source, member.name, resolving);
      if (name !== 'method' && name !== 'path') continue;
      const value = staticText(fact, source, member.initializer, resolving);
      if (value === undefined) {
        unsupported(fact, `HTTP property ${name} value ${member.initializer.getText(source)}`);
      }
      properties.set(name, value);
      continue;
    }
    if (ts.isShorthandPropertyAssignment(member)) {
      const name = member.name.text;
      if (name !== 'method' && name !== 'path') continue;
      const value = staticText(fact, source, member.name, resolving);
      if (value === undefined) unsupported(fact, `HTTP property ${name} value ${name}`);
      properties.set(name, value);
      continue;
    }
    const name = propertyName(fact, source, member.name, resolving);
    if (name === 'method' || name === 'path') {
      unsupported(fact, `HTTP property ${name} is not a static value`);
    }
  }
}

function httpProperties(
  fact: RelationshipFact,
  object: ts.ObjectLiteralExpression,
): Map<string, string> {
  const properties = new Map<string, string>();
  applyHttpObject(fact, object.getSourceFile(), object, properties, new Set());
  return properties;
}

interface SqlToken {
  kind: 'identifier' | 'string' | 'symbol' | 'word';
  text: string;
}

function sqlStatements(fact: RelationshipFact, source: string): SqlToken[][] {
  const statements: SqlToken[][] = [];
  let statement: SqlToken[] = [];
  let depth = 0;
  let position = 0;
  const pushStatement = (): void => {
    if (statement.length > 0) statements.push(statement);
    statement = [];
  };
  while (position < source.length) {
    const character = source[position];
    if (/\s/.test(character)) {
      position += 1;
      continue;
    }
    if (character === '-' && source[position + 1] === '-') {
      const lineEnd = source.indexOf('\n', position + 2);
      position = lineEnd === -1 ? source.length : lineEnd + 1;
      continue;
    }
    if (character === '/' && source[position + 1] === '*') {
      const commentEnd = source.indexOf('*/', position + 2);
      if (commentEnd === -1) unsupported(fact, 'migration has an unterminated block comment');
      position = commentEnd + 2;
      continue;
    }
    if (character === "'") {
      let value = '';
      position += 1;
      for (;;) {
        if (position >= source.length) unsupported(fact, 'migration has an unterminated string');
        if (source[position] === "'") {
          if (source[position + 1] === "'") {
            value += "'";
            position += 2;
            continue;
          }
          position += 1;
          break;
        }
        value += source[position];
        position += 1;
      }
      // Proof: restoring the raw-source CREATE regex made `SELECT 'CREATE TABLE ghost'` certify
      // `ghost`; its production CLI test expected exit 1 and received 0.
      statement.push({ kind: 'string', text: value });
      continue;
    }
    if (character === '"' || character === '`' || character === '[') {
      const close = character === '[' ? ']' : character;
      let value = '';
      position += 1;
      for (;;) {
        if (position >= source.length) {
          unsupported(fact, `migration has an unterminated ${character} identifier`);
        }
        if (source[position] === close) {
          if (source[position + 1] === close) {
            value += close;
            position += 2;
            continue;
          }
          position += 1;
          break;
        }
        value += source[position];
        position += 1;
      }
      statement.push({ kind: 'identifier', text: value });
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(source.slice(position));
    if (word !== null) {
      statement.push({ kind: 'word', text: word[0] });
      position += word[0].length;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') {
      depth -= 1;
      if (depth < 0) unsupported(fact, 'migration has an unmatched closing parenthesis');
    }
    if (character === ';' && depth === 0) {
      pushStatement();
    } else {
      statement.push({ kind: 'symbol', text: character });
    }
    position += 1;
  }
  if (depth !== 0) unsupported(fact, 'migration has an unterminated parenthesized expression');
  pushStatement();
  return statements;
}

function sqlWord(token: SqlToken | undefined, expected: string): boolean {
  return token?.kind === 'word' && token.text.toUpperCase() === expected;
}

function sqlIdentifier(
  fact: RelationshipFact,
  statement: SqlToken[],
  position: number,
  statementNumber: number,
): string {
  if (!(position in statement)) {
    unsupported(fact, `migration statement ${String(statementNumber)} has no table identifier`);
  }
  const token = statement[position];
  if (token.kind !== 'word' && token.kind !== 'identifier') {
    unsupported(fact, `migration statement ${String(statementNumber)} has no table identifier`);
  }
  return token.text;
}

function createTablePosition(statement: SqlToken[]): number | undefined {
  if (!sqlWord(statement[0], 'CREATE')) return undefined;
  let position = 1;
  if (sqlWord(statement[position], 'TEMP') || sqlWord(statement[position], 'TEMPORARY'))
    position += 1;
  if (!sqlWord(statement[position], 'TABLE')) return undefined;
  position += 1;
  if (
    sqlWord(statement[position], 'IF') &&
    sqlWord(statement[position + 1], 'NOT') &&
    sqlWord(statement[position + 2], 'EXISTS')
  ) {
    position += 3;
  }
  return position;
}

function statementKind(
  fact: RelationshipFact,
  statement: SqlToken[],
  statementNumber: number,
): 'alter-table' | 'create-table' | 'drop-table' | 'other' {
  const root = statement[0];
  if (root.kind !== 'word') {
    unsupported(fact, `migration statement ${String(statementNumber)} has no executable keyword`);
  }
  const keyword = root.text.toUpperCase();
  const createPosition = createTablePosition(statement);
  if (createPosition !== undefined) {
    sqlIdentifier(fact, statement, createPosition, statementNumber);
    return 'create-table';
  }
  if (keyword === 'CREATE') {
    const indexPosition = sqlWord(statement[1], 'UNIQUE') ? 2 : 1;
    if (sqlWord(statement[indexPosition], 'INDEX')) return 'other';
    unsupported(fact, `migration statement ${String(statementNumber)} uses unsupported CREATE`);
  }
  if (keyword === 'ALTER') {
    if (!sqlWord(statement[1], 'TABLE')) {
      unsupported(fact, `migration statement ${String(statementNumber)} uses unsupported ALTER`);
    }
    sqlIdentifier(fact, statement, 2, statementNumber);
    return 'alter-table';
  }
  if (keyword === 'DROP') {
    const target = statement[1];
    if (sqlWord(target, 'INDEX')) return 'other';
    if (!sqlWord(target, 'TABLE')) {
      unsupported(fact, `migration statement ${String(statementNumber)} uses unsupported DROP`);
    }
    let position = 2;
    if (sqlWord(statement[position], 'IF') && sqlWord(statement[position + 1], 'EXISTS')) {
      position += 2;
    }
    sqlIdentifier(fact, statement, position, statementNumber);
    return 'drop-table';
  }
  if (['DELETE', 'INSERT', 'PRAGMA', 'SELECT', 'UPDATE', 'WITH'].includes(keyword)) return 'other';
  // Proof: accepting an unknown root after a valid CREATE made the partial migration certify
  // `real`; its production CLI test expected exit 1 and received 0.
  unsupported(
    fact,
    `migration statement ${String(statementNumber)} starts with ${root.text.toUpperCase()}`,
  );
}

function migrationTables(
  fact: RelationshipFact & { kind: 'migration-table' },
  bytes: Uint8Array,
): string[] {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    return malformed(fact, cause);
  }
  const tables: string[] = [];
  for (const [index, statement] of sqlStatements(fact, source).entries()) {
    const number = index + 1;
    const kind = statementKind(fact, statement, number);
    if (fact.operation === 'create' && kind === 'create-table') {
      const position = createTablePosition(statement);
      if (position === undefined) throw new Error('create-table classification lost its position');
      tables.push(sqlIdentifier(fact, statement, position, number));
    }
    if (fact.operation === 'alter' && kind === 'alter-table') {
      tables.push(sqlIdentifier(fact, statement, 2, number));
    }
    if (fact.operation === 'drop' && kind === 'drop-table') {
      let position = 2;
      if (sqlWord(statement[position], 'IF') && sqlWord(statement[position + 1], 'EXISTS')) {
        position += 2;
      }
      tables.push(sqlIdentifier(fact, statement, position, number));
    }
    if (fact.operation === 'references' && (kind === 'create-table' || kind === 'alter-table')) {
      for (let position = 0; position < statement.length; position += 1) {
        if (sqlWord(statement[position], 'REFERENCES')) {
          tables.push(sqlIdentifier(fact, statement, position + 1, number));
        }
      }
    }
  }
  return tables;
}

function blobIdentity(repository: string, fact: RelationshipFact, bytes: Uint8Array): string {
  const invocation = Bun.spawnSync(['git', '-C', repository, 'hash-object', '--stdin'], {
    stdin: bytes,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (invocation.exitCode !== 0) {
    const detail = invocation.stderr.toString('utf8').trim();
    throw new Error(`fact ${fact.factId} authority unreadable: git hash-object: ${detail}`);
  }
  return invocation.stdout.toString('utf8').trim();
}

function currentTarget(
  fact: RelationshipFact & { kind: 'nx-target' },
  nx: NxRelationships,
): unknown {
  const matches = nx.targets.filter(
    (target) => target.project === fact.project && target.target === fact.target,
  );
  if (matches.length !== 1) return undefined;
  return matches[0].configuration;
}

function extractActual(
  repository: string,
  workspace: string,
  candidate: CandidateSnapshot,
  fact: RelationshipFact,
  nx: NxRelationships,
): unknown {
  if (fact.kind === 'external-consumer') {
    return {
      system: fact.system,
      contract: fact.contract,
      knowledgeLimit: fact.knowledgeLimit,
    };
  }
  if (fact.kind === 'nx-target') {
    if (fact.at.kind === 'historical') {
      throw new Error(
        `fact ${fact.factId} selector unsupported at historical base ${fact.at.revision}: nx-target`,
      );
    }
    return currentTarget(fact, nx);
  }
  const bytes = authorityBytes(repository, workspace, candidate, fact);
  switch (fact.kind) {
    case 'package-script': {
      const scripts = record(jsonAuthority(fact, bytes)['scripts'], `fact ${fact.factId} scripts`);
      return scripts[fact.name];
    }
    case 'ci-step-command': {
      const jobs = record(yamlAuthority(fact, bytes)['jobs'], `fact ${fact.factId} jobs`);
      const job = record(jobs[fact.job], `fact ${fact.factId} job ${fact.job}`);
      const steps = job['steps'];
      if (!Array.isArray(steps)) return malformed(fact, `job ${fact.job}.steps must be an array`);
      const matches = steps.filter((step) => {
        const candidate = record(step, `fact ${fact.factId} step`);
        return candidate['name'] === fact.step;
      });
      if (matches.length !== 1) return undefined;
      return record(matches[0], `fact ${fact.factId} step ${fact.step}`)['run'];
    }
    case 'hook-command': {
      const root = yamlAuthority(fact, bytes);
      const hook = record(root[fact.hook], `fact ${fact.factId} hook ${fact.hook}`);
      const commands = record(hook['commands'], `fact ${fact.factId} commands`);
      return record(commands[fact.command], `fact ${fact.factId} command ${fact.command}`)['run'];
    }
    case 'docker-instruction': {
      const matches = dockerInstructions(fact, bytes).filter(
        (instruction) =>
          instruction.stage === fact.stage && instruction.instruction === fact.instruction,
      );
      return matches[fact.ordinal - 1]?.value;
    }
    case 'generated-blob':
    case 'vendored-lock':
      return blobIdentity(repository, fact, bytes);
    case 'environment-variable':
      return envAuthority(fact, bytes).get(fact.name);
    case 'port': {
      const value = envAuthority(fact, bytes).get(fact.name);
      if (value === undefined) return undefined;
      if (!/^\d+$/.test(value)) return malformed(fact, `${fact.name} is not an integer port`);
      const port = Number(value);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        return malformed(fact, `${fact.name} is outside 1..65535`);
      }
      return port;
    }
    case 'drizzle-table': {
      const call = exportedCall(fact, bytes, 'sqliteTable');
      const argument = call?.arguments[0];
      return argument !== undefined && ts.isStringLiteral(argument) ? argument.text : undefined;
    }
    case 'migration-table': {
      const tables = migrationTables(fact, bytes);
      // Proof: always selecting the first CREATE made `migration.teams.person` receive
      // `service_team` instead of `person` in the real-migration production CLI test.
      return tables[fact.occurrence - 1];
    }
    case 'http-endpoint': {
      const call = exportedCall(fact, bytes, 'defineEndpointShape');
      const argument = call?.arguments[0];
      if (argument === undefined || !ts.isObjectLiteralExpression(argument)) return undefined;
      const properties = httpProperties(fact, argument);
      const method = properties.get('method');
      const path = properties.get('path');
      return method === undefined || path === undefined ? undefined : { method, path };
    }
  }
}

function expectedValue(fact: RelationshipFact): unknown {
  switch (fact.kind) {
    case 'generated-blob':
    case 'vendored-lock':
      return fact.expectedBlob;
    case 'http-endpoint':
      return { method: fact.expectedMethod, path: fact.expectedPath };
    case 'nx-target':
      return fact.expectedConfiguration;
    case 'external-consumer':
      return {
        system: fact.system,
        contract: fact.contract,
        knowledgeLimit: fact.knowledgeLimit,
      };
    default:
      return fact.expected;
  }
}

function printable(value: unknown): string {
  if (value === undefined) return '<unresolved>';
  return JSON.stringify(value);
}

function readDeclarations(workspace: string, paths: readonly string[]): DeclarationSource[] {
  return paths.map((path) => {
    const absolutePath = join(workspace, path);
    // Proof: removing this branch made the absent-declaration test receive
    // `relationship declaration unreadable ... ENOENT` instead of the named absence.
    if (!existsSync(absolutePath)) throw new Error(`relationship declaration absent: ${path}`);
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(absolutePath);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      // Proof: rethrowing the filesystem error made the unreadable-declaration test receive bare
      // `EISDIR: illegal operation on a directory, read`, losing the declaration path.
      throw new Error(`relationship declaration unreadable: ${path}: ${detail}`, { cause });
    }
    let input: unknown;
    try {
      input = parseJson(bytes, `relationship declaration ${path}`);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      // Proof: rethrowing the JSON error made the malformed-declaration test receive
      // `relationship declaration relationships.v1.json malformed`, not the boundary's name.
      throw new Error(`relationship declaration malformed: ${path}: ${detail}`, { cause });
    }
    return { path, declaration: parseOrThrow(RelationshipDeclaration, input) };
  });
}

function declarationExtractor(): ExtractorIdentity {
  let source: Uint8Array;
  try {
    source = readFileSync(import.meta.path);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`relationship declaration extractor identity unreadable: ${detail}`, { cause });
  }
  return {
    extractorId: 'relationship-declarations',
    version: 'v1',
    blob: hashCanonical({ implementation: Buffer.from(source).toString('base64'), version: 1 }),
  };
}

function factReference(endpoint: unknown): string | undefined {
  const candidate = record(endpoint, 'relationship endpoint');
  return candidate['kind'] === 'fact'
    ? text(candidate['factId'], 'relationship fact id')
    : undefined;
}

/** Resolves only explicitly selected facts and preserves non-derivable edges as declarations. */
export function extractDeclaredRelationships(
  repository: string,
  workspace: string,
  candidate: CandidateSnapshot,
  request: RelationshipRequest,
  nx: NxRelationships,
): { extractor: ExtractorIdentity; relationships: DeclaredRelationships } {
  const extractor = declarationExtractor();
  const sources = readDeclarations(workspace, request.declarationPaths ?? []);
  const declarationIds = sources.map(({ declaration }) => declaration.declarationId);
  // Proof: bypassing this guard made the cross-document duplicate-declaration production CLI
  // invocation exit 0; its test expected exit 1 and received 0.
  if (new Set(declarationIds).size !== declarationIds.length) {
    throw new Error('relationship declarations must have unique declarationId values');
  }
  const seenFacts = new Set<string>();
  for (const { declaration } of sources) {
    for (const factId of new Set(declaration.facts.map((fact) => fact.factId))) {
      // Proof: bypassing this guard made the cross-document duplicate-fact production CLI
      // invocation exit 0; its test expected exit 1 and received 0.
      if (seenFacts.has(factId)) {
        throw new Error(`relationship fact ${factId} is declared in more than one document`);
      }
      seenFacts.add(factId);
    }
  }
  const seenEdges = new Set<string>();
  for (const { declaration } of sources) {
    for (const relationshipId of new Set(declaration.edges.map((edge) => edge.relationshipId))) {
      // Proof: bypassing this guard made the cross-document duplicate-edge production CLI
      // invocation exit 0; its test expected exit 1 and received 0.
      if (seenEdges.has(relationshipId)) {
        throw new Error(`relationship ${relationshipId} is declared in more than one document`);
      }
      seenEdges.add(relationshipId);
    }
  }
  const candidatePaths = new Set(candidate.entries.map((entry) => entry.path));
  const facts = sources
    .flatMap(({ declaration, path }) =>
      declaration.facts.map((fact) => {
        const actual = extractActual(repository, workspace, candidate, fact, nx);
        const expected = expectedValue(fact);
        if (actual === undefined || hashCanonical(actual) !== hashCanonical(expected)) {
          // Proof: bypassing this comparison made the forged-selector production CLI exit 0;
          // `reports the named fact or edge mismatch` expected exit 1 and received 0.
          throw new Error(
            `fact ${fact.factId} authority-selector mismatch: expected ${printable(expected)}; received ${printable(actual)}`,
          );
        }
        const provenance: FactProvenance = {
          kind: fact.kind === 'external-consumer' ? 'declared' : 'extracted',
          declarationId: declaration.declarationId,
          declarationPath: path,
          extractor,
        };
        const selector = {
          factId: fact.factId,
          family: fact.family,
          at: fact.at,
          selector: fact,
          actual,
          provenance,
        };
        return { ...selector, identity: hashCanonical(selector) };
      }),
    )
    .sort((left, right) => compareText(left.factId, right.factId));
  const knownFacts = new Set(facts.map((fact) => fact.factId));
  const edges = sources
    .flatMap(({ declaration, path }) =>
      declaration.edges.map((edge) => {
        for (const [side, endpoint] of [
          ['source', edge.source],
          ['target', edge.target],
        ] as const) {
          const referencedFact = factReference(endpoint);
          // Proof: bypassing this guard made the forged-edge production CLI exit 0;
          // `reports the named fact or edge mismatch` expected exit 1 and received 0.
          if (referencedFact !== undefined && !knownFacts.has(referencedFact)) {
            throw new Error(
              `relationship ${edge.relationshipId} ${side} fact ${referencedFact} is not declared`,
            );
          }
          // Proof: bypassing this guard made the forged-path-edge production CLI exit 0;
          // `reports the named fact or edge mismatch` expected exit 1 and received 0.
          if (endpoint.kind === 'path' && !candidatePaths.has(endpoint.path)) {
            throw new Error(
              `relationship ${edge.relationshipId} ${side} path ${endpoint.path} is not selected`,
            );
          }
        }
        const provenance: FactProvenance = {
          kind: 'declared',
          declarationId: declaration.declarationId,
          declarationPath: path,
          extractor,
        };
        const selected = {
          relationshipId: edge.relationshipId,
          kind: edge.kind,
          status: edge.status,
          source: edge.source,
          target: edge.target,
          ...('reason' in edge ? { reason: edge.reason } : {}),
          provenance,
        };
        return { ...selected, identity: hashCanonical(selected) };
      }),
    )
    .sort((left, right) => compareText(left.relationshipId, right.relationshipId));
  const coverage = sources
    .map(({ declaration }) => ({
      declarationId: declaration.declarationId,
      scope: declaration.coverage,
      families: [...new Set(declaration.facts.map((fact) => fact.family))].sort(compareText),
    }))
    .sort((left, right) => compareText(left.declarationId, right.declarationId));
  // Proof: dropping unresolved edges made `extracts every supported fact family` receive []
  // instead of the named `dynamic-shell-read` relationship and its reason.
  const unresolved = edges.flatMap((edge) =>
    edge.status === 'unresolved' && edge.reason !== undefined
      ? [{ relationshipId: edge.relationshipId, reason: edge.reason }]
      : [],
  );
  return { extractor, relationships: { coverage, facts, edges, unresolved } };
}
