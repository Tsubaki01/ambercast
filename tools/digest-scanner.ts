/**
 * Provides the checker-backed architecture tripwire for the single production
 * authority of `computeInputsDigest`. The scanner uses declaration identity so
 * import spelling cannot weaken the contract, while its result separates the
 * complete call inventory from the findings that make a call or value use
 * unsafe.
 *
 * The implementation is intentionally a whole-program AST walk rather than a
 * string or regular-expression check. TypeScript's checker is required to
 * distinguish the canonical function from an unrelated same-named local and
 * to follow renamed imports and re-export chains. The walk also
 * examines value-bearing AST shapes that have no ordinary identifier at the
 * reference site, including namespace extraction, shorthand values, bracket
 * access, and star re-exports.
 *
 * The resolver-backed walk routes callee, ordinary value-reference,
 * and destructuring-binding recognition through one checker-backed contract.
 * That common path turns a finite computed key into candidates and retains
 * a dynamic key as uncertainty, so quoted and computed binding names cannot
 * bypass the same declaration-identity boundary that protects direct access.
 * For nested destructuring, each outer binding key receives the same
 * finite-candidate treatment before the walk follows its property type.
 *
 * Call classification distinguishes an exact canonical selection from a
 * potential one. Exact calls remain inventory entries and receive the
 * existing location and argument checks; potential calls instead become an
 * immediate value-reference finding. Both outcomes locally classify their
 * callee selection while continuing through its receiver and computed-key
 * subtrees, so nested storage remains visible without reporting the same
 * selection twice.
 *
 * SCANNER-ASSURANCE: The scanner's SA-1 guarantee is checker-backed
 * declaration identity, default-deny handling, and coverage of calls,
 * identifier/property/element reads, destructuring, and value re-exports.
 * For index-signature selections, function-value targets require H3a-1 type
 * evidence, H3a-2 independently reports aggregate escapes, H1a-2/H1a-3 keep
 * transparent casts visible, and `any` receivers remain default-deny.
 * Architecture checks invoke it only with a diagnostics-free `ts.Program`
 * created from this project's compiler options. SA-2 excludes runtime
 * reflection, compiler transforms, non-production source, checker-invisible
 * mutation, unclassified syntax, and checker or scanner defects. Reads from
 * `any`/`unknown` index slots, dynamic keys on name-identified sinks, and
 * aggregates reachable only through an externally-typed value's signature are
 * outside the guarantee. Two further shapes stay outside the guarantee rather
 * than being closed: a union that includes the protected type as a slot type
 * on an externally declared value — a `declare`, an external type definition,
 * or a cast — can escape aggregate detection, and a direct call reached by
 * narrowing that value afterward is not reported (an in-program value reaches
 * the same slot type through its own construction site instead, which is
 * already reported there); and a structurally compatible call-signature
 * match's `void`-return gate is enforced only on the aggregate-escape path —
 * the index-signature path reports on assignability alone, without that gate,
 * so the two paths disagree on a `void`-returning structural match. None is an
 * allow-path, so a protected authority reached through one requires scanner
 * extension or explicit review.
 */
import * as ts from 'typescript';
import { scanFunctionValueReferences } from './function-value-reference-scanner.js';
import { createStaticReferenceResolver } from './typescript-static-reference.js';

/**
 * Classifies one independently reportable violation in the digest authority
 * contract.
 *
 * The call-location and argument-shape findings remain separate so one
 * malformed call cannot hide another failure. The value-reference finding is
 * the default-deny result for every canonical function use that is not the
 * callee of a resolved call; this keeps the architecture assertion complete
 * without maintaining an ever-growing list of forbidden expression forms.
 */
export type DigestViolationKind =
  | 'call-site-outside-authority'
  | 'argument-must-be-inline-object-literal'
  | 'argument-must-not-contain-spread'
  | 'value-reference-outside-authority-call';

/**
 * Records the source location of a checker-resolved direct call to the
 * canonical digest function.
 *
 * This inventory deliberately carries no nested findings. Callers can assert
 * that exactly the expected authority call exists, while all failures—whether
 * caused by its location, its argument shape, or an unrelated value use—are
 * collected in the scan result's flat `violations` array.
 */
export interface DigestCallSite {
  /** The source file containing the call. */
  readonly fileName: string;
  /** The one-based line containing the call. */
  readonly line: number;
  /** The one-based column at the start of the call expression. */
  readonly column: number;
}

/**
 * Records one digest-contract finding with the source coordinate that a
 * maintainer must inspect.
 *
 * A flat, discriminated record is used because argument-shape and location
 * failures must be visible even when the same call has multiple problems, and
 * value references can be reported at non-call AST nodes such as a binding,
 * element access, or export declaration.
 */
export interface DigestValueReferenceViolation {
  /** The contract rule violated by this source location. */
  readonly kind: DigestViolationKind;
  /** The source file containing the violation. */
  readonly fileName: string;
  /** The one-based line containing the violation. */
  readonly line: number;
  /** The one-based column at the start of the reported node. */
  readonly column: number;
}

/**
 * Finds every checker-resolved call and value reference to
 * `computeInputsDigest` in a TypeScript program.
 *
 * The scanner first resolves the exported function declaration from the
 * supplied digest module and throws if that declaration cannot be found. It
 * then records every direct call in `calls`. A call outside the supplied
 * authority file is a finding, and every resolved call must receive exactly
 * one transparent-wrapper-normalized inline object literal without a spread.
 *
 * All other value references to the same declaration are findings. The
 * shared walk delegates reference classification to
 * `scanFunctionValueReferences`, retaining this scanner's authority-location
 * and argument-shape policy here. That shared walk follows aliases, handles
 * identifier and non-identifier value-bearing syntax, and excludes
 * declaration-introduction plus erased type positions. A callee expression
 * is exempted only when that exact AST node is a resolved direct call;
 * extracting, passing, returning, storing, or re-exporting the function
 * remains outside the authority contract.
 *
 * The shared walk classifies an exact canonical callee as a call-site
 * inventory entry and a potential callee as an unsafe value reference. Its
 * destructuring contract accepts `BindingElement`, `PropertyAssignment`, and
 * `ShorthandPropertyAssignment` leaves. Root declarations and assignments
 * supply their initializer or right-hand-side type; nested leaves recursively
 * derive source types from both declared and innermost transparent-wrapper
 * types, through explicit properties or H3a-1-evidenced applicable index
 * types, then report both exact and potential canonical selections.
 *
 * @param program - The TypeScript program whose non-declaration source files
 * are inspected.
 * @param digestModuleFileName - The source-file name exporting the canonical
 * `computeInputsDigest` function.
 * @param authorityFileName - The only source-file name permitted to invoke the
 * function.
 * @returns An inventory of all resolved calls and a flat list of every call or
 * value-reference violation, each sorted by canonicalized file name, one-based
 * line, and one-based column, with violations sharing a coordinate further
 * ordered by kind.
 * @throws {Error} If the digest module is absent from the program or does not
 * export `computeInputsDigest` as a function declaration.
 * @example
 * ```ts
 * const result = scanComputeInputsDigestAuthority(
 *   program,
 *   digestModuleFileName,
 *   authorityFileName,
 * );
 * expect(result.violations).toEqual([]);
 * expect(result.calls).toHaveLength(1);
 * ```
 */
export function scanComputeInputsDigestAuthority(
  program: ts.Program,
  digestModuleFileName: string,
  authorityFileName: string,
): {
  calls: DigestCallSite[];
  violations: DigestValueReferenceViolation[];
} {
  const canonicalDigestModuleFileName = ts.sys.resolvePath(digestModuleFileName);
  const canonicalAuthorityFileName = ts.sys.resolvePath(authorityFileName);
  const digestModule = program.getSourceFiles().find((sourceFile) => (
    ts.sys.resolvePath(sourceFile.fileName) === canonicalDigestModuleFileName
  ));
  if (digestModule === undefined) {
    throw new Error(`The digest module is not part of this TypeScript program: ${digestModuleFileName}`);
  }

  const checker = program.getTypeChecker();
  const resolver = createStaticReferenceResolver(checker);
  const moduleSymbol = checker.getSymbolAtLocation(digestModule);
  const exportedSymbol = moduleSymbol === undefined
    ? undefined
    : checker.getExportsOfModule(moduleSymbol).find(({ name }) => name === 'computeInputsDigest');
  const canonicalSymbol = resolver.resolveAliasedSymbol(exportedSymbol);
  const canonicalDeclaration = canonicalSymbol?.declarations?.find(ts.isFunctionDeclaration);
  if (canonicalDeclaration === undefined) {
    throw new Error(`The digest module does not export computeInputsDigest as a function: ${digestModuleFileName}`);
  }

  const calls: DigestCallSite[] = [];
  const violations: DigestValueReferenceViolation[] = [];

  const isCanonicalSymbol = (symbol: ts.Symbol): boolean => (
    symbol.declarations?.includes(canonicalDeclaration) ?? false
  );
  const unwrapExpression = (expression: ts.Expression): ts.Expression => {
    let unwrapped = expression;
    while (
      ts.isParenthesizedExpression(unwrapped)
      || ts.isAsExpression(unwrapped)
      || ts.isTypeAssertionExpression(unwrapped)
      || ts.isSatisfiesExpression(unwrapped)
      || ts.isNonNullExpression(unwrapped)
    ) {
      unwrapped = unwrapped.expression;
    }
    return unwrapped;
  };
  const sourceLocation = (sourceFile: ts.SourceFile, node: ts.Node) => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return { fileName: sourceFile.fileName, line: position.line + 1, column: position.character + 1 };
  };
  const recordViolation = (sourceFile: ts.SourceFile, node: ts.Node, kind: DigestViolationKind): void => {
    violations.push({ ...sourceLocation(sourceFile, node), kind });
  };
  const hasSpread = (node: ts.Node): boolean => {
    let found = false;
    const visit = (child: ts.Node): void => {
      if (ts.isSpreadAssignment(child) || ts.isSpreadElement(child)) {
        found = true;
        return;
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };
  const references = scanFunctionValueReferences(program, canonicalDeclaration, isCanonicalSymbol);
  for (const { call } of references.directCalls) {
    const sourceFile = call.getSourceFile();
    calls.push(sourceLocation(sourceFile, call));
    if (ts.sys.resolvePath(sourceFile.fileName) !== canonicalAuthorityFileName) {
      recordViolation(sourceFile, call, 'call-site-outside-authority');
    }
    const argument = call.arguments[0];
    const unwrappedArgument = argument === undefined ? undefined : unwrapExpression(argument);
    if (call.arguments.length !== 1 || unwrappedArgument === undefined || !ts.isObjectLiteralExpression(unwrappedArgument)) {
      recordViolation(sourceFile, call, 'argument-must-be-inline-object-literal');
    } else if (hasSpread(unwrappedArgument)) {
      recordViolation(sourceFile, call, 'argument-must-not-contain-spread');
    }
  }
  for (const { node } of references.unsafeReferences) {
    recordViolation(node.getSourceFile(), node, 'value-reference-outside-authority-call');
  }

  const compareLocation = <T extends { readonly fileName: string; readonly line: number; readonly column: number }>(left: T, right: T): number => (
    ts.sys.resolvePath(left.fileName).localeCompare(ts.sys.resolvePath(right.fileName))
    || left.line - right.line
    || left.column - right.column
  );
  calls.sort(compareLocation);
  violations.sort((left, right) => compareLocation(left, right) || left.kind.localeCompare(right.kind));
  return { calls, violations };
}
