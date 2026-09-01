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
 * immediate value-reference finding. Both outcomes mark their callee in
 * `classifiedCallees`, preventing later traversal of a callee's children from
 * reporting the same uncertain reference a second time.
 */
import * as ts from 'typescript';
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
 * checker-backed walk follows aliases in one call, handles identifier and
 * non-identifier value-bearing syntax, and ignores declaration-introduction
 * positions plus erased type positions. A callee expression is exempted only
 * when that exact AST node was classified as a resolved call; extracting,
 * passing, returning, storing, or re-exporting the function remains outside
 * the authority contract.
 *
 * The resolver makes the classification explicit: only an exact
 * canonical selection is a call-site inventory entry, while a potential
 * selection is reported immediately as an unsafe value reference. The
 * same resolver supplies ordinary value and element-access recognition,
 * and destructuring uses its finite key candidates for identifier,
 * quoted, and computed property names at both direct and nested positions.
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

  /**
   * Tests whether a symbol identifies the canonical function declaration.
   *
   * One-hop alias normalization belongs to
   * the shared resolver, leaving this predicate responsible only for the
   * digest scanner's declaration-specific policy boundary.
   */
  const resolvesToCanonical = (symbol: ts.Symbol | undefined): boolean => {
    const resolved = resolver.resolveAliasedSymbol(symbol);
    return resolved?.declarations?.includes(canonicalDeclaration) ?? false;
  };
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
  const isWithinTypeNode = (node: ts.Node): boolean => {
    for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
      if (ts.isTypeNode(current)) return true;
    }
    return false;
  };
  const isDeclarationIntroduction = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return true;
    if (ts.isExportSpecifier(parent)) {
      const exportDeclaration = ts.isNamedExports(parent.parent) && ts.isExportDeclaration(parent.parent.parent)
        ? parent.parent.parent
        : undefined;
      if (parent.isTypeOnly || exportDeclaration?.isTypeOnly) return true;
      return parent.propertyName !== undefined && parent.name === node;
    }
    return ts.isFunctionDeclaration(parent) && parent === canonicalDeclaration && parent.name === node;
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
  const propertyResolvesToCanonical = (sourceType: ts.Type, name: string): boolean => (
    resolvesToCanonical(checker.getPropertyOfType(sourceType, name))
  );
  /**
   * Finds the type from which a destructuring binding obtains its value.
   *
   * The nested walk resolves both direct and outer binding names
   * through the shared resolver's finite key candidates. Identifier, quoted,
   * and resolvable computed names therefore follow the same property
   * identity path; a dynamic or multi-candidate outer key remains deliberately
   * unresolved rather than guessing a deep destructuring source.
   */
  const destructuringSourceType = (node: ts.BindingElement): ts.Type | undefined => {
    const pattern = node.parent;
    const container = pattern.parent;
    if (ts.isVariableDeclaration(container) && container.initializer !== undefined) {
      return checker.getTypeAtLocation(container.initializer);
    }
    if (ts.isParameter(container)) {
      return checker.getTypeAtLocation(container.initializer ?? container);
    }
    if (ts.isBindingElement(container)) {
      const outerSourceType = destructuringSourceType(container);
      const outerPropertyName = container.propertyName ?? container.name;
      const outerNames = bindingElementPropertyCandidateNames(outerPropertyName);
      if (outerSourceType !== undefined && outerNames?.length === 1) {
        const [outerName] = outerNames;
        if (outerName !== undefined) {
          const outerProperty = checker.getPropertyOfType(outerSourceType, outerName);
          if (outerProperty !== undefined) return checker.getTypeOfSymbolAtLocation(outerProperty, outerPropertyName);
        }
      }
    }
    return undefined;
  };
  const assignmentDestructuringTarget = (
    node: ts.ShorthandPropertyAssignment | ts.PropertyAssignment,
  ): ts.Expression | undefined => {
    const objectLiteral = node.parent;
    if (!ts.isObjectLiteralExpression(objectLiteral)) return undefined;
    const assignment = objectLiteral.parent;
    return ts.isBinaryExpression(assignment)
      && assignment.left === objectLiteral
      && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ? assignment.right
      : undefined;
  };
  /**
   * Records callee expressions whose reference classification already owns
   * their descendant traversal.
   *
   * The potential-call path enters this set as well as the exact
   * call path, because a later visit to an element key or property name would
   * otherwise turn one uncertain selection into duplicate value findings.
   */
  const classifiedCallees = new Set<ts.Node>();
  const destructuringBindingSymbols = new Set<ts.Symbol>();
  /**
   * Resolves destructuring property names with the same finite-key rule as
   * element access, so quoted and computed keys cannot bypass identity checks.
   */
  const bindingElementPropertyCandidateNames = (
    keyNode: ts.PropertyName | ts.BindingName,
  ): readonly string[] | undefined => {
    if (ts.isIdentifier(keyNode) || ts.isStringLiteral(keyNode) || ts.isNumericLiteral(keyNode)) {
      return [keyNode.text];
    }
    return ts.isComputedPropertyName(keyNode)
      ? resolver.resolvePropertyKey(keyNode.expression)
      : undefined;
  };
  const bindingElementResolvesToCanonical = (
    sourceType: ts.Type,
    keyNode: ts.PropertyName | ts.BindingName,
  ): boolean => {
    const names = bindingElementPropertyCandidateNames(keyNode);
    return names === undefined
      ? propertyResolvesToCanonical(sourceType, 'computeInputsDigest')
      : names.some((name) => propertyResolvesToCanonical(sourceType, name));
  };

  const visit = (sourceFile: ts.SourceFile, node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const resolution = resolver.resolvePropertyReference(node.expression, isCanonicalSymbol);
      if (resolution.kind === 'exact') {
        classifiedCallees.add(node.expression);
        calls.push(sourceLocation(sourceFile, node));
        if (ts.sys.resolvePath(sourceFile.fileName) !== canonicalAuthorityFileName) {
          recordViolation(sourceFile, node, 'call-site-outside-authority');
        }
        const argument = node.arguments[0];
        const unwrappedArgument = argument === undefined ? undefined : unwrapExpression(argument);
        if (node.arguments.length !== 1 || unwrappedArgument === undefined || !ts.isObjectLiteralExpression(unwrappedArgument)) {
          recordViolation(sourceFile, node, 'argument-must-be-inline-object-literal');
        } else if (hasSpread(unwrappedArgument)) {
          recordViolation(sourceFile, node, 'argument-must-not-contain-spread');
        }
      } else if (resolution.kind === 'potential') {
        classifiedCallees.add(node.expression);
        recordViolation(sourceFile, node.expression, 'value-reference-outside-authority-call');
      }
    } else if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const isDestructuringBinding = symbol !== undefined && destructuringBindingSymbols.has(symbol);
      const reference = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
        ? node.parent
        : node;
      if (
        !isDestructuringBinding
        && !isDeclarationIntroduction(node)
        && !isWithinTypeNode(node)
        && resolver.resolvePropertyReference(reference, isCanonicalSymbol).kind !== 'none'
      ) {
        recordViolation(sourceFile, node, 'value-reference-outside-authority-call');
      }
    } else if (ts.isBindingElement(node)) {
      const sourceType = destructuringSourceType(node);
      const propertyName = node.propertyName ?? node.name;
      if (
        sourceType !== undefined
        && bindingElementResolvesToCanonical(sourceType, propertyName)
      ) {
        if (ts.isIdentifier(node.name)) {
          const bindingSymbol = checker.getSymbolAtLocation(node.name);
          if (bindingSymbol !== undefined) destructuringBindingSymbols.add(bindingSymbol);
        }
        recordViolation(sourceFile, node.name, 'value-reference-outside-authority-call');
        return;
      }
    } else if (ts.isShorthandPropertyAssignment(node)) {
      const target = assignmentDestructuringTarget(node);
      if (target !== undefined && propertyResolvesToCanonical(checker.getTypeAtLocation(target), node.name.text)) {
        recordViolation(sourceFile, node.name, 'value-reference-outside-authority-call');
      } else if (node.objectAssignmentInitializer === undefined && resolvesToCanonical(checker.getShorthandAssignmentValueSymbol(node))) {
        recordViolation(sourceFile, node.name, 'value-reference-outside-authority-call');
      }
    } else if (ts.isPropertyAssignment(node)) {
      const target = assignmentDestructuringTarget(node);
      if (target !== undefined && ts.isIdentifier(node.name) && propertyResolvesToCanonical(checker.getTypeAtLocation(target), node.name.text)) {
        recordViolation(sourceFile, node.name, 'value-reference-outside-authority-call');
      }
    } else if (
      ts.isElementAccessExpression(node)
      && resolver.resolvePropertyReference(node, isCanonicalSymbol).kind !== 'none'
    ) {
      recordViolation(sourceFile, node, 'value-reference-outside-authority-call');
    } else if (
      ts.isExportDeclaration(node)
      && !node.isTypeOnly
      && node.moduleSpecifier !== undefined
      && (node.exportClause === undefined || ts.isNamespaceExport(node.exportClause))
    ) {
      const module = checker.getSymbolAtLocation(node.moduleSpecifier);
      if (module !== undefined && checker.getExportsOfModule(module).some((symbol) => resolvesToCanonical(symbol))) {
        recordViolation(sourceFile, node, 'value-reference-outside-authority-call');
      }
    }

    ts.forEachChild(node, (child) => {
      if (!classifiedCallees.has(child)) visit(sourceFile, child);
    });
  };

  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile) visit(sourceFile, sourceFile);
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
