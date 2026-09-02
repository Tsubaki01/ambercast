/**
 * Provides the architecture-test inventories for integrity-error construction
 * sites, same-origin navigation checkpoints, repairable-navigation-allowlist
 * call sites, and integrity-violation subclass declarations.
 *
 * The scan resolves direct imports, re-exports, local aliases, and wrapped
 * expressions through TypeScript rather than matching text. It inventories
 * every declared integrity subclass separately from construction sites; more
 * dynamic checker-visible selections remain unsafe references rather than an
 * allow-path. Only the runtime or checker-invisible forms listed in SA-2 stay
 * outside this static inventory. Function names are retained as stable
 * structural context while source lines remain free to move.
 *
 * SCANNER-ASSURANCE: The scanner's SA-1 guarantee is checker-backed
 * declaration identity, default-deny handling, and coverage of integrity
 * subclass construction sites and same-origin navigation checkpoints. Its
 * repairable-navigation inventory delegates direct calls,
 * identifier/property/element reads, declaration and assignment
 * destructuring, value re-exports, and potential selections to
 * `scanFunctionValueReferences`, projecting exact direct calls into the
 * allowlist and every other covered reference into `unsafeReferences`. For
 * index-signature selections, function-value targets require H3a-1 type
 * evidence, H3a-2 independently reports aggregate escapes, H1a-2/H1a-3 keep
 * transparent casts visible, and `any` receivers remain default-deny.
 * Architecture checks invoke it only with a diagnostics-free `ts.Program`
 * created from this project's compiler options. SA-2 excludes runtime
 * reflection, compiler transforms, non-production source, checker-invisible
 * mutation, unclassified syntax, and checker or scanner defects. Reads from
 * `any`/`unknown` index slots, dynamic keys on name-identified sinks, and
 * aggregates reachable only through an externally-typed value's signature are
 * outside the guarantee; none is an
 * allow-path, so a protected authority reached through one requires scanner
 * extension or explicit review.
 */
import * as ts from 'typescript';
import { scanFunctionValueReferences } from './function-value-reference-scanner.js';

export type IntegrityViolationConstructionSite = {
  readonly fileName: string;
  readonly className: string;
  readonly functionName: string;
};

export type SameOriginNavigationCheckpoint = {
  readonly functionName: string;
  readonly planStepNavigation: boolean;
};

/**
 * Identifies one direct or unsafe reference location for run.ts's
 * repairable-navigation authority.
 *
 * `fileName` locates the caller's source file, while `functionName` retains
 * stable structural context as source lines move.
 */
export type RepairableNavigationAllowlistCallSite = {
  readonly fileName: string;
  readonly functionName: string;
};

export type IntegrityViolationSubclassDeclaration = {
  readonly fileName: string;
  readonly className: string;
};

/**
 * Inventories integrity-error construction, navigation, and repairable
 * navigation authority usage in a TypeScript program.
 *
 * The implementation resolves the integrity and run-module
 * declarations with the TypeScript checker. Its repairable-navigation portion
 * delegates whole-program function-value classification to
 * `scanFunctionValueReferences`: exact direct calls project into the reviewed
 * allowlist, while every extraction or potential selection projects into
 * `unsafeReferences`. The two arrays deliberately share a structural shape so
 * callers can inspect stable file and enclosing-function context without the
 * shared walker acquiring integrity-specific reporting policy.
 *
 * @param program - The TypeScript program whose non-declaration source files
 * are inspected.
 * @param integrityViolationModuleFileName - The module exporting
 * `IntegrityViolationError`.
 * @param runModuleFileName - The module exporting
 * `isRepairableNavigationFailure` and navigation checkpoints.
 * @returns Construction, checkpoint, direct-call, unsafe-reference, and
 * subclass-declaration inventories.
 * @throws {Error} If either required module or the
 * `IntegrityViolationError` or `isRepairableNavigationFailure` declaration
 * is unavailable to the program.
 * @example
 * ```ts
 * const inventory = scanIntegrityViolationInventory(program, integrityFile, runFile);
 * expect(inventory.unsafeReferences).toEqual([]);
 * ```
 */
export function scanIntegrityViolationInventory(
  program: ts.Program,
  integrityViolationModuleFileName: string,
  runModuleFileName: string,
): {
  readonly constructions: readonly IntegrityViolationConstructionSite[];
  readonly checkpoints: readonly SameOriginNavigationCheckpoint[];
  /**
   * Every exact direct call whose callee resolves to run.ts's exported
   * `isRepairableNavigationFailure`.
   *
   * Entries are resolved by the shared `scanFunctionValueReferences` scanner
   * and projected into this field's `{ fileName, functionName }` shape.
   * Renamed imports and namespace-qualified invocations remain exact direct
   * calls; indirect extractions and potential selections are represented in
   * `unsafeReferences` instead.
   *
   * Entries preserve the AST-visitation order produced by
   * `scanFunctionValueReferences` (source-file iteration, then position).
   * This projection deliberately does not apply a canonicalized-path, line,
   * or column sort.
   */
  readonly allowlistCallSites: readonly RepairableNavigationAllowlistCallSite[];
  /**
   * Every repairable-navigation function value reference that is not an exact
   * direct call.
   *
   * The projection uses the same source-file and enclosing-function
   * context as `allowlistCallSites`. Keeping unsafe forms in a separate,
   * exact inventory makes indirect authority use visible without silently
   * widening the set of reviewed callers.
   *
   * Entries preserve the same AST-visitation order produced by
   * `scanFunctionValueReferences` (source-file iteration, then position),
   * without a canonicalized-path, line, or column sort.
   */
  readonly unsafeReferences: readonly RepairableNavigationAllowlistCallSite[];
  readonly declarations: readonly IntegrityViolationSubclassDeclaration[];
} {
  const checker = program.getTypeChecker();
  const integrityModule = program.getSourceFile(integrityViolationModuleFileName);
  const runModule = program.getSourceFile(runModuleFileName);
  if (integrityModule === undefined || runModule === undefined) {
    throw new Error('The architecture program must include the integrity-error and run modules.');
  }
  const moduleSymbol = checker.getSymbolAtLocation(integrityModule);
  const integritySymbol = moduleSymbol === undefined
    ? undefined
    : checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === 'IntegrityViolationError');
  const integrityDeclaration = integritySymbol?.declarations?.find(ts.isClassDeclaration);
  if (integrityDeclaration === undefined) throw new Error('IntegrityViolationError must have a class declaration.');
  const runModuleSymbol = checker.getSymbolAtLocation(runModule);
  const repairableNavigationFailureSymbol = runModuleSymbol === undefined
    ? undefined
    : checker.getExportsOfModule(runModuleSymbol).find((symbol) => symbol.name === 'isRepairableNavigationFailure');
  const repairableNavigationFailureDeclaration = repairableNavigationFailureSymbol?.declarations?.find(ts.isFunctionDeclaration);
  if (repairableNavigationFailureDeclaration === undefined) {
    throw new Error('isRepairableNavigationFailure must have a function declaration.');
  }

  const unwrapExpression = (expression: ts.Expression): ts.Expression => {
    let current = expression;
    while (ts.isParenthesizedExpression(current)
      || ts.isAsExpression(current)
      || ts.isTypeAssertionExpression(current)
      || ts.isNonNullExpression(current)) {
      current = current.expression;
    }
    return current;
  };
  const resolveSymbol = (expression: ts.Expression): ts.Symbol | undefined => {
    const unwrapped = unwrapExpression(expression);
    let symbol = checker.getSymbolAtLocation(unwrapped);
    const aliases = new Set<ts.Symbol>();
    while (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) {
      if (aliases.has(symbol)) return undefined;
      aliases.add(symbol);
      symbol = checker.getAliasedSymbol(symbol);
    }
    return symbol;
  };
  const classDeclarationFor = (expression: ts.Expression, seen = new Set<ts.Symbol>()): ts.ClassDeclaration | undefined => {
    const symbol = resolveSymbol(expression);
    if (symbol === undefined || seen.has(symbol)) return undefined;
    seen.add(symbol);
    const declaration = symbol.declarations?.find(ts.isClassDeclaration);
    if (declaration !== undefined) return declaration;
    const variable = symbol.declarations?.find(ts.isVariableDeclaration);
    return variable?.initializer === undefined ? undefined : classDeclarationFor(variable.initializer, seen);
  };
  const functionDeclarationFor = (expression: ts.Expression, seen = new Set<ts.Symbol>()): ts.FunctionDeclaration | undefined => {
    const symbol = resolveSymbol(expression);
    if (symbol === undefined || seen.has(symbol)) return undefined;
    seen.add(symbol);
    const declaration = symbol.declarations?.find(ts.isFunctionDeclaration);
    if (declaration !== undefined) return declaration;
    const variable = symbol.declarations?.find(ts.isVariableDeclaration);
    return variable?.initializer === undefined ? undefined : functionDeclarationFor(variable.initializer, seen);
  };
  const classNameIfIntegritySubclass = (expression: ts.Expression): string | undefined => {
    const declaration = classDeclarationFor(expression);
    if (declaration === undefined || declaration.name === undefined) return undefined;
    if (declaration === integrityDeclaration) return declaration.name.text;
    let parent = declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
    while (parent !== undefined) {
      const parentDeclaration = classDeclarationFor(parent);
      if (parentDeclaration === integrityDeclaration) return declaration.name.text;
      parent = parentDeclaration?.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
    }
    return undefined;
  };
  const enclosingFunctionName = (node: ts.Node): string => {
    let current: ts.Node | undefined = node.parent;
    while (current !== undefined) {
      if (ts.isFunctionDeclaration(current) && current.name !== undefined) return current.name.text;
      if (ts.isMethodDeclaration(current) && current.name !== undefined) return current.name.getText();
      current = current.parent;
    }
    return '<module>';
  };

  const constructions: IntegrityViolationConstructionSite[] = [];
  const checkpoints: SameOriginNavigationCheckpoint[] = [];
  const allowlistCallSites: RepairableNavigationAllowlistCallSite[] = [];
  const unsafeReferences: RepairableNavigationAllowlistCallSite[] = [];
  const declarations: IntegrityViolationSubclassDeclaration[] = [];
  const visit = (sourceFile: ts.SourceFile, node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      const declaration = classDeclarationFor(node.name);
      if (declaration !== integrityDeclaration && classNameIfIntegritySubclass(node.name) !== undefined) {
        declarations.push({ fileName: sourceFile.fileName, className: node.name.text });
      }
    }
    if (ts.isNewExpression(node)) {
      const className = classNameIfIntegritySubclass(node.expression);
      if (className !== undefined) constructions.push({ fileName: sourceFile.fileName, className, functionName: enclosingFunctionName(node) });
    }
    if (sourceFile === runModule && ts.isCallExpression(node)
      && functionDeclarationFor(node.expression)?.name?.text === 'assertSameOriginNavigation') {
      const options = node.arguments[2];
      const planStepNavigation = options !== undefined
        && ts.isObjectLiteralExpression(options)
        && options.properties.some((property) => ts.isPropertyAssignment(property)
          && ts.isIdentifier(property.name)
          && property.name.text === 'planStepNavigation'
          && property.initializer.kind === ts.SyntaxKind.TrueKeyword);
      checkpoints.push({ functionName: enclosingFunctionName(node), planStepNavigation });
    }
    ts.forEachChild(node, (child) => visit(sourceFile, child));
  };

  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile) visit(sourceFile, sourceFile);
  }
  const referenceScan = scanFunctionValueReferences(
    program,
    repairableNavigationFailureDeclaration,
    (symbol) => symbol.declarations?.includes(repairableNavigationFailureDeclaration) ?? false,
  );
  for (const { call } of referenceScan.directCalls) {
    allowlistCallSites.push({ fileName: call.getSourceFile().fileName, functionName: enclosingFunctionName(call) });
  }
  for (const { node } of referenceScan.unsafeReferences) {
    unsafeReferences.push({ fileName: node.getSourceFile().fileName, functionName: enclosingFunctionName(node) });
  }
  return { constructions, checkpoints, allowlistCallSites, unsafeReferences, declarations };
}
