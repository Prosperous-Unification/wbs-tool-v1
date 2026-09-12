import { Buffer } from 'node:buffer';
import { existsSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';

import ts from 'typescript';

import type { RelationshipRequest } from '../contracts/records';
import { hashCanonical } from '../evidence/content-manifest';

export interface ExtractorIdentity {
  extractorId: string;
  version: string;
  blob: string;
}

export type ImportKind =
  | 'dynamic'
  | 'import-equals'
  | 're-export'
  | 'reference-lib'
  | 'reference-path'
  | 'reference-types'
  | 'type'
  | 'type-re-export'
  | 'value';

export interface TypeScriptImportSelector {
  source: string;
  specifier: string;
  target: string;
  importKind: ImportKind;
  extractor: ExtractorIdentity;
  identity: string;
}

export interface TypeScriptReverseEdgeSelector {
  provider: string;
  importers: { source: string; specifier: string; importKind: ImportKind }[];
  extractor: ExtractorIdentity;
  identity: string;
}

export interface ResolvedDeclaration {
  sourcePath: string;
  emittedPath: string;
  text: string;
}

export interface PublicDeclarationSelector {
  configPath: string;
  entrypoint: string;
  configurationIdentity: string;
  declarations: ResolvedDeclaration[];
  extractor: ExtractorIdentity;
  identity: string;
}

export interface TypeScriptRelationships {
  imports: TypeScriptImportSelector[];
  reverseEdges: TypeScriptReverseEdgeSelector[];
  publicDeclarations: PublicDeclarationSelector[];
}

interface ParsedProject {
  configPath: string;
  configurationIdentity: string;
  options: ts.CompilerOptions;
  program: ts.Program;
  declarations: Map<string, ResolvedDeclaration>;
}

interface ImportSite {
  specifier: string;
  importKind: ImportKind;
}

const compareText = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

function workspacePath(workspace: string, path: string): string | undefined {
  const fromRoot = relative(workspace, path).replaceAll('\\', '/');
  // Proof: returning the temporary absolute root for `rootDir: '.'` made repeated extraction of
  // one commit receive configuration identities cc163641... and 0ec9a7e... instead of equality.
  if (fromRoot === '') return '.';
  return fromRoot === '..' || fromRoot.startsWith('../') || isAbsolute(fromRoot)
    ? undefined
    : fromRoot;
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

function normalizedCompilerValue(value: unknown, workspace: string): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const selectedPath = workspacePath(workspace, value);
    return selectedPath ?? value;
  }
  if (Array.isArray(value)) return value.map((entry) => normalizedCompilerValue(entry, workspace));
  if (typeof value !== 'object') {
    throw new Error(`TypeScript compiler configuration contains unsupported ${typeof value}`);
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field !== undefined) normalized[key] = normalizedCompilerValue(field, workspace);
  }
  return normalized;
}

function parseProject(workspace: string, configPath: string): ParsedProject {
  const absoluteConfig = resolve(workspace, configPath);
  // Proof: removing this boundary made the production CLI report the absent
  // `missing-tsconfig.json` as unreadable; the exact absent assertion failed.
  if (!existsSync(absoluteConfig)) throw new Error(`TypeScript config absent: ${configPath}`);
  const config = ts.readConfigFile(absoluteConfig, (path) => ts.sys.readFile(path));
  if (config.error !== undefined) {
    // Proof: removing this branch made the directory supplied as config exit 0; the production
    // unreadable-config oracle expected exit 1 and failed before the malformed case.
    const detail = formatDiagnostic(config.error);
    const failure = config.error.code === 5083 ? 'unreadable' : 'malformed';
    throw new Error(`TypeScript config ${failure}: ${configPath}: ${detail}`);
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(absoluteConfig),
    {},
    absoluteConfig,
  );
  if (parsed.errors.length > 0) {
    throw new Error(
      `TypeScript config malformed: ${configPath}: ${parsed.errors.map(formatDiagnostic).join('; ')}`,
    );
  }
  const options: ts.CompilerOptions = {
    ...parsed.options,
    declaration: true,
    declarationMap: false,
    emitDeclarationOnly: true,
    noEmit: false,
  };
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options,
    projectReferences: parsed.projectReferences,
  });
  const configurationIdentity = hashCanonical({
    configPath,
    fileNames: parsed.fileNames
      .map((fileName) => workspacePath(workspace, fileName))
      .filter((path): path is string => path !== undefined)
      .sort(compareText),
    options: normalizedCompilerValue(options, workspace),
  });
  return {
    configPath,
    configurationIdentity,
    options,
    program,
    declarations: new Map(),
  };
}

function importSites(sourceFile: ts.SourceFile): ImportSite[] {
  const sites: ImportSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const namedBindings = clause?.namedBindings;
      const allNamedTypeOnly =
        namedBindings !== undefined &&
        ts.isNamedImports(namedBindings) &&
        namedBindings.elements.length > 0 &&
        namedBindings.elements.every((element) => element.isTypeOnly);
      sites.push({
        specifier: node.moduleSpecifier.text,
        // Proof: treating named bindings alone as decisive made a default-value plus named-type
        // import receive `type`; the exact production selector expected `value` and failed.
        importKind:
          clause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
          (clause?.name === undefined && allNamedTypeOnly)
            ? 'type'
            : 'value',
      });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) {
        throw new Error(`TypeScript export specifier is not a string in ${sourceFile.fileName}`);
      }
      const allNamedTypeOnly =
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every((element) => element.isTypeOnly);
      sites.push({
        specifier: node.moduleSpecifier.text,
        // Proof: ignoring inline `type` modifiers made the production selector receive
        // `re-export` for `export { type PublicThing }`; its exact kind assertion failed.
        importKind: node.isTypeOnly || allNamedTypeOnly ? 'type-re-export' : 're-export',
      });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      sites.push({ specifier: node.moduleReference.expression.text, importKind: 'import-equals' });
    } else if (ts.isImportTypeNode(node)) {
      if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteral(node.argument.literal)) {
        throw new Error(
          `TypeScript import type specifier is not a string in ${sourceFile.fileName}`,
        );
      }
      // Proof: omitting ImportTypeNode traversal kept the hidden-type mutation at
      // 502b6f24...; the production public-declaration stale assertion failed.
      sites.push({ specifier: node.argument.literal.text, importKind: 'type' });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      sites.push({ specifier: node.arguments[0].text, importKind: 'dynamic' });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  sites.push(
    // Proof: omitting path references kept the public selector at 53ad5864... after the referenced
    // global's `code` changed to number; the production stale-identity assertion failed.
    ...sourceFile.referencedFiles.map((reference) => ({
      specifier: reference.fileName,
      importKind: 'reference-path' as const,
    })),
    ...sourceFile.typeReferenceDirectives.map((reference) => ({
      specifier: reference.fileName,
      importKind: 'reference-types' as const,
    })),
    ...sourceFile.libReferenceDirectives.map((reference) => ({
      specifier: reference.fileName,
      importKind: 'reference-lib' as const,
    })),
  );
  return sites;
}

function externalTarget(specifier: string): string {
  if (specifier.startsWith('@')) {
    return `external:${specifier.split('/').slice(0, 2).join('/')}`;
  }
  return `external:${specifier.split('/')[0]}`;
}

function resolveDependency(
  workspace: string,
  project: ParsedProject,
  sourceFile: ts.SourceFile,
  site: ImportSite,
): string {
  if (site.importKind === 'reference-path') {
    const resolvedName = ts.resolveTripleslashReference(site.specifier, sourceFile.fileName);
    const referenced = project.program.getSourceFile(resolvedName);
    if (referenced === undefined) {
      const source = workspacePath(workspace, sourceFile.fileName) ?? sourceFile.fileName;
      // Proof: classifying the absent path as external lost this exact boundary to a later
      // compiler diagnostic; the production refusal test received only "File ... not found".
      throw new Error(`TypeScript reference path unresolved: ${source} -> '${site.specifier}'`);
    }
    if (
      project.program.isSourceFileDefaultLibrary(referenced) ||
      project.program.isSourceFileFromExternalLibrary(referenced)
    ) {
      return `external:typescript/reference-path:${site.specifier}`;
    }
    const target = workspacePath(workspace, referenced.fileName);
    if (target === undefined) {
      throw new Error(
        `TypeScript reference path resolved outside candidate: ${sourceFile.fileName} -> '${site.specifier}'`,
      );
    }
    return target;
  }
  if (site.importKind === 'reference-types') {
    const resolved = ts.resolveTypeReferenceDirective(
      site.specifier,
      sourceFile.fileName,
      project.options,
      ts.sys,
    ).resolvedTypeReferenceDirective;
    if (resolved?.resolvedFileName === undefined) {
      const source = workspacePath(workspace, sourceFile.fileName) ?? sourceFile.fileName;
      // Proof: classifying an unresolved types directive as external lost this boundary to the
      // later "Cannot find type definition file" diagnostic in the production refusal test.
      throw new Error(`TypeScript types reference unresolved: ${source} -> '${site.specifier}'`);
    }
    const referenced = project.program.getSourceFile(resolved.resolvedFileName);
    if (referenced === undefined) {
      throw new Error(
        `TypeScript types reference absent from compiler program: ${sourceFile.fileName} -> '${site.specifier}'`,
      );
    }
    if (
      resolved.isExternalLibraryImport === true ||
      project.program.isSourceFileDefaultLibrary(referenced) ||
      project.program.isSourceFileFromExternalLibrary(referenced)
    ) {
      return externalTarget(site.specifier);
    }
    const target = workspacePath(workspace, referenced.fileName);
    if (target === undefined) {
      throw new Error(
        `TypeScript types reference resolved outside candidate: ${sourceFile.fileName} -> '${site.specifier}'`,
      );
    }
    return target;
  }
  if (site.importKind === 'reference-lib') {
    const expectedName = `lib.${site.specifier.toLowerCase()}.d.ts`;
    const libraries = project.program
      .getSourceFiles()
      .filter(
        (candidate) =>
          project.program.isSourceFileDefaultLibrary(candidate) &&
          basename(candidate.fileName).toLowerCase() === expectedName,
      );
    if (libraries.length !== 1) {
      const source = workspacePath(workspace, sourceFile.fileName) ?? sourceFile.fileName;
      // Proof: inventing an external target for the missing lib lost this exact boundary to the
      // later "Cannot find lib definition" diagnostic in the production refusal test.
      throw new Error(
        `TypeScript lib reference ${site.specifier} from ${source} resolved ${String(libraries.length)} default libraries; expected exactly one`,
      );
    }
    return `external:typescript/${expectedName}`;
  }
  // Proof: removing built-in classification made the production CLI fail on the fixture's
  // `node:fs` edge with `TypeScript import unresolved: packages/provider/src/hidden.ts`.
  if (isBuiltin(site.specifier)) return externalTarget(site.specifier);
  const resolved = ts.resolveModuleName(
    site.specifier,
    sourceFile.fileName,
    project.options,
    ts.sys,
  ).resolvedModule;
  // Proof: treating the unresolved import as external made the production CLI report only
  // `Cannot find module './absent'`; the exact source/specifier assertion failed.
  if (resolved === undefined) {
    const source = workspacePath(workspace, sourceFile.fileName) ?? sourceFile.fileName;
    throw new Error(`TypeScript import unresolved: ${source} -> '${site.specifier}'`);
  }
  if (resolved.isExternalLibraryImport === true) return externalTarget(site.specifier);
  return workspacePath(workspace, resolved.resolvedFileName) ?? externalTarget(site.specifier);
}

function emitDeclarations(workspace: string, project: ParsedProject): void {
  const emitted = new Map<string, ResolvedDeclaration>();
  const emission = project.program.emit(
    undefined,
    (emittedPath, text, _writeByteOrderMark, _onError, sourceFiles) => {
      const sourceFile = sourceFiles?.[0];
      if (sourceFile === undefined) {
        throw new Error(`TypeScript declaration emit lost its source for ${emittedPath}`);
      }
      const sourcePath = workspacePath(workspace, sourceFile.fileName);
      if (sourcePath === undefined) return;
      const normalizedEmitted =
        workspacePath(workspace, emittedPath) ??
        `${sourcePath.slice(0, sourcePath.length - extname(sourcePath).length)}.d.ts`;
      emitted.set(sourcePath, { sourcePath, emittedPath: normalizedEmitted, text });
    },
    undefined,
    true,
  );
  if (emission.emitSkipped) {
    throw new Error(
      `TypeScript compiler declaration emit failed for ${project.configPath}: ${emission.diagnostics
        .map(formatDiagnostic)
        .join('; ')}`,
    );
  }
  for (const sourceFile of project.program.getSourceFiles()) {
    if (
      !sourceFile.isDeclarationFile ||
      project.program.isSourceFileDefaultLibrary(sourceFile) ||
      project.program.isSourceFileFromExternalLibrary(sourceFile)
    ) {
      continue;
    }
    const sourcePath = workspacePath(workspace, sourceFile.fileName);
    if (sourcePath === undefined) continue;
    // Proof: omitting local declarations TypeScript does not re-emit kept the shapes mutation at
    // d2d5e2d6...; the production public-declaration stale assertion failed.
    emitted.set(sourcePath, { sourcePath, emittedPath: sourcePath, text: sourceFile.text });
  }
  project.declarations = emitted;
}

function declarationDependencies(
  workspace: string,
  project: ParsedProject,
  declaration: ResolvedDeclaration,
): string[] {
  const sourceFile = project.program.getSourceFile(resolve(workspace, declaration.sourcePath));
  if (sourceFile === undefined) {
    throw new Error(`TypeScript compiler lost source declaration ${declaration.sourcePath}`);
  }
  const dependencies = importSites(
    ts.createSourceFile(declaration.emittedPath, declaration.text, ts.ScriptTarget.Latest, true),
  ).map((site) => resolveDependency(workspace, project, sourceFile, site));
  const sourceReferences = sourceFile.referencedFiles.map((reference) =>
    resolveDependency(workspace, project, sourceFile, {
      specifier: reference.fileName,
      importKind: 'reference-path',
    }),
  );
  // Proof: omitting carried source references kept the public selector at 1fcc9f4f... when the
  // referenced global changed; the committed-candidate CLI stale assertion failed.
  return [...new Set([...dependencies, ...sourceReferences])].filter((path) =>
    project.declarations.has(path),
  );
}

function publicDeclaration(
  workspace: string,
  entrypoint: string,
  project: ParsedProject,
  extractor: ExtractorIdentity,
): PublicDeclarationSelector {
  if (!project.declarations.has(entrypoint)) {
    throw new Error(
      `TypeScript public entrypoint unresolved by ${project.configPath}: ${entrypoint}`,
    );
  }
  const visited = new Set<string>();
  const pending = [entrypoint];
  while (pending.length > 0) {
    const sourcePath = pending.pop();
    if (sourcePath === undefined || visited.has(sourcePath)) continue;
    const declaration = project.declarations.get(sourcePath);
    if (declaration === undefined) {
      throw new Error(`TypeScript emitted declaration unresolved: ${sourcePath}`);
    }
    visited.add(sourcePath);
    pending.push(...declarationDependencies(workspace, project, declaration));
  }
  const declarations = [...visited].sort(compareText).map((sourcePath) => {
    const declaration = project.declarations.get(sourcePath);
    if (declaration === undefined)
      throw new Error(`TypeScript declaration disappeared: ${sourcePath}`);
    return declaration;
  });
  const selector = {
    configPath: project.configPath,
    entrypoint,
    configurationIdentity: project.configurationIdentity,
    declarations,
    extractor,
  };
  return { ...selector, identity: hashCanonical(selector) };
}

function readCompilerIdentity(): ExtractorIdentity {
  let packagePath: string;
  try {
    packagePath = Bun.resolveSync('typescript/package.json', import.meta.dir);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`TypeScript compiler unavailable: ${detail}`, { cause });
  }
  let packageBytes: Uint8Array;
  try {
    packageBytes = readFileSync(packagePath);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`TypeScript compiler identity unreadable: ${detail}`, { cause });
  }
  if (ts.version.length === 0) throw new Error('TypeScript compiler version unavailable');
  return {
    extractorId: 'typescript.compiler',
    version: `v${ts.version}`,
    blob: hashCanonical({
      packageBytes: Buffer.from(packageBytes).toString('base64'),
      version: ts.version,
    }),
  };
}

/** Extracts resolved imports, provider reverse edges and transitive public declaration surfaces. */
export function extractTypeScriptRelationships(
  workspace: string,
  request: RelationshipRequest['typescript'],
): { extractor: ExtractorIdentity; relationships: TypeScriptRelationships } {
  const extractor = readCompilerIdentity();
  const projects = request.configPaths.map((configPath) => parseProject(workspace, configPath));
  const importsByIdentity = new Map<string, TypeScriptImportSelector>();
  for (const project of projects) {
    for (const sourceFile of project.program.getSourceFiles()) {
      const source = workspacePath(workspace, sourceFile.fileName);
      // Proof: restoring the declaration-file exclusion kept the hidden provider at
      // cb10d2d3... after `additional.d.ts` was added; the production topology test failed.
      if (
        source === undefined ||
        project.program.isSourceFileDefaultLibrary(sourceFile) ||
        project.program.isSourceFileFromExternalLibrary(sourceFile)
      ) {
        continue;
      }
      for (const site of importSites(sourceFile)) {
        const target = resolveDependency(workspace, project, sourceFile, site);
        const selector = {
          source,
          specifier: site.specifier,
          target,
          importKind: site.importKind,
          extractor,
        };
        const identity = hashCanonical(selector);
        importsByIdentity.set(identity, { ...selector, identity });
      }
    }
  }
  const imports = [...importsByIdentity.values()].sort((left, right) =>
    compareText(
      `${left.source}\0${left.specifier}\0${left.importKind}`,
      `${right.source}\0${right.specifier}\0${right.importKind}`,
    ),
  );
  const diagnostics = projects.flatMap((project) => ts.getPreEmitDiagnostics(project.program));
  if (diagnostics.length > 0) {
    // Proof: removing this refusal made the `MissingType` fixture emit declarations and exit 0;
    // the production compiler-failure oracle expected exit 1.
    throw new Error(`TypeScript compiler failed: ${diagnostics.map(formatDiagnostic).join('; ')}`);
  }
  for (const project of projects) emitDeclarations(workspace, project);

  const importersByProvider = new Map<string, TypeScriptReverseEdgeSelector['importers']>();
  for (const edge of imports) {
    if (edge.target.startsWith('external:')) continue;
    const importers = importersByProvider.get(edge.target) ?? [];
    importers.push({ source: edge.source, specifier: edge.specifier, importKind: edge.importKind });
    importersByProvider.set(edge.target, importers);
  }
  const reverseEdges = [...importersByProvider]
    .sort(([left], [right]) => compareText(left, right))
    .map(([provider, importers]) => {
      importers.sort((left, right) =>
        compareText(
          `${left.source}\0${left.specifier}\0${left.importKind}`,
          `${right.source}\0${right.specifier}\0${right.importKind}`,
        ),
      );
      const selector = { provider, importers, extractor };
      return { ...selector, identity: hashCanonical(selector) };
    });

  const publicDeclarations = request.publicEntrypoints
    .map((entrypoint) => {
      const owners = projects.filter((project) => project.declarations.has(entrypoint));
      if (owners.length !== 1) {
        throw new Error(
          `TypeScript public entrypoint ${entrypoint} resolved by ${String(owners.length)} configs; expected exactly one`,
        );
      }
      const owner = owners[0];
      return publicDeclaration(workspace, entrypoint, owner, extractor);
    })
    .sort((left, right) => compareText(left.entrypoint, right.entrypoint));
  return { extractor, relationships: { imports, reverseEdges, publicDeclarations } };
}
