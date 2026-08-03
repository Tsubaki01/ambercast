import * as ts from 'typescript';

/** Describes the two input-shape failures the digest call-site scan reports. */
export type DigestCallViolation =
  | 'argument-must-be-inline-object-literal'
  | 'argument-must-not-contain-spread';

/** Records one checker-resolved call to the exported digest function. */
export interface DigestCallSite {
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
  readonly violation: DigestCallViolation | undefined;
}

/**
 * Locates calls resolved by TypeScript to `computeInputsDigest` in a program's
 * non-declaration source files.
 *
 * This deliberate test-support seam complements the syntax-only ESLint rule:
 * it compares declaration identity so renamed imports and namespace calls
 * cannot bypass the digest-input containment contract. The
 * scanner returns every resolved call, with a violation only when its argument
 * is not one spread-free inline object literal after removing transparent
 * TypeScript wrappers. Derived nondeterminism inside a scalar remains outside
 * the scope of this structural check.
 */
export function scanComputeInputsDigestCalls(
  program: ts.Program,
  digestModuleFileName: string,
): DigestCallSite[] {
  const digestModule = program.getSourceFile(digestModuleFileName);

  if (digestModule === undefined) {
    throw new Error(`The digest module is not part of this TypeScript program: ${digestModuleFileName}`);
  }

  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(digestModule);
  const digestSymbol = moduleSymbol === undefined
    ? undefined
    : checker.getExportsOfModule(moduleSymbol).find(({ name }) => name === 'computeInputsDigest');
  const digestDeclaration = digestSymbol?.declarations?.find(ts.isFunctionDeclaration);

  if (digestDeclaration === undefined) {
    throw new Error(`The digest module does not export computeInputsDigest: ${digestModuleFileName}`);
  }

  const targetDeclaration = digestDeclaration;

  const callSites: DigestCallSite[] = [];

  function resolvesToDigestDeclaration(callee: ts.Expression): boolean {
    const symbol = checker.getSymbolAtLocation(callee);

    if (symbol === undefined) {
      return false;
    }

    const resolvedSymbol = symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;

    return resolvedSymbol.declarations?.includes(targetDeclaration) ?? false;
  }

  /**
   * Removes syntax-only expression wrappers before enforcing the digest input
   * contract. Parentheses and TypeScript assertions do not change the runtime
   * object passed to the function, so treating them as a different input shape
   * would reject valid calls; inspecting the final expression also ensures a
   * spread nested inside any number of wrappers remains visible.
   */
  function unwrapDigestArgument(expression: ts.Expression): ts.Expression {
    let unwrapped = expression;

    while (
      ts.isParenthesizedExpression(unwrapped)
      || ts.isAsExpression(unwrapped)
      || ts.isSatisfiesExpression(unwrapped)
      || ts.isTypeAssertionExpression(unwrapped)
    ) {
      unwrapped = unwrapped.expression;
    }

    return unwrapped;
  }

  function visit(sourceFile: ts.SourceFile, node: ts.Node): void {
    if (ts.isCallExpression(node) && resolvesToDigestDeclaration(node.expression)) {
      const argument = node.arguments.length === 1 ? node.arguments[0] : undefined;
      const unwrappedArgument = argument === undefined ? undefined : unwrapDigestArgument(argument);
      const violation = unwrappedArgument === undefined || !ts.isObjectLiteralExpression(unwrappedArgument)
        ? 'argument-must-be-inline-object-literal'
        : unwrappedArgument.properties.some(ts.isSpreadAssignment)
          ? 'argument-must-not-contain-spread'
          : undefined;
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));

      callSites.push({
        fileName: sourceFile.fileName,
        line: position.line + 1,
        column: position.character + 1,
        violation,
      });
    }

    ts.forEachChild(node, (child) => visit(sourceFile, child));
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) {
      continue;
    }

    visit(sourceFile, sourceFile);
  }

  return callSites;
}
