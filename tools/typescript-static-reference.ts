/**
 * Defines the shared checker-backed reference-resolution contract for the
 * architecture tripwire scanners.
 *
 * The resolver centralizes the narrow questions both scanners
 * must answer: whether an alias preserves declaration identity, whether a
 * computed key has a finite set of static names, and whether a reference
 * proves, may select, or cannot select a consumer-supplied target. Keeping
 * those questions here prevents the digest and schema-version policies from
 * drifting into inconsistent default-deny boundaries while leaving their
 * distinct target declarations and reporting contracts in their own modules.
 */
import * as ts from 'typescript';

/**
 * Classifies how conclusively a property-capable expression selects a target.
 *
 * @remarks
 * The discriminant deliberately carries no symbol payload. Consumers need the
 * proof strength, not an arbitrary representative declaration: an exact match
 * can legitimately cover more than one declaration, while a potential match
 * must remain distinguishable from a proven non-match for default-deny policy
 * decisions.
 */
export type PropertyReferenceResolution =
  | { readonly kind: 'exact' }
  | { readonly kind: 'potential' }
  | { readonly kind: 'none' };

/**
 * Resolves the static identity and key information needed by policy-specific
 * architecture scanners.
 *
 * Implementations use the supplied type checker rather than source text
 * so renamed imports, namespace access, literal-type keys, and checker-known
 * property declarations receive the same treatment. An unresolvable key or
 * receiver must preserve uncertainty instead of becoming an accidental
 * exclusion: consumers can deny a potential reference where their contract
 * requires proof, or report it where every possible target selection is
 * unsafe.
 */
export interface StaticReferenceResolver {
  /**
   * Resolves an alias through the checker's alias chain while preserving an
   * absent symbol as absent.
   *
   * @remarks
   * The checker owns alias-chain traversal, so consumers can compare the
   * resulting declaration at their own policy boundary without duplicating
   * alias handling or expanding this helper into a general binding-resolution
   * engine.
   *
   * @param symbol - A checker-resolved symbol that may be an alias.
   * @returns The underlying non-alias symbol for an alias, the original
   * non-alias symbol, or `undefined` when no symbol was available.
   */
  resolveAliasedSymbol(symbol: ts.Symbol | undefined): ts.Symbol | undefined;

  /**
   * Enumerates every statically provable property name selected by a key.
   *
   * The implementation unwraps only transparent expression
   * wrappers, accepts literal values and wholly literal unions, and follows a
   * type-parameter or indexed-access constraint only while that constraint is
   * active on the current recursion path. A missing, circular, non-literal, or
   * mixed-union constraint returns `undefined` so callers retain the dynamic
   * case instead of pretending that it selected no property.
   *
   * @param keyExpression - The expression used as an element or computed key.
   * @returns Every finite static key name, or `undefined` when the key is
   * genuinely dynamic or cannot be resolved safely.
   */
  resolvePropertyKey(keyExpression: ts.Expression): readonly string[] | undefined;

  /**
   * Determines whether a finite or dynamic key set can select one target name.
   *
   * A dynamic key conservatively answers `true`: default-deny consumers must
   * not turn a lack of static proof into proof that the target is absent.
   * Finite sets answer from their members, including `false` for an empty set.
   *
   * @param names - The finite names resolved for a key, or `undefined` for a
   * dynamic key.
   * @param targetName - The property name protected by the consumer policy.
   * @returns Whether the key may select `targetName`.
   */
  propertyKeyMaySelect(names: readonly string[] | undefined, targetName: string): boolean;

  /**
   * Classifies an expression's declaration-identity relationship to a target.
   *
   * The resolver unwraps transparent wrappers around the whole reference and
   * classifies checker-resolved identifiers and property symbols as exact when
   * their checker-dealiased symbol satisfies `isTarget`, or none otherwise.
   * For an `ElementAccessExpression` with finite key candidates, all candidates
   * matching the target produce exact, some but not all matching candidates
   * produce potential, and no matching candidates produce none. For a dynamic
   * (unresolvable) element key, the result is potential when the object type is
   * `any` or `unknown`, or carries any property satisfying `isTarget`; it is
   * none only when the object type is closed and demonstrably lacks a matching
   * property. For a `PropertyAccessExpression` with an unresolved property
   * symbol, an `any`- or `unknown`-typed receiver produces potential, while a
   * closed or concrete receiver produces none.
   *
   * @remarks
   * Unresolvable keys and receivers retain uncertainty so default-deny
   * consumers never turn missing static proof into proof of absence. A
   * `PropertyAccessExpression` or `ElementAccessExpression` target match also
   * follows a shorthand property assignment's own value symbol when its direct
   * property symbol does not match.
   *
   * @param expression - The value, property, or element-access expression to
   * classify.
   * @param isTarget - Tests a checker-dealiased symbol against the
   * consumer's target declaration set.
   * @returns The strongest safe classification for the expression.
   */
  resolvePropertyReference(
    expression: ts.Expression,
    isTarget: (symbol: ts.Symbol) => boolean,
  ): PropertyReferenceResolution;
}

/**
 * Creates a resolver bound to one TypeScript program's type checker.
 *
 * @remarks
 * The constraint walk uses an active recursion stack: it pushes a
 * type before following its base constraint and removes it after that branch
 * returns. Re-entering an active type resolves as unavailable rather than
 * as a safe terminal value, so a circular constraint cannot weaken a
 * default-deny key decision. The helper remains private because only the
 * resolver's key contract is shared by scanners.
 *
 * @param checker - The program checker that supplies symbols, property types,
 * and type constraints.
 * @returns The resolver whose methods share this checker context.
 */
export function createStaticReferenceResolver(checker: ts.TypeChecker): StaticReferenceResolver {
  /**
   * Walks base constraints with the factory's checker and an active
   * recursion stack, returning `undefined` for missing or circular chains.
   */
  const resolveConstraintChain = (type: ts.Type, active = new Set<ts.Type>()): ts.Type | undefined => {
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
  const literalTypeName = (type: ts.Type): string | undefined => {
    if (type.flags & ts.TypeFlags.StringLiteral) return (type as ts.StringLiteralType).value;
    if (type.flags & ts.TypeFlags.NumberLiteral) return String((type as ts.NumberLiteralType).value);
    return undefined;
  };
  const isAnyOrUnknown = (type: ts.Type): boolean => Boolean(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));

  return {
    /** Resolves aliases through the bound checker's alias chain. */
    resolveAliasedSymbol(symbol) {
      return symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    },
    /**
     * Derives finite literal key candidates after wrapper and constraint
     * handling, preserving unresolvable keys as dynamic.
     */
    resolvePropertyKey(keyExpression) {
      const key = unwrapExpression(keyExpression);
      if (ts.isStringLiteral(key) || ts.isNumericLiteral(key)) return [key.text];

      const type = checker.getTypeAtLocation(key);
      const resolvedType = type.flags & (ts.TypeFlags.TypeParameter | ts.TypeFlags.IndexedAccess)
        ? resolveConstraintChain(type)
        : type;
      if (resolvedType === undefined) return undefined;

      if (resolvedType.isUnion()) {
        const names = resolvedType.types.map(literalTypeName);
        return names.every((name) => name !== undefined) ? names as string[] : undefined;
      }
      const name = literalTypeName(resolvedType);
      return name === undefined ? undefined : [name];
    },
    /**
     * Applies the shared default-deny rule that a dynamic key may select the
     * consumer's target.
     */
    propertyKeyMaySelect(names, targetName) {
      return names === undefined || names.includes(targetName);
    },
    /**
     * Classifies wrapped identifiers, dot access, and element access as
     * exact, potential, or none without making consumers infer uncertainty.
     */
    resolvePropertyReference(expression, isTarget) {
      const reference = unwrapExpression(expression);
      const matches = (symbol: ts.Symbol | undefined): boolean => {
        const resolved = symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(symbol)
          : symbol;
        return resolved !== undefined && isTarget(resolved);
      };
      const propertyMatches = (symbol: ts.Symbol | undefined): boolean => (
        matches(symbol)
        || symbol?.declarations?.some((declaration) => (
          ts.isShorthandPropertyAssignment(declaration)
          && matches(checker.getShorthandAssignmentValueSymbol(declaration))
        ))
        || false
      );

      if (ts.isIdentifier(reference)) {
        return matches(checker.getSymbolAtLocation(reference)) ? { kind: 'exact' } : { kind: 'none' };
      }

      if (ts.isPropertyAccessExpression(reference)) {
        const symbol = checker.getSymbolAtLocation(reference);
        if (symbol !== undefined) return propertyMatches(symbol) ? { kind: 'exact' } : { kind: 'none' };
        return isAnyOrUnknown(checker.getTypeAtLocation(reference.expression))
          ? { kind: 'potential' }
          : { kind: 'none' };
      }

      if (ts.isElementAccessExpression(reference)) {
        const receiverType = checker.getTypeAtLocation(reference.expression);
        if (isAnyOrUnknown(receiverType)) return { kind: 'potential' };

        const names = reference.argumentExpression === undefined
          ? undefined
          : this.resolvePropertyKey(reference.argumentExpression);
        if (names === undefined) {
          return checker.getPropertiesOfType(receiverType).some((symbol) => propertyMatches(symbol))
            ? { kind: 'potential' }
            : { kind: 'none' };
        }

        const matchingNames = names.filter((name) => propertyMatches(checker.getPropertyOfType(receiverType, name)));
        if (matchingNames.length === names.length) return { kind: 'exact' };
        return matchingNames.length > 0 ? { kind: 'potential' } : { kind: 'none' };
      }

      return { kind: 'none' };
    },
  };
}
