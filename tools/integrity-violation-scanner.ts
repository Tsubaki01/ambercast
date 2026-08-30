/**
 * Provides the architecture-test inventory for integrity-error construction
 * sites and same-origin navigation checkpoints.
 *
 * The scan resolves direct imports, re-exports, local aliases, and wrapped
 * expressions through TypeScript rather than matching text. It inventories
 * every declared integrity subclass separately from construction sites; more
 * dynamic references that TypeScript cannot resolve to a declaration remain
 * outside this static inventory. Function names are retained as stable
 * structural context while source lines remain free to move.
 */
import * as ts from 'typescript';

export type IntegrityViolationConstructionSite = {
  readonly fileName: string;
  readonly className: string;
  readonly functionName: string;
};

export type SameOriginNavigationCheckpoint = {
  readonly functionName: string;
  readonly planStepNavigation: boolean;
};

export type IntegrityViolationSubclassDeclaration = {
  readonly fileName: string;
  readonly className: string;
};

export function scanIntegrityViolationInventory(
  program: ts.Program,
  integrityViolationModuleFileName: string,
  runModuleFileName: string,
): {
  readonly constructions: readonly IntegrityViolationConstructionSite[];
  readonly checkpoints: readonly SameOriginNavigationCheckpoint[];
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
  return { constructions, checkpoints, declarations };
}
