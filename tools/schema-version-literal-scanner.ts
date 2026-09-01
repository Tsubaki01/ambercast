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
 *
 * The resolver-backed form applies the same finite/dynamic computed-key
 * reasoning to schema-version sinks and authority sources. Property and
 * element access are recognized only after the resolver establishes or
 * preserves their declaration identity, while declaration-site property names
 * use the resolver's key candidates symmetrically. A bare identifier named
 * `schemaVersion` remains outside access recognition: only property or element
 * access can describe a schema-version sink.
 *
 * The source gate preserves an assertion expression when it asks the checker
 * for its type, because the asserted `any`, `unknown`, or number-like type—not
 * an unwrapped inner literal—is the security-relevant value. Its recursive
 * type check uses an active recursion stack for type-parameter and
 * indexed-access constraints; an absent or circular constraint denies as
 * unknown rather than terminating as safe. Authority sources require an
 * `exact` resolver classification, so an ambiguous computed key remains denied
 * even when one candidate is canonical.
 */
import * as ts from 'typescript';
import { createStaticReferenceResolver } from './typescript-static-reference.js';

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
 * forms. Transparent TypeScript wrappers are removed for key and source-
 * identity checks, while the type gate retains the source expression itself so
 * assertions cannot hide its final type. Static computed keys for
 * `"schemaVersion"` are treated like ordinary keys, while dynamic keys retain
 * default-deny uncertainty.
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
 * The type gate preserves assertion nodes while unwrapping only for key
 * resolution and source-identity recognition. Its constraint traversal treats
 * TypeParameter and IndexedAccess cycles as unknown-like denials. An allowed
 * authority source requires exact identity from the shared resolver, whereas a
 * potential computed selection stays unapproved. Sink access requires an
 * actual property or element access, excluding a local identifier merely named
 * `schemaVersion`; computed declaration names use the same key-candidate rule
 * as computed access names.
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
  const resolver = createStaticReferenceResolver(checker);
  const moduleSymbol = checker.getSymbolAtLocation(schemaModule);
  const authorities = ['PLAN_SCHEMA_VERSION', 'GROUNDING_SCHEMA_VERSION'].map((name) => {
    const exported = moduleSymbol === undefined
      ? undefined
      : checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === name);
    const resolved = resolver.resolveAliasedSymbol(exported);
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
  /**
   * Removes wrappers that do not affect key resolution or source identity.
   *
   * The type gate intentionally does not use this helper before obtaining a
   * source type: an assertion node's own static type is required to reject
   * assertion-based bypasses.
   */
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
  /**
   * Determines whether a declaration-site property name can select the sink.
   *
   * Direct names preserve the simple literal path. Computed names use the
   * resolver's finite candidates and default-deny dynamic result instead of
   * collapsing a non-singleton union into one misleading text value.
   */
  const isSchemaVersionPropertyName = (name: ts.PropertyName | ts.BindingName): boolean => {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
      return name.text === 'schemaVersion';
    }
    return ts.isComputedPropertyName(name)
      && resolver.propertyKeyMaySelect(resolver.resolvePropertyKey(name.expression), 'schemaVersion');
  };
  /**
   * Determines whether an expression is a schema-version property access.
   *
   * The predicate unwraps transparent wrappers, then requires a property or
   * element access before consulting the resolver. This explicit shape guard
   * prevents an unrelated local identifier named `schemaVersion` from becoming
   * a sink merely because the generic resolver can classify identifiers.
   */
  const isSchemaVersionAccess = (node: ts.Expression): boolean => {
    const access = unwrapExpression(node);
    if (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) return false;
    return resolver.resolvePropertyReference(access, (symbol) => symbol.name === 'schemaVersion').kind !== 'none';
  };
  /**
   * Tests whether a symbol identifies either canonical authority declaration.
   *
   * The shared resolver owns checker alias-chain normalization; this
   * scanner-specific predicate only tests the approved declaration set.
   */
  const resolvesToAuthorityTarget = (symbol: ts.Symbol): boolean => (
    symbol.declarations?.some((declaration) => authorityDeclarations.has(declaration as ts.VariableDeclaration)) ?? false
  );
  const resolvesToAuthority = (symbol: ts.Symbol | undefined): boolean => {
    const resolved = resolver.resolveAliasedSymbol(symbol);
    return resolved !== undefined && resolvesToAuthorityTarget(resolved);
  };
  /**
   * Resolves generic constraints while preserving the active recursion path.
   *
   * A missing or circular constraint remains unresolved so callers can deny it
   * instead of treating an unknown source or index as safe.
   */
  const resolveConstraintChain = (type: ts.Type, active: Set<ts.Type>): ts.Type | undefined => {
    if (!(type.flags & (ts.TypeFlags.TypeParameter | ts.TypeFlags.IndexedAccess))) return type;
    if (active.has(type)) return undefined;

    active.add(type);
    try {
      const constraint = checker.getBaseConstraintOfType(type);
      return constraint === undefined ? undefined : resolveConstraintChain(constraint, active);
    } finally {
      active.delete(type);
    }
  };
  const literalPropertyNames = (type: ts.Type): readonly string[] | undefined => {
    const literalName = (candidate: ts.Type): string | undefined => {
      if (candidate.flags & ts.TypeFlags.StringLiteral) return (candidate as ts.StringLiteralType).value;
      if (candidate.flags & ts.TypeFlags.NumberLiteral) return String((candidate as ts.NumberLiteralType).value);
      return undefined;
    };
    if (type.isUnion()) {
      const names = type.types.map(literalName);
      return names.every((name) => name !== undefined) ? names as string[] : undefined;
    }
    const name = literalName(type);
    return name === undefined ? undefined : [name];
  };
  /**
   * Determines whether a source type must remain subject to the sink policy.
   *
   * The recursion tracks only the active path, pushing before a union member
   * or base constraint and removing it after that branch returns. Re-entering
   * an active type, finding no constraint, or encountering a dynamic indexed
   * key answers `true` as unknown-like so no uncertain source creates an allow
   * path. A finite indexed key set examines every candidate property, because
   * one number-like, `any`, or `unknown` member is sufficient to deny it.
   */
  const isNumberLikeAnyOrUnknown = (type: ts.Type, active = new Set<ts.Type>()): boolean => {
    if (active.has(type)) return true;
    if (type.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
    if (type.isUnionOrIntersection()) {
      active.add(type);
      try {
        return type.types.some((member) => isNumberLikeAnyOrUnknown(member, active));
      } finally {
        active.delete(type);
      }
    }
    if (type.flags & ts.TypeFlags.IndexedAccess) {
      const indexed = type as ts.IndexedAccessType;
      active.add(type);
      try {
        const objectType = resolveConstraintChain(indexed.objectType, active);
        const indexType = resolveConstraintChain(indexed.indexType, active);
        const propertyNames = indexType === undefined ? undefined : literalPropertyNames(indexType);
        if (objectType === undefined || propertyNames === undefined) return true;
        if (active.has(indexed.objectType)) return true;
        active.add(indexed.objectType);
        try {
          return propertyNames.some((propertyName) => {
            const property = checker.getPropertyOfType(objectType, propertyName);
            const propertyType = property === undefined ? undefined : checker.getTypeOfSymbol(property);
            return propertyType === undefined || isNumberLikeAnyOrUnknown(propertyType, active);
          });
        } finally {
          active.delete(indexed.objectType);
        }
      } finally {
        active.delete(type);
      }
    }
    if (type.flags & ts.TypeFlags.TypeParameter) {
      active.add(type);
      try {
        const constraint = checker.getBaseConstraintOfType(type);
        return constraint === undefined || isNumberLikeAnyOrUnknown(constraint, active);
      } finally {
        active.delete(type);
      }
    }
    return false;
  };
  /**
   * Preserves unknown's default-deny treatment across TypeScript's non-null
   * assertion normalization through transparent non-null wrapper chains.
   *
   * The checker represents `unknown!` as `{}` at the assertion node in the
   * current compiler, despite the source retaining no authority proof. Peeling
   * only parenthesized and non-null wrappers tests the input to each assertion
   * without treating type assertions as transparent.
   */
  const isNonNullAssertionOfUnknown = (expression: ts.Expression): boolean => {
    let current = expression;
    while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) {
      if (
        ts.isNonNullExpression(current)
        && Boolean(checker.getTypeAtLocation(current.expression).flags & ts.TypeFlags.Unknown)
      ) return true;
      current = current.expression;
    }
    return false;
  };
  /**
   * Determines whether a sink source is a proven canonical authority or a
   * direct schema-version propagation.
   *
   * An expression authority source is allowed only when its resolver
   * classification is `exact`. A `potential` result is intentionally not
   * enough: an ambiguous or dynamic key may select an authority, but it does
   * not prove that the current value came from one.
   */
  const isAllowedSource = (sink: Sink): boolean => {
    if (sink.sourceSymbol !== undefined) return resolvesToAuthority(sink.sourceSymbol);
    if (sink.sourceExpression === undefined) return true;
    if (isSchemaVersionAccess(sink.sourceExpression)) return true;
    return resolver.resolvePropertyReference(sink.sourceExpression, resolvesToAuthorityTarget).kind === 'exact';
  };
  /**
   * Records an unapproved sink whose source remains number-like or unknown.
   *
   * The expression-backed type gate inspects `sink.sourceExpression` itself
   * rather than an unwrapped inner expression, preserving an assertion's final
   * type so `as any`, `as unknown`, and number-like assertion chains cannot
   * bypass the policy.
   */
  const reportSink = (sourceFile: ts.SourceFile, sink: Sink): void => {
    if (sink.sourceExpression === undefined && sink.sourceSymbol === undefined) return;
    if (isAllowedSource(sink)) return;
    const sourceType = sink.sourceExpression === undefined
      ? checker.getTypeOfSymbolAtLocation(sink.sourceSymbol as ts.Symbol, sink.reportNode)
      : checker.getTypeAtLocation(sink.sourceExpression);
    const isUnknownNonNullSource = sink.sourceExpression !== undefined
      && isNonNullAssertionOfUnknown(sink.sourceExpression);
    if (!isNumberLikeAnyOrUnknown(sourceType) && !isUnknownNonNullSource) return;
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
    if ((ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) && isSchemaVersionPropertyName(node.name)) {
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
    } else if (ts.isBindingElement(node) && node.initializer !== undefined && isSchemaVersionPropertyName(node.propertyName ?? node.name)) {
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
