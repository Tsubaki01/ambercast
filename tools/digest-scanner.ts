import * as ts from 'typescript';

/**
 * Describes every independently reportable digest call-site failure.
 *
 * The scanner reports failures as a collection because an
 * authority-external call can also violate the inline-preimage shape. Keeping
 * both findings prevents a location restriction from masking a structural
 * escape hatch and lets architecture tests require exactly one call in
 * `plan-input-provenance.ts` and none elsewhere. Direct resolved calls are
 * the deliberate boundary: rebinding the imported function to a local
 * variable, such as `const digest = computeInputsDigest`, remains outside the
 * scanner's symbol-at-callee guarantee.
 */
export type DigestCallSiteViolation =
  | 'argument-must-be-inline-object-literal'
  | 'argument-must-not-contain-spread'
  | 'call-site-outside-authority';

/**
 * Records one checker-resolved call to the exported digest function.
 *
 * A call can accumulate multiple findings, rather than selecting an arbitrary
 * primary failure. The scan considers only
 * `plan-input-provenance.ts` an allowed production location, reflecting the
 * one-authority invariant instead of treating the primitive's declaration
 * module as a second permitted caller.
 */
export interface DigestCallSite {
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
  readonly violations: DigestCallSiteViolation[];
}

/**
 * Locates calls resolved by TypeScript to `computeInputsDigest` in a program's
 * non-declaration source files.
 *
 * This deliberate test-support seam complements the syntax-only ESLint rule:
 * it compares declaration identity so renamed imports and namespace calls
 * cannot bypass the digest-input containment contract. The scanner
 * returns every resolved call with all applicable
 * structural and authority-location findings. It flags every call outside
 * `plan-input-provenance.ts` with `call-site-outside-authority`, while
 * retaining the existing spread-free inline-object rule after transparent
 * TypeScript wrappers are removed. Derived nondeterminism inside
 * a scalar remains outside this structural check.
 *
 * @param program - The TypeScript program whose non-declaration sources are
 * inspected.
 * @param digestModuleFileName - The source-file name of the module exporting
 * `computeInputsDigest`.
 * @param authorityFileName - The canonical source-file name allowed to invoke
 * `computeInputsDigest` in production.
 * @returns Every checker-resolved digest call, with zero or more findings for
 * each call site.
 * @throws {Error} If the program omits the digest module or that module does
 * not export `computeInputsDigest` as a function.
 * @example
 * ```ts
 * const calls = scanComputeInputsDigestCalls(
 *   program,
 *   digestModuleFileName,
 *   authorityFileName,
 * );
 * expect(calls.flatMap((call) => call.violations)).toEqual([]);
 * ```
 */
export function scanComputeInputsDigestCalls(
  program: ts.Program,
  digestModuleFileName: string,
  authorityFileName: string,
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
  const canonicalAuthorityFileName = ts.sys.resolvePath(authorityFileName);

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
      const violations: DigestCallSiteViolation[] = [];
      if (ts.sys.resolvePath(sourceFile.fileName) !== canonicalAuthorityFileName) {
        violations.push('call-site-outside-authority');
      }
      if (unwrappedArgument === undefined || !ts.isObjectLiteralExpression(unwrappedArgument)) {
        violations.push('argument-must-be-inline-object-literal');
      } else if (unwrappedArgument.properties.some(ts.isSpreadAssignment)) {
        violations.push('argument-must-not-contain-spread');
      }
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));

      callSites.push({
        fileName: sourceFile.fileName,
        line: position.line + 1,
        column: position.character + 1,
        violations,
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
