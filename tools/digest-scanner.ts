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
 */
import * as ts from 'typescript';

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
  const moduleSymbol = checker.getSymbolAtLocation(digestModule);
  const exportedSymbol = moduleSymbol === undefined
    ? undefined
    : checker.getExportsOfModule(moduleSymbol).find(({ name }) => name === 'computeInputsDigest');
  const canonicalSymbol = exportedSymbol === undefined
    ? undefined
    : exportedSymbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(exportedSymbol)
      : exportedSymbol;
  const canonicalDeclaration = canonicalSymbol?.declarations?.find(ts.isFunctionDeclaration);
  if (canonicalDeclaration === undefined) {
    throw new Error(`The digest module does not export computeInputsDigest as a function: ${digestModuleFileName}`);
  }

  const calls: DigestCallSite[] = [];
  const violations: DigestValueReferenceViolation[] = [];

  const resolvesToCanonical = (symbol: ts.Symbol | undefined): boolean => {
    const resolved = symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
    return resolved?.declarations?.includes(canonicalDeclaration) ?? false;
  };
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
  const expressionResolvesToCanonical = (expression: ts.Expression): boolean => {
    if (resolvesToCanonical(checker.getSymbolAtLocation(expression))) return true;
    return ts.isElementAccessExpression(expression)
      && expression.argumentExpression !== undefined
      && ts.isStringLiteral(expression.argumentExpression)
      && propertyResolvesToCanonical(checker.getTypeAtLocation(expression.expression), expression.argumentExpression.text);
  };
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
      if (outerSourceType !== undefined && ts.isIdentifier(outerPropertyName)) {
        const outerProperty = checker.getPropertyOfType(outerSourceType, outerPropertyName.text);
        if (outerProperty !== undefined) return checker.getTypeOfSymbolAtLocation(outerProperty, outerPropertyName);
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
  const classifiedCallees = new Set<ts.Node>();
  const destructuringBindingSymbols = new Set<ts.Symbol>();

  const visit = (sourceFile: ts.SourceFile, node: ts.Node): void => {
    if (ts.isCallExpression(node) && expressionResolvesToCanonical(node.expression)) {
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
    } else if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const isDestructuringBinding = symbol !== undefined && destructuringBindingSymbols.has(symbol);
      if (!isDestructuringBinding && !isDeclarationIntroduction(node) && !isWithinTypeNode(node) && resolvesToCanonical(symbol)) {
        recordViolation(sourceFile, node, 'value-reference-outside-authority-call');
      }
    } else if (ts.isBindingElement(node)) {
      const sourceType = destructuringSourceType(node);
      const propertyName = node.propertyName ?? node.name;
      if (
        sourceType !== undefined
        && ts.isIdentifier(propertyName)
        && propertyResolvesToCanonical(sourceType, propertyName.text)
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
      && node.argumentExpression !== undefined
      && ts.isStringLiteral(node.argumentExpression)
      && propertyResolvesToCanonical(checker.getTypeAtLocation(node.expression), node.argumentExpression.text)
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
