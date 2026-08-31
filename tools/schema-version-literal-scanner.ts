/**
 * Provides the checker-backed architecture tripwire for schema-version
 * authorities.
 *
 * The scanner recognizes sink syntax across the whole program, then admits
 * only declaration-identity references to the two canonical constants or a
 * direct `.schemaVersion` propagation. A recursive type gate rejects every
 * other number-like, `any`, or `unknown` source, including values hidden in
 * union or intersection members. This keeps the policy default-deny while
 * leaving non-value declarations and string-valued schema metadata outside
 * the sink contract.
 *
 * This checker-based whole-program scan remains independent from
 * `scanSchemaVersionAuthorities` in `architecture.test.ts`. That helper is a
 * test-local, syntax-based direct-import binding check, whereas this scanner
 * resolves declaration identity through the type checker's alias chain and
 * recursively rejects every number-like, `any`, or `unknown` source across
 * the whole program. Extracting their superficially similar recognition
 * would either leak a test-only helper into production tooling or weaken one
 * scanner's deliberately different, default-deny contract.
 */
import * as ts from 'typescript';

/**
 * Identifies a source location that encodes a schema version without a
 * recognized schema authority.
 *
 * Coordinates point to the property or access that bypasses the authority,
 * rather than to a local constant declaration that may be shared by several
 * sinks. This makes each finding actionable and keeps reporting independent
 * from any test framework.
 */
export interface SchemaVersionLiteralViolation {
  /** The source file containing the bypass. */
  readonly fileName: string;
  /** The one-based line containing the bypass. */
  readonly line: number;
  /** The one-based column at the start of the reported property or access. */
  readonly column: number;
}

/**
 * Finds schema-version sinks whose value does not come from an approved
 * authority or direct schema-version propagation.
 *
 * The scanner resolves both canonical constants from the supplied schema
 * module before walking the program and throws if either export is missing.
 * It examines object and class properties, shorthand properties, ordinary and
 * compound assignments, comparisons, and both direct destructuring-default
 * forms. Transparent TypeScript wrappers are removed before source and type
 * checks; static computed keys for `"schemaVersion"` are treated like ordinary
 * keys, while dynamic keys remain outside the statically knowable contract.
 *
 * A source is allowed when its resolved declaration is one of the canonical
 * constants, including renamed, namespace, and multi-hop barrel bindings, or
 * when it is itself a `.schemaVersion`/`['schemaVersion']` propagation.
 * Renamed assignment-pattern defaults are an exception: they are rejected
 * because their source is the compound assignment expression rather than the
 * canonical symbol directly, unlike equivalent renamed variable-declaration
 * binding defaults. Every other source is tested recursively for number-like, `any`, or `unknown`
 * constituents, so arithmetic, calls, conditionals, mixed unions, and
 * untrusted values cannot introduce a literal version through an indirect
 * binding. Declaration-only properties without an initializer have no source
 * to evaluate and are therefore not sinks.
 *
 * @param program - The TypeScript program whose non-declaration source files
 * are inspected.
 * @param schemaModuleFileName - The source-file name exporting both canonical
 * schema-version constants.
 * @returns Source coordinates for every unapproved schema-version sink,
 * sorted by file name, line, and column.
 * @throws {Error} If the schema module is absent or fails to export either
 * `PLAN_SCHEMA_VERSION` or `GROUNDING_SCHEMA_VERSION`.
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
  const canonicalSchemaModuleFileName = ts.sys.resolvePath(schemaModuleFileName);
  const schemaModule = program.getSourceFiles().find((sourceFile) => (
    ts.sys.resolvePath(sourceFile.fileName) === canonicalSchemaModuleFileName
  ));
  if (schemaModule === undefined) {
    throw new Error(`The schema module is not part of this TypeScript program: ${schemaModuleFileName}`);
  }

  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(schemaModule);
  const authorities = ['PLAN_SCHEMA_VERSION', 'GROUNDING_SCHEMA_VERSION'].map((name) => {
    const exported = moduleSymbol === undefined
      ? undefined
      : checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === name);
    const resolved = exported !== undefined && exported.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(exported)
      : exported;
    const declaration = resolved?.declarations?.find(ts.isVariableDeclaration);
    if (declaration === undefined) {
      throw new Error(`The schema module does not export ${name}: ${schemaModuleFileName}`);
    }
    return declaration;
  });

  type Sink = {
    readonly reportNode: ts.Node;
    readonly sourceExpression?: ts.Expression | undefined;
    readonly sourceSymbol?: ts.Symbol | undefined;
  };
  const authorityDeclarations = new Set(authorities);
  const violations: SchemaVersionLiteralViolation[] = [];
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
  const propertyNameText = (name: ts.PropertyName | ts.BindingName): string | undefined => {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
    const expression = ts.isComputedPropertyName(name) ? unwrapExpression(name.expression) : undefined;
    if (expression !== undefined && ts.isStringLiteral(expression)) {
      return expression.text;
    }
    return undefined;
  };
  const isSchemaVersionAccess = (node: ts.Expression): boolean => {
    const access = unwrapExpression(node);
    const key = ts.isElementAccessExpression(access) && access.argumentExpression !== undefined
      ? unwrapExpression(access.argumentExpression)
      : undefined;
    return (
      ts.isPropertyAccessExpression(access) && access.name.text === 'schemaVersion'
    ) || (
      ts.isElementAccessExpression(access)
      && key !== undefined
      && ts.isStringLiteral(key)
      && key.text === 'schemaVersion'
    );
  };
  const resolvesToAuthority = (symbol: ts.Symbol | undefined): boolean => {
    const resolved = symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
    return resolved?.declarations?.some((declaration) => authorityDeclarations.has(declaration as ts.VariableDeclaration)) ?? false;
  };
  const isNumberLikeAnyOrUnknown = (type: ts.Type, visited = new Set<ts.Type>()): boolean => {
    if (visited.has(type)) return false;
    visited.add(type);
    if (type.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
    if (type.isUnionOrIntersection()) return type.types.some((member) => isNumberLikeAnyOrUnknown(member, visited));
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(type);
      return constraint === undefined || isNumberLikeAnyOrUnknown(constraint, visited);
    }
    return false;
  };
  const isAllowedSource = (sink: Sink): boolean => {
    if (sink.sourceSymbol !== undefined) return resolvesToAuthority(sink.sourceSymbol);
    if (sink.sourceExpression === undefined) return true;
    const source = unwrapExpression(sink.sourceExpression);
    if (isSchemaVersionAccess(source)) return true;
    return (ts.isIdentifier(source) || ts.isPropertyAccessExpression(source))
      && resolvesToAuthority(checker.getSymbolAtLocation(source));
  };
  const reportSink = (sourceFile: ts.SourceFile, sink: Sink): void => {
    if (sink.sourceExpression === undefined && sink.sourceSymbol === undefined) return;
    if (isAllowedSource(sink)) return;
    const sourceType = sink.sourceExpression === undefined
      ? checker.getTypeOfSymbolAtLocation(sink.sourceSymbol as ts.Symbol, sink.reportNode)
      : checker.getTypeAtLocation(unwrapExpression(sink.sourceExpression));
    if (!isNumberLikeAnyOrUnknown(sourceType)) return;
    const position = sourceFile.getLineAndCharacterOfPosition(sink.reportNode.getStart(sourceFile));
    violations.push({ fileName: sourceFile.fileName, line: position.line + 1, column: position.character + 1 });
  };
  const comparisonOperators = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
    ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
  ]);
  const assignmentOperators = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken,
    ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken,
    ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken,
    ts.SyntaxKind.AsteriskAsteriskEqualsToken, ts.SyntaxKind.LessThanLessThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken,
    ts.SyntaxKind.CaretEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
  ]);
  const visit = (sourceFile: ts.SourceFile, node: ts.Node): void => {
    if ((ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) && propertyNameText(node.name) === 'schemaVersion') {
      reportSink(sourceFile, { reportNode: node.name, sourceExpression: node.initializer });
    } else if (ts.isShorthandPropertyAssignment(node)) {
      if (node.objectAssignmentInitializer !== undefined && node.name.text === 'schemaVersion') {
        reportSink(sourceFile, { reportNode: node.name, sourceExpression: node.objectAssignmentInitializer });
      } else if (node.objectAssignmentInitializer === undefined && node.name.text === 'schemaVersion') {
        reportSink(sourceFile, { reportNode: node.name, sourceSymbol: checker.getShorthandAssignmentValueSymbol(node) });
      }
    } else if (ts.isBinaryExpression(node) && assignmentOperators.has(node.operatorToken.kind) && isSchemaVersionAccess(node.left)) {
      reportSink(sourceFile, { reportNode: node.left, sourceExpression: node.right });
    } else if (ts.isBinaryExpression(node) && comparisonOperators.has(node.operatorToken.kind)) {
      if (isSchemaVersionAccess(node.left)) reportSink(sourceFile, { reportNode: node.left, sourceExpression: node.right });
      else if (isSchemaVersionAccess(node.right)) reportSink(sourceFile, { reportNode: node.right, sourceExpression: node.left });
    } else if (ts.isBindingElement(node) && node.initializer !== undefined && propertyNameText(node.propertyName ?? node.name) === 'schemaVersion') {
      reportSink(sourceFile, { reportNode: node.propertyName ?? node.name, sourceExpression: node.initializer });
    }
    ts.forEachChild(node, (child) => visit(sourceFile, child));
  };

  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile) visit(sourceFile, sourceFile);
  }
  violations.sort((left, right) => (
    ts.sys.resolvePath(left.fileName).localeCompare(ts.sys.resolvePath(right.fileName))
    || left.line - right.line
    || left.column - right.column
  ));
  return violations;
}
