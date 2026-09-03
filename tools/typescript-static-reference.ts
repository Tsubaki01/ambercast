/**
 * Defines the shared checker-backed reference-resolution contract for the
 * architecture tripwire scanners.
 *
 * The resolver centralizes the narrow questions its consumer scanners
 * must answer: whether an alias preserves declaration identity, whether a
 * computed key has a finite set of static names, and whether a reference
 * proves, may select, or cannot select a consumer-supplied target. Keeping
 * those questions here prevents the digest and schema-version policies from
 * drifting into inconsistent default-deny boundaries while leaving their
 * distinct target declarations and reporting contracts in their own modules.
 *
 * Scanner modules build their SA-1 property/element-access guarantee on this
 * primitive: it preserves declaration identity and uncertainty instead of
 * allowing a missing checker fact to look like proof of absence. The primitive
 * is deliberately policy-neutral, so scanners retain ownership of the
 * protected declarations and of the findings they report.
 */
import * as ts from 'typescript';

export type IndexSignatureMaySelect = (
  kind: 'string' | 'number',
  valueType: ts.Type,
  candidate: string | undefined,
) => boolean;

const anyIndexSignatureMaySelect: IndexSignatureMaySelect = () => true;

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
   * Determines which index-signature kinds a property key can address.
   *
   * @remarks
   * Publishing this rule once prevents property-selection callers from
   * drifting into different index-signature boundaries. The implementation
   * delegates to the same transparent-wrapper unwrapping and constraint-chain
   * walk as `resolvePropertyKey`, so finite names and index applicability are
   * derived from one view of the key expression.
   *
   * @param keyExpression - The element or computed-property key, if one is
   * available.
   * @returns `'string'` or `'number'` for an unambiguous key type, or
   * `'both'` for mixed, unknown, unresolved, or unavailable key information.
   */
  indexApplicabilityForKey(keyExpression: ts.Expression | undefined): 'string' | 'number' | 'both';

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
   * Classifies whether a property selection can resolve to a consumer-supplied
   * target declaration.
   *
   * An `any` or `unknown` receiver returns `potential` before candidate
   * handling, including when the finite candidate list is empty. Otherwise,
   * explicit properties take precedence over index signatures because a
   * declaration identity is stronger evidence than a structural fallback. For
   * every finite candidate, an absent explicit property falls back to an
   * index signature permitted by `indexApplicability`: an applicable index is
   * `potential` only when `indexSignatureMaySelect` accepts its value type,
   * kind, and candidate. A declarationless numeric property uses its own
   * precise checker type as that evidence, because a tuple index has no
   * declaration identity while the tuple-wide number index would lose the
   * selected position. The optional predicate defaults to `true`, preserving
   * the legacy unconditional fallback for consumers that do not need stronger
   * evidence; a supplied predicate can require consumer-specific type evidence.
   * The resolver returns `exact` only when every finite
   * candidate selects a target property, `none` only when checker information
   * proves every candidate cannot select one, and `potential` for all
   * remaining mixtures or uncertainty. A defined empty candidate list returns
   * `none` only after the receiver short-circuit: it proves that no key can be
   * selected rather than vacuously satisfying an aggregate classification.
   *
   * @remarks
   * Candidate strings do not preserve whether a literal key was originally
   * string- or number-typed, so applicability must be derived once from the
   * key expression before resolving its names. Callers obtain the
   * `indexApplicability` argument through
   * `indexApplicabilityForKey(keyExpression)`. A string-literal key expression
   * or an identifier/string-literal property name uses the string index kind,
   * while a numeric-literal key expression or property name uses the number
   * kind. The published method owns the remaining type and constraint
   * handling so callers share one derivation boundary instead of duplicating
   * its mechanics.
   *
   * When `keyCandidates` is `undefined`, the resolver handles one conceptual
   * dynamic candidate. It returns `potential` when either a declared property
   * with at least one matching declaration exists or an index signature permitted by
   * `indexApplicability` exists; it returns `none` otherwise. This preserves
   * uncertainty without treating a dynamic key as proof that every declared
   * property can be selected.
   *
   * @param receiverType - The checker type of the object being selected from.
   * @param keyCandidates - Finite key names, an empty finite set, or
   * `undefined` when the key is dynamic.
   * @param indexApplicability - The index-signature kind justified by the
   * key's own static type: `'string'` for `StringLike`-only,
   * `'number'` for `NumberLike`-only, and `'both'` for mixed, `any`,
   * `unknown`, unresolved, or unavailable key information.
   * @param isTarget - Tests a checker-dealiased property symbol against the
   * declaration set protected by the caller.
   * @returns Whether the selection is proven to target, may target, or is
   * proven unable to target the protected declaration.
   * @example
   * ```ts
   * const result = resolver.resolvePropertySelection(
   *   checker.getTypeAtLocation(receiver),
   *   resolver.resolvePropertyKey(key),
   *   'string',
   *   isCanonicalSymbol,
   *   indexSignatureMaySelect,
   * );
   * ```
   */
  resolvePropertySelection(
    receiverType: ts.Type,
    keyCandidates: readonly string[] | undefined,
    indexApplicability: 'string' | 'number' | 'both',
    isTarget: (symbol: ts.Symbol) => boolean,
    indexSignatureMaySelect?: IndexSignatureMaySelect,
  ): PropertyReferenceResolution;

  /**
   * Classifies an expression's declaration-identity relationship to a target.
   *
   * The resolver unwraps transparent wrappers around the whole reference and
   * classifies checker-resolved identifiers directly. Its property
   * and element branches delegate to `resolvePropertySelection`, giving dot
   * access one string-kind candidate and element access the candidates plus
   * index applicability derived from its argument expression. This keeps an
   * unresolved dot property on an open index-signature receiver in the same
   * default-deny boundary as the equivalent bracket access.
   *
   * @remarks
   * Unresolvable keys and receivers retain uncertainty so default-deny
   * consumers never turn missing static proof into proof of absence. A
   * `PropertyAccessExpression` or `ElementAccessExpression` target match also
   * follows a shorthand property assignment's own value symbol when its direct
   * property symbol does not match. A synthesized union property is exact only
   * when every contributing declaration identifies the target; a mixed set
   * remains potential so a representative declaration cannot grant authority
   * to an unrelated member.
   * Property and element accesses judge both the receiver's declared type and
   * its innermost transparent-wrapper type, retaining the strongest result.
   * A non-matching explicit property therefore does not prevent the innermost
   * type from supplying a target-compatible index fallback.
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
    indexSignatureMaySelect?: IndexSignatureMaySelect,
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
  const matches = (symbol: ts.Symbol | undefined, isTarget: (candidate: ts.Symbol) => boolean): boolean => {
    const resolved = symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
    return resolved !== undefined && isTarget(resolved);
  };
  /**
   * Preserves the uncertainty of synthesized properties that merge several
   * declarations, rather than letting one matching representative authorize
   * every union member. Each declaration is resolved at its own name before
   * identity comparison; shorthand declarations retain their value-symbol
   * exception. Declarationless checker symbols keep the ordinary direct-symbol
   * behavior because no per-declaration evidence exists to divide.
   */
  const propertyMatches = (
    symbol: ts.Symbol | undefined,
    isTarget: (candidate: ts.Symbol) => boolean,
  ): 'exact' | 'potential' | 'none' => {
    if (symbol === undefined) return 'none';
    const declarations = symbol.declarations ?? [];
    if (declarations.length === 0) return matches(symbol, isTarget) ? 'exact' : 'none';
    const matchingDeclarations = declarations.filter((declaration) => {
      const name = ts.getNameOfDeclaration(declaration);
      const localSymbol = name === undefined ? undefined : checker.getSymbolAtLocation(name);
      return matches(localSymbol, isTarget)
        || (ts.isShorthandPropertyAssignment(declaration)
          && matches(checker.getShorthandAssignmentValueSymbol(declaration), isTarget));
    });
    if (matchingDeclarations.length === declarations.length) return 'exact';
    return matchingDeclarations.length === 0 ? 'none' : 'potential';
  };
  const hasApplicableIndexSignature = (
    receiverType: ts.Type,
    indexApplicability: 'string' | 'number' | 'both',
    indexSignatureMaySelect: IndexSignatureMaySelect,
    candidate: string | undefined,
  ): boolean => ([
    ...(indexApplicability === 'string' || indexApplicability === 'both' ? [ts.IndexKind.String] : []),
    ...(indexApplicability === 'number' || indexApplicability === 'both' ? [ts.IndexKind.Number] : []),
  ] as const).some((kind) => {
    const valueType = checker.getIndexTypeOfType(receiverType, kind);
    return valueType !== undefined
      && indexSignatureMaySelect(kind === ts.IndexKind.String ? 'string' : 'number', valueType, candidate);
  });
  const indexApplicabilityForKeyExpression = (
    keyExpression: ts.Expression | undefined,
  ): 'string' | 'number' | 'both' => {
    if (keyExpression === undefined) return 'both';
    const key = unwrapExpression(keyExpression);
    if (ts.isStringLiteral(key)) return 'string';
    if (ts.isNumericLiteral(key)) return 'number';

    const type = checker.getTypeAtLocation(key);
    const resolvedType = type.flags & (ts.TypeFlags.TypeParameter | ts.TypeFlags.IndexedAccess)
      ? resolveConstraintChain(type)
      : type;
    if (resolvedType === undefined || isAnyOrUnknown(resolvedType)) return 'both';
    const members = resolvedType.isUnion() ? resolvedType.types : [resolvedType];
    const stringOnly = members.every((member) => Boolean(member.flags & ts.TypeFlags.StringLike));
    const numberOnly = members.every((member) => Boolean(member.flags & ts.TypeFlags.NumberLike));
    return stringOnly ? 'string' : numberOnly ? 'number' : 'both';
  };

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
    indexApplicabilityForKey(keyExpression) {
      return indexApplicabilityForKeyExpression(keyExpression);
    },
    /**
     * Applies the shared default-deny rule that a dynamic key may select the
     * consumer's target.
     */
    propertyKeyMaySelect(names, targetName) {
      return names === undefined || names.includes(targetName);
    },
    resolvePropertySelection(
      receiverType,
      keyCandidates,
      indexApplicability,
      isTarget,
      indexSignatureMaySelect = anyIndexSignatureMaySelect,
    ) {
      if (isAnyOrUnknown(receiverType)) return { kind: 'potential' };
      if (keyCandidates !== undefined && keyCandidates.length === 0) return { kind: 'none' };

      if (keyCandidates === undefined) {
        return checker.getPropertiesOfType(receiverType).some((symbol) => propertyMatches(symbol, isTarget) !== 'none')
          || hasApplicableIndexSignature(receiverType, indexApplicability, indexSignatureMaySelect, undefined)
          ? { kind: 'potential' }
          : { kind: 'none' };
      }

      const candidateKinds = keyCandidates.map((key) => {
        const property = checker.getPropertyOfType(receiverType, key);
        const declarationless = property !== undefined && (property.declarations?.length ?? 0) === 0;
        if (indexApplicability === 'number' && declarationless) {
          return indexSignatureMaySelect(
            'number',
            checker.getTypeOfSymbol(property as ts.Symbol),
            key,
          ) ? 'potential' : 'none';
        }
        if (property !== undefined) return propertyMatches(property, isTarget);
        return hasApplicableIndexSignature(receiverType, indexApplicability, indexSignatureMaySelect, key) ? 'potential' : 'none';
      });
      if (candidateKinds.every((kind) => kind === 'exact')) return { kind: 'exact' };
      if (candidateKinds.every((kind) => kind === 'none')) return { kind: 'none' };
      return { kind: 'potential' };
    },
    /**
     * Classifies wrapped identifiers, dot access, and element access as
     * exact, potential, or none without making consumers infer uncertainty.
     */
    resolvePropertyReference(expression, isTarget, indexSignatureMaySelect = anyIndexSignatureMaySelect) {
      const reference = unwrapExpression(expression);

      if (ts.isIdentifier(reference)) {
        return matches(checker.getSymbolAtLocation(reference), isTarget) ? { kind: 'exact' } : { kind: 'none' };
      }

      const receiverTypes = (receiver: ts.Expression): readonly ts.Type[] => {
        const declared = checker.getTypeAtLocation(receiver);
        const innermost = checker.getTypeAtLocation(unwrapExpression(receiver));
        return declared === innermost ? [declared] : [declared, innermost];
      };
      const strongest = (results: readonly PropertyReferenceResolution[]): PropertyReferenceResolution => (
        results.some((result) => result.kind === 'exact') ? { kind: 'exact' }
          : results.some((result) => result.kind === 'potential') ? { kind: 'potential' }
            : { kind: 'none' }
      );

      if (ts.isPropertyAccessExpression(reference)) {
        const symbol = checker.getSymbolAtLocation(reference);
        if (symbol !== undefined && propertyMatches(symbol, isTarget) === 'exact') return { kind: 'exact' };
        return strongest(receiverTypes(reference.expression).map((receiverType) => this.resolvePropertySelection(
          receiverType,
          [reference.name.text],
          'string',
          isTarget,
          indexSignatureMaySelect,
        )));
      }

      if (ts.isElementAccessExpression(reference)) {
        return strongest(receiverTypes(reference.expression).map((receiverType) => this.resolvePropertySelection(
          receiverType,
          reference.argumentExpression === undefined ? undefined : this.resolvePropertyKey(reference.argumentExpression),
          this.indexApplicabilityForKey(reference.argumentExpression),
          isTarget,
          indexSignatureMaySelect,
        )));
      }

      return { kind: 'none' };
    },
  };
}
