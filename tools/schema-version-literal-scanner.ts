/**
 * Declares the repository-wide guard against bypassing schema-version
 * authorities with numeric literals.
 *
 * The scanner normalizes transparent TypeScript wrappers before inspecting an
 * expression and follows local numeric constants used by
 * `schemaVersion`, so parentheses, assertions, and local indirection cannot
 * conceal a competing version. Its exception is limited to the canonical
 * constant declarations in `core/ir/schema.ts`; even a literal object field in
 * that file remains a violation. Direct named imports are the supported
 * authority reference form: barrel and namespace imports are intentionally
 * outside this scanner's syntactic binding-resolution boundary.
 *
 * This checker-based whole-program scan remains independent from
 * `scanSchemaVersionAuthorities` in `architecture.test.ts`. That helper is a
 * test-local, syntax-based direct-import binding check, whereas this scanner
 * must resolve local numeric constants and distinguish the canonical
 * declaration module across a `ts.Program`. Extracting their superficially
 * similar recognition would either leak test-only helpers into production
 * tooling or weaken one scanner's deliberately different contract.
 */
import * as ts from 'typescript';

/**
 * Identifies a source location that encodes a schema version without a
 * recognized schema authority.
 *
 * Results retain source coordinates rather than merely a
 * count, so architecture failures can direct maintainers to the bypass while
 * the scanner stays independent of test-framework reporting.
 * For an indirect numeric constant, the reported coordinate is the
 * `schemaVersion` property or comparison use site, rather than the constant
 * declaration. This makes the result identify the authority bypass that must
 * be replaced and remains stable when a local declaration has multiple uses.
 */
export interface SchemaVersionLiteralViolation {
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
}

/**
 * Finds schema-version literals and unrecognized numeric indirections in a
 * TypeScript program.
 *
 * The caller supplies the canonical schema module path so the narrow
 * declaration exception is based on declaration identity rather than a
 * repository-relative string guess. The scan examines every
 * non-declaration source file in the supplied program; constructing that
 * program from the production source root remains the architecture test's
 * responsibility.
 *
 * @param program - The TypeScript program containing production sources to
 * inspect.
 * @param schemaModuleFileName - The canonical module allowed to declare the
 * schema-version constants.
 * @returns Every location that bypasses the supported direct-import
 * authorities.
 * @example
 * ```ts
 * const violations = scanSchemaVersionLiteralViolations(
 *   program,
 *   schemaModuleFileName,
 * );
 * expect(violations).toEqual([]);
 * ```
 */
export function scanSchemaVersionLiteralViolations(
  program: ts.Program,
  schemaModuleFileName: string,
): SchemaVersionLiteralViolation[] {
  const checker = program.getTypeChecker();
  const canonicalSchemaFileName = ts.sys.resolvePath(schemaModuleFileName);
  const canonicalAuthorities = new Set(['PLAN_SCHEMA_VERSION', 'GROUNDING_SCHEMA_VERSION']);
  const violations: SchemaVersionLiteralViolation[] = [];

  function unwrap(expression: ts.Expression): ts.Expression {
    let current = expression;
    while (
      ts.isParenthesizedExpression(current)
      || ts.isAsExpression(current)
      || ts.isSatisfiesExpression(current)
      || ts.isTypeAssertionExpression(current)
      || ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  }

  function isNumericSymbol(symbol: ts.Symbol | undefined, seen: Set<ts.Symbol>): boolean {
    const resolved = symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
    if (resolved === undefined || seen.has(resolved)) return false;
    const declaration = resolved.declarations?.find(ts.isVariableDeclaration);
    if (
      declaration === undefined
      || !ts.isIdentifier(declaration.name)
      || declaration.initializer === undefined
    ) {
      return false;
    }
    seen.add(resolved);
    return isNumericExpression(declaration.initializer, seen);
  }

  function isNumericExpression(expression: ts.Expression, seen = new Set<ts.Symbol>()): boolean {
    const current = unwrap(expression);
    if (ts.isNumericLiteral(current)) return true;
    if (
      ts.isPrefixUnaryExpression(current)
      && (current.operator === ts.SyntaxKind.MinusToken || current.operator === ts.SyntaxKind.PlusToken)
    ) {
      return ts.isNumericLiteral(unwrap(current.operand));
    }
    if (!ts.isIdentifier(current) && !ts.isPropertyAccessExpression(current)) return false;

    return isNumericSymbol(checker.getSymbolAtLocation(current), seen);
  }

  function isDirectNamedSchemaAuthoritySymbol(symbol: ts.Symbol | undefined): boolean {
    const declaration = symbol?.declarations?.find(ts.isImportSpecifier);
    if (declaration === undefined) return false;
    const authorityName = declaration.propertyName?.text ?? declaration.name.text;
    const importDeclaration = declaration.parent.parent.parent;
    if (!ts.isImportDeclaration(importDeclaration) || !ts.isStringLiteral(importDeclaration.moduleSpecifier)) {
      return false;
    }
    const resolution = ts.resolveModuleName(
      importDeclaration.moduleSpecifier.text,
      declaration.getSourceFile().fileName,
      program.getCompilerOptions(),
      ts.sys,
    ).resolvedModule;
    return canonicalAuthorities.has(authorityName)
      && resolution !== undefined
      && ts.sys.resolvePath(resolution.resolvedFileName) === canonicalSchemaFileName;
  }

  function isDirectNamedSchemaAuthority(expression: ts.Expression): boolean {
    const current = unwrap(expression);
    return ts.isIdentifier(current)
      && isDirectNamedSchemaAuthoritySymbol(checker.getSymbolAtLocation(current));
  }

  function isSchemaVersionAccess(expression: ts.Expression): boolean {
    const current = unwrap(expression);
    const argument = ts.isElementAccessExpression(current) && current.argumentExpression !== undefined
      ? unwrap(current.argumentExpression)
      : undefined;
    return (
      ts.isPropertyAccessExpression(current)
      && current.name.text === 'schemaVersion'
    ) || (
      argument !== undefined
      && ts.isStringLiteral(argument)
      && argument.text === 'schemaVersion'
    );
  }

  function schemaVersionCoordinate(expression: ts.Expression): ts.Node {
    const current = unwrap(expression);
    return ts.isPropertyAccessExpression(current) ? current.name : current;
  }

  /**
   * Recognizes ordinary and computed string property names. A computed name
   * is in scope only when its transparent-wrapped expression is the literal
   * `"schemaVersion"`; dynamic computed keys remain out of scope because this
   * syntax-directed scanner cannot know their runtime binding.
   */
  function isSchemaVersionPropertyName(name: ts.PropertyName): boolean {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text === 'schemaVersion';
    if (!ts.isComputedPropertyName(name)) return false;
    const expression = unwrap(name.expression);
    return ts.isStringLiteral(expression) && expression.text === 'schemaVersion';
  }

  function report(sourceFile: ts.SourceFile, node: ts.Node): void {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const violation = { fileName: sourceFile.fileName, line: position.line + 1, column: position.character + 1 };
    violations.push(violation);
  }

  function isBypass(expression: ts.Expression): boolean {
    return !isDirectNamedSchemaAuthority(expression) && isNumericExpression(expression);
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;

    function visit(node: ts.Node): void {
      if (ts.isPropertyAssignment(node) && isSchemaVersionPropertyName(node.name)) {
        if (isBypass(node.initializer)) report(sourceFile, node);
      } else if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'schemaVersion') {
        if (
          !isDirectNamedSchemaAuthoritySymbol(checker.getShorthandAssignmentValueSymbol(node))
          && isNumericSymbol(checker.getShorthandAssignmentValueSymbol(node), new Set())
        ) report(sourceFile, node);
      } else if (ts.isPropertyDeclaration(node) && isSchemaVersionPropertyName(node.name) && node.initializer !== undefined) {
        if (isBypass(node.initializer)) report(sourceFile, node);
      } else if (ts.isBinaryExpression(node)) {
        if (isSchemaVersionAccess(node.left) && isBypass(node.right)) report(sourceFile, schemaVersionCoordinate(node.left));
        if (isSchemaVersionAccess(node.right) && isBypass(node.left)) report(sourceFile, schemaVersionCoordinate(node.right));
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return violations.sort((left, right) => {
    if (left.fileName !== right.fileName) return left.fileName < right.fileName ? -1 : 1;
    if (left.line !== right.line) return left.line - right.line;
    return left.column - right.column;
  });
}
