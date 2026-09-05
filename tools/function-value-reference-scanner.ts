/**
 * Provides the checker-backed, policy-neutral value-reference walk shared by
 * architecture scanners that protect one canonical function declaration.
 *
 * The scanner intentionally returns AST nodes instead of coordinates or
 * violation kinds. Consumers retain their authority policy, argument checks,
 * enclosing-function naming, and public ordering rules, while this module
 * keeps declaration identity and first-extraction-point classification
 * consistent across scanner boundaries.
 *
 * SCANNER-ASSURANCE: The scanner's SA-1 guarantee is checker-backed
 * declaration identity, default-deny handling, and coverage of direct calls,
 * identifier/property/element reads, declaration and assignment
 * destructuring, value re-exports, and potential selections. For
 * index-signature selections, function-value targets require H3a-1 type
 * evidence, while H3a-2 independently reports aggregate escapes; H1a-2 and
 * H1a-3 preserve transparent-cast type evidence, and `any` receivers remain
 * default-deny. Architecture
 * checks invoke it only with a diagnostics-free `ts.Program` created from
 * this project's compiler options. SA-2 excludes runtime reflection,
 * compiler transforms, non-production source, checker-invisible mutation,
 * unclassified syntax, and checker or scanner defects. Reads from
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
 * so the two paths disagree on a `void`-returning structural match. None is an allow-path,
 * so a protected authority reached through one requires scanner extension or
 * explicit review. SA-2 also excludes an array literal nested directly in
 * another array literal, both a direct array-literal spread element
 * (`ts.SpreadElement`, such as `[...rest]`) and an object-rest spread nested
 * inside an array-literal element (`ts.SpreadAssignment`, such as
 * `[{ ...rest }]`), and a defaulted array element such as `[value = fallback]`;
 * those shapes need distinct source-position handling and remain
 * intentionally outside this scanner's guarantee. A bare top-level array
 * assignment pattern such as `[value] = source` is also outside the guarantee
 * because it uses a distinct source-position mechanism from this scanner's
 * destructuring-leaf walk.
 */
import * as ts from 'typescript';
import { createStaticReferenceResolver } from './typescript-static-reference.js';

type DestructuringLeaf = ts.BindingElement | ts.PropertyAssignment | ts.ShorthandPropertyAssignment;

type PropertySelectionCandidates = {
  readonly names: readonly string[] | undefined;
  readonly applicability: 'string' | 'number' | 'both';
};

type DestructuringSource = DestructuringLeaf | ts.SpreadAssignment;

/**
 * Records one exact direct invocation of the protected function.
 *
 * Keeping the complete call expression lets a consumer enforce its own
 * argument and location rules without coupling this shared scanner to a
 * particular architecture policy.
 */
export interface FunctionValueReferenceCallSite {
  /** The resolved direct call expression. */
  readonly call: ts.CallExpression;
}

/**
 * Records the first AST node where a protected function value is extracted or
 * selected without an exact direct call.
 *
 * The node preserves source coordinates and enclosing structural context for
 * consumers. Exact and potential callee classification remains anchored at
 * the first extraction point, while aggregate-escape classification reports
 * every qualifying value-position use independently, without alias-chain
 * suppression.
 */
export interface FunctionValueReferenceSite {
  /** The first extraction or uncertain-selection node. */
  readonly node: ts.Node;
}

/**
 * Separates exact direct calls from unsafe function-value references.
 *
 * Both collections are emitted in AST-visitation order. The shared ordering
 * is intentionally not a public coordinate sort because each consumer owns
 * its own result shape and ordering contract.
 */
export interface FunctionValueReferenceScan {
  /** Exact direct calls to the protected function. */
  readonly directCalls: readonly FunctionValueReferenceCallSite[];
  /** Non-call or uncertain references to the protected function. */
  readonly unsafeReferences: readonly FunctionValueReferenceSite[];
}

/**
 * Finds direct calls and unsafe value references to a canonical function.
 *
 * The scanner resolves aliases through `StaticReferenceResolver`.
 * Exact callees become `directCalls`; eligible potential function-valued
 * callees and all other value-bearing extraction forms become
 * `unsafeReferences` at their first extraction point. Index-signature
 * fallback selections require a non-`any`/`unknown` slot type assignable from
 * the protected declaration's own type; ordinary exact or potential resolver
 * results are reported without that gate, and aggregate escapes are an
 * independent additional path. Destructuring preserves `any` and `unknown`
 * sources as potential. It covers local rebinds, declaration and assignment
 * destructuring, property/element extraction,
 * `.bind`/`.call`/`.apply`, argument passing, returns, storage, and value
 * re-exports, while excluding declaration-introduction and erased type
 * positions. Only an `exact` or eligible `potential` callee expression is
 * marked classified. Its receiver and computed-key subtrees remain subject to
 * normal traversal, while the locally classified selection is not revisited.
 * This preserves one finding per owning node without hiding nested storage or
 * key-expression escapes.
 * A `none`-classified callee is not marked classified: its arguments and
 * other children continue normal traversal, so passing the protected function
 * as an argument to an unrelated call can still produce its own finding.
 *
 * @param program - The diagnostics-free TypeScript program to inspect.
 * @param canonicalDeclaration - The function declaration protected by the
 * caller's architecture policy.
 * @param isTarget - Tests a checker-dealiased symbol against that protected
 * declaration set.
 * @returns AST-visitation-ordered exact call and unsafe-reference entries.
 * @example
 * ```ts
 * const references = scanFunctionValueReferences(
 *   program,
 *   canonicalDeclaration,
 *   (symbol) => symbol.declarations?.includes(canonicalDeclaration) ?? false,
 * );
 * ```
 */
export function scanFunctionValueReferences(
  program: ts.Program,
  canonicalDeclaration: ts.FunctionDeclaration,
  isTarget: (symbol: ts.Symbol) => boolean,
): FunctionValueReferenceScan {
  const checker = program.getTypeChecker();
  const resolver = createStaticReferenceResolver(checker);
  const directCalls: FunctionValueReferenceCallSite[] = [];
  const unsafeReferences: FunctionValueReferenceSite[] = [];
  const targetType = checker.getTypeAtLocation(canonicalDeclaration);
  const typeMayContainTargetValue = (type: ts.Type): boolean => (
    !(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
    && checker.isTypeAssignableTo(targetType, type)
  );
  const typeIdentifiesTarget = (type: ts.Type): boolean => {
    const symbols = [type.aliasSymbol, type.getSymbol()];
    return symbols.some((candidate) => {
      const symbol = resolver.resolveAliasedSymbol(candidate);
      return symbol !== undefined && isTarget(symbol);
    });
  };
  const targetReturnsVoid = checker.getSignaturesOfType(targetType, ts.SignatureKind.Call).some((signature) => (
    Boolean(checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.Void)
  ));
  const typeStructurallyIdentifiesTarget = (type: ts.Type): boolean => (
    typeMayContainTargetValue(type)
    && checker.getSignaturesOfType(type, ts.SignatureKind.Call).some((signature) => (
      signature.declaration !== undefined
      && !signature.declaration.getSourceFile().isDeclarationFile
      && (targetReturnsVoid || !(checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.Void))
    ))
  );
  const indexSignatureMaySelect = (_kind: 'string' | 'number', valueType: ts.Type): boolean => (
    typeMayContainTargetValue(valueType)
  );
  const reportedNodes = new Set<ts.Node>();
  const recordUnsafe = (node: ts.Node): void => {
    if (reportedNodes.has(node)) return;
    reportedNodes.add(node);
    unsafeReferences.push({ node });
  };
  const classifiedCallees = new Set<ts.Node>();

  const transparentExpressionOperand = (
    expression: ts.Expression,
    includeAwait: boolean,
  ): ts.Expression | undefined => {
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)
      || ts.isNonNullExpression(expression)) return expression.expression;
    return includeAwait && ts.isAwaitExpression(expression) ? expression.expression : undefined;
  };
  const unwrapExpression = (expression: ts.Expression, includeAwait = false): ts.Expression => {
    let current = expression;
    for (let operand = transparentExpressionOperand(current, includeAwait);
      operand !== undefined;
      operand = transparentExpressionOperand(current, includeAwait)) {
      current = operand;
    }
    return current;
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
  const keyCandidates = (keyNode: ts.PropertyName | ts.BindingName): PropertySelectionCandidates => {
    if (ts.isIdentifier(keyNode) || ts.isStringLiteral(keyNode)) {
      return { names: [keyNode.text], applicability: 'string' };
    }
    if (ts.isNumericLiteral(keyNode)) return { names: [keyNode.text], applicability: 'number' };
    if (!ts.isComputedPropertyName(keyNode)) return { names: undefined, applicability: 'both' };

    return {
      names: resolver.resolvePropertyKey(keyNode.expression),
      applicability: resolver.indexApplicabilityForKey(keyNode.expression),
    };
  };
  const indexTypes = (sourceType: ts.Type, applicability: PropertySelectionCandidates['applicability']): ts.Type[] => [
    ...(applicability === 'string' || applicability === 'both'
      ? [checker.getIndexTypeOfType(sourceType, ts.IndexKind.String)]
      : []),
    ...(applicability === 'number' || applicability === 'both'
      ? [checker.getIndexTypeOfType(sourceType, ts.IndexKind.Number)]
      : []),
  ].filter((type): type is ts.Type => type !== undefined);
  const selectedPropertyTypes = (
    sourceType: ts.Type,
    candidates: PropertySelectionCandidates,
    location: ts.Node,
  ): readonly ts.Type[] => {
    if (candidates.names === undefined) {
      return [
        ...checker.getPropertiesOfType(sourceType).map((property) => (
          checker.getTypeOfSymbolAtLocation(property, location)
        )),
        ...indexTypes(sourceType, candidates.applicability),
      ];
    }
    return candidates.names.flatMap((name) => {
      const property = checker.getPropertyOfType(sourceType, name);
      return property === undefined
        ? indexTypes(sourceType, candidates.applicability)
        : [checker.getTypeOfSymbolAtLocation(property, location)];
    });
  };
  /**
   * Retains the syntactic key for non-positional destructuring leaves. Array
   * bindings derive their positional numeric key through the companion
   * candidate helper, so a local alias never becomes a spurious property name.
   */
  const leafKey = (node: DestructuringLeaf): ts.PropertyName | ts.BindingName => (
    ts.isBindingElement(node) ? node.propertyName ?? node.name : node.name
  );
  /**
   * `node` is always an element of `pattern.elements` here, because this
   * helper is only ever called with `node.parent === pattern`, so `indexOf`
   * never returns `-1` in practice -- a `String(-1)` would otherwise become
   * a bogus key candidate silently, so this invariant matters for
   * `leafKeyCandidates`'s correctness, not merely as an optimization note.
   */
  const arrayBindingElementIndex = (node: ts.BindingElement): string | undefined => {
    const pattern = node.parent;
    return ts.isArrayBindingPattern(pattern) ? String(pattern.elements.indexOf(node)) : undefined;
  };
  const leafKeyCandidates = (node: DestructuringLeaf): PropertySelectionCandidates => {
    if (ts.isBindingElement(node) && node.propertyName === undefined) {
      const index = arrayBindingElementIndex(node);
      if (index !== undefined) return { names: [index], applicability: 'number' };
    }
    return keyCandidates(leafKey(node));
  };
  const outerDestructuringLeaf = (node: DestructuringSource): DestructuringLeaf | undefined => {
    if (ts.isBindingElement(node)) {
      const container = node.parent.parent;
      return ts.isBindingElement(container) ? container : undefined;
    }
    const objectLiteral = node.parent;
    return ts.isObjectLiteralExpression(objectLiteral)
      && (ts.isPropertyAssignment(objectLiteral.parent) || ts.isShorthandPropertyAssignment(objectLiteral.parent))
      ? objectLiteral.parent
      : undefined;
  };
  const sourceTypesThroughWrappers = (expression: ts.Expression): readonly ts.Type[] => {
    const declared = checker.getTypeAtLocation(expression);
    const innermost = unwrapExpression(expression, true);
    const innerType = checker.getTypeAtLocation(innermost);
    return declared === innerType ? [declared] : [declared, innerType];
  };
  const parameterSourceTypes = (parameter: ts.ParameterDeclaration): readonly ts.Type[] => {
    const declared = checker.getTypeAtLocation(parameter);
    if (parameter.initializer === undefined) return [declared];
    const innermost = checker.getTypeAtLocation(unwrapExpression(parameter.initializer, true));
    return declared === innermost ? [declared] : [declared, innermost];
  };
  const isForOfBinding = (declaration: ts.VariableDeclaration): boolean => {
    const list = declaration.parent;
    return ts.isVariableDeclarationList(list)
      && ts.isForOfStatement(list.parent)
      && list.parent.initializer === list;
  };
  const isCatchClauseBinding = (declaration: ts.VariableDeclaration): boolean => (
    ts.isCatchClause(declaration.parent) && declaration.parent.variableDeclaration === declaration
  );
  /**
   * Resolves the element type yielded by a for-of source without consulting
   * the assignment pattern itself: the checker exposes that pattern as a
   * destination-shaped type, which would lose the source's `any` evidence.
   * Numeric index lookup remains the first path because it is the scanner's
   * established exact treatment for array and tuple positions. Other valid
   * iterables need the language's structural iterator protocol instead, so
   * the fallback locates the compiler's escaped `Symbol.iterator` member,
   * obtains its call result, and reads its first type argument: the yielded
   * element type is always that first argument even when the iterator has more
   * arguments (for example, `Iterator<T, TReturn, TNext>`), so `[0]` only
   * ever needs that one. TypeScript has
   * no public checker operation for this general iteration query; retaining
   * the reference guard keeps `getTypeArguments` within its required contract
   * and leaves incomplete iterator shapes unresolved rather than guessing.
   */
  const iterationElementType = (iterableType: ts.Type): ts.Type | undefined => {
    const indexed = checker.getIndexTypeOfType(iterableType, ts.IndexKind.Number);
    if (indexed !== undefined) return indexed;
    const iteratorProperty = checker.getPropertiesOfType(iterableType).find((property) => (
      /^__@iterator@\d+$/.test(property.escapedName as string)
    ));
    if (iteratorProperty === undefined) return undefined;
    const iteratorMethodType = checker.getTypeOfSymbolAtLocation(iteratorProperty, canonicalDeclaration);
    const signature = checker.getSignaturesOfType(iteratorMethodType, ts.SignatureKind.Call)[0];
    if (signature === undefined) return undefined;
    const iteratorReturnType = checker.getReturnTypeOfSignature(signature);
    const isTypeReference = Boolean(iteratorReturnType.flags & ts.TypeFlags.Object)
      && Boolean((iteratorReturnType as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference);
    return isTypeReference ? checker.getTypeArguments(iteratorReturnType as ts.TypeReference)[0] : undefined;
  };
  /**
   * Identifies the assignment-pattern form of a for-of head while preserving
   * the narrowed statement for its source-expression lookup. A
   * same-shape predicate would only restate an already-known object literal
   * and would not safely make the parent's `expression` available; returning
   * the statement makes the ownership relation explicit and rejects nested
   * or declaration-form patterns.
   */
  const forOfAssignmentHead = (literal: ts.ObjectLiteralExpression): ts.ForOfStatement | undefined => {
    const parent = literal.parent;
    return ts.isForOfStatement(parent) && parent.initializer === literal ? parent : undefined;
  };
  /**
   * Resolves the root type that feeds a destructuring chain. Initializers and
   * parameters preserve their wrapper-aware treatment, while for-of and catch
   * bindings use the pattern's own checker type because their source expression
   * is represented outside the declaration.
   */
  const rootDestructuringSourceTypes = (node: DestructuringSource): readonly ts.Type[] | undefined => {
    if (ts.isBindingElement(node)) {
      const container = node.parent.parent;
      if (ts.isVariableDeclaration(container)) {
        if (container.initializer !== undefined) return sourceTypesThroughWrappers(container.initializer);
        if (isForOfBinding(container) || isCatchClauseBinding(container)) {
          return [checker.getTypeAtLocation(container.name)];
        }
        return undefined;
      }
      if (ts.isParameter(container)) return parameterSourceTypes(container);
      return undefined;
    }
    const objectLiteral = node.parent;
    const forOfHead = ts.isObjectLiteralExpression(objectLiteral) ? forOfAssignmentHead(objectLiteral) : undefined;
    if (forOfHead !== undefined) {
      const elementType = iterationElementType(checker.getTypeAtLocation(forOfHead.expression));
      return elementType === undefined ? undefined : [elementType];
    }
    const assignment = ts.isObjectLiteralExpression(objectLiteral) ? objectLiteral.parent : undefined;
    if (assignment === undefined || !ts.isBinaryExpression(assignment)
      || assignment.left !== objectLiteral
      || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
    return sourceTypesThroughWrappers(assignment.right);
  };
  /**
   * Walks from a nested leaf to the root source while applying the key contract
   * at every enclosing property or tuple position. This shares uncertainty and
   * type evidence across declaration and assignment destructuring instead of
   * re-deriving source types at each leaf.
   */
  const destructuringElementSourceTypes = (node: DestructuringSource): readonly ts.Type[] | undefined => {
    const rootTypes = rootDestructuringSourceTypes(node);
    if (rootTypes !== undefined) return rootTypes;

    const outer = outerDestructuringLeaf(node);
    if (outer !== undefined) {
      const outerSourceTypes = destructuringElementSourceTypes(outer);
      if (outerSourceTypes === undefined) return undefined;
      const candidates = leafKeyCandidates(outer);
      const sourceTypes = outerSourceTypes.flatMap((outerSourceType) => {
        if (outerSourceType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return [outerSourceType];
        return selectedPropertyTypes(outerSourceType, candidates, leafKey(outer));
      });
      return sourceTypes.length === 0 ? undefined : sourceTypes;
    }
    return ts.isObjectLiteralExpression(node.parent) ? arrayLiteralElementSourceTypes(node.parent) : undefined;
  };
  /**
   * Resolves the checker type(s) of the array literal that is directly the
   * value of an assignment-destructuring object property, by reusing the same
   * containing-property source-type walk `destructuringElementSourceTypes`
   * already performs for `PropertyAssignment` leaves. Array literal elements
   * have no declaration-name AST shape the way binding-pattern elements do, so
   * this narrow helper substitutes for that walk at exactly one position: the
   * array literal must be a property's own initializer. Object nesting above
   * that containing property is unbounded, because the shared walk it defers
   * to already generalizes across arbitrary depth for the declaration form;
   * this helper does not extend that generalization to an array literal
   * nested inside another array literal or reached through any other shape.
   */
  const containingArrayLiteralTypes = (
    arrayLiteral: ts.ArrayLiteralExpression,
  ): readonly ts.Type[] | undefined => {
    const outer = arrayLiteral.parent;
    if (!ts.isPropertyAssignment(outer) || outer.initializer !== arrayLiteral) return undefined;
    const outerSourceTypes = destructuringElementSourceTypes(outer);
    if (outerSourceTypes === undefined) return undefined;
    const candidates = leafKeyCandidates(outer);
    const types = outerSourceTypes.flatMap((type) => (
      type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
        ? [type]
        : selectedPropertyTypes(type, candidates, outer)
    ));
    return types.length === 0 ? undefined : types;
  };
  /**
   * Supplies the positional source type when an assignment-destructuring leaf
   * is inside an object literal that is itself a direct array-literal element.
   * `outerDestructuringLeaf` deliberately walks an alternating
   * PropertyAssignment/ObjectLiteral chain so each enclosing property can
   * apply its own selection key; that walk stops when an object literal's
   * immediate parent is an array literal rather than a property assignment.
   * This helper first reuses `containingArrayLiteralTypes` to
   * recover the candidate array source types, then derives this direct
   * object's numeric element position and selects that slot from each type.
   * It preserves `any` and `unknown` candidates, while a non-direct
   * element, absent position, or missing slot selection remains unresolved.
   * This preserves the destructuring-only boundary instead of introducing a
   * second source walk or generalizing to nested array literals.
   */
  const arrayLiteralElementSourceTypes = (
    containerLiteral: ts.ObjectLiteralExpression,
  ): readonly ts.Type[] | undefined => {
    const arrayLiteral = containerLiteral.parent;
    if (!ts.isArrayLiteralExpression(arrayLiteral)) return undefined;
    const index = arrayLiteral.elements.indexOf(containerLiteral);
    if (index === -1) return undefined;
    const arrayTypes = containingArrayLiteralTypes(arrayLiteral);
    if (arrayTypes === undefined) return undefined;
    const candidates: PropertySelectionCandidates = { names: [String(index)], applicability: 'number' };
    const types = arrayTypes.flatMap((type) => (
      type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
        ? [type]
        : selectedPropertyTypes(type, candidates, containerLiteral)
    ));
    return types.length === 0 ? undefined : types;
  };
  /**
   * Bare identifiers and direct property- or element-access write targets
   * share this array-slot resolution, so the helper accepts their common
   * expression contract. Its callers retain the AST-shape boundary that
   * excludes defaulted and spread array elements.
   */
  const recordArrayLiteralAssignmentElement = (element: ts.Expression): boolean => {
    const slot = arrayLiteralAssignmentSlot(element);
    if (slot === undefined) return false;
    const { arrayLiteral, index } = slot;
    const arrayTypes = containingArrayLiteralTypes(arrayLiteral);
    if (arrayTypes === undefined) return false;
    const resolutions = arrayTypes.map((type) => (
      resolver.resolvePropertySelection(
        type,
        [String(index)],
        'number',
        isTarget,
        indexSignatureMaySelect,
      ).kind
    ));
    if (resolutions.every((kind) => kind === 'none')) return false;
    recordUnsafe(element);
    return true;
  };
  const reportNodeForDestructuringLeaf = (node: DestructuringLeaf): ts.Node => {
    if (ts.isBindingElement(node) || ts.isShorthandPropertyAssignment(node)) return node.name;
    return ts.isComputedPropertyName(node.name) ? node.name : node.initializer ?? node.name;
  };
  /**
   * Records a leaf only when its source selection is exact or potential. Tuple
   * leaves retain a numeric candidate so declarationless positional symbols can
   * use the resolver's precise type evidence rather than an alias name. Object
   * and array literal property values remain containers rather than leaves so
   * traversal can resolve their nested write targets at their own positions
   * instead of pre-empting that work by reporting the container itself.
   */
  const recordDestructuringReference = (node: DestructuringLeaf): boolean => {
    if (ts.isBindingElement(node) && !ts.isIdentifier(node.name)) return false;
    if (ts.isPropertyAssignment(node)
      && (ts.isObjectLiteralExpression(node.initializer) || ts.isArrayLiteralExpression(node.initializer))) return false;
    const sourceTypes = destructuringElementSourceTypes(node);
    if (sourceTypes === undefined) return false;
    const candidates = leafKeyCandidates(node);
    const resolutions = sourceTypes.map((sourceType) => (
      resolver.resolvePropertySelection(sourceType, candidates.names, candidates.applicability, isTarget, indexSignatureMaySelect).kind
    ));
    const reportNode = reportNodeForDestructuringLeaf(node);
    if (resolutions.every((kind) => kind === 'none')) return false;
    recordUnsafe(reportNode);
    return true;
  };
  const isTransparentWrapper = (node: ts.Node): boolean => (
    ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node) || ts.isAwaitExpression(node)
  );
  /**
   * Finds an array-assignment slot from its inner write target by walking
   * upward through the scanner's existing transparent wrappers. Descending
   * with `unwrapExpression` would answer a different question and make the
   * reporting path lose the target that owns the finding; this walk
   * instead preserves that original node while locating the enclosing slot.
   * The returned index is accepted only when the climbed expression is an
   * actual array element, so callers have one applicability boundary for both
   * wrapped and unwrapped forms without broadening destructuring support.
   */
  const arrayLiteralAssignmentSlot = (
    element: ts.Expression,
  ): { arrayLiteral: ts.ArrayLiteralExpression; index: number } | undefined => {
    let current: ts.Node = element;
    while (isTransparentWrapper(current.parent)) current = current.parent;
    const arrayLiteral = current.parent;
    if (!ts.isArrayLiteralExpression(arrayLiteral)) return undefined;
    const index = arrayLiteral.elements.indexOf(current as ts.Expression);
    return index === -1 ? undefined : { arrayLiteral, index };
  };
  const containsCache = new Map<ts.Type, true>();
  const topLevelContainsCache = new Map<ts.Type, boolean>();
  // H3a-2 follows data-bearing type edges but does not traverse arbitrary call
  // signatures. A source-local signature terminates structurally when H3a-1's
  // one-way target-to-slot assignability holds; requiring its declaration to
  // be in-program preserves SA-2's external-signature boundary without adding
  // an inverse-assignability restriction that would reject wider valid slots.
  // TypeScript's special assignment to a pure `void` return represents a
  // caller discarding a result, not evidence that the slot preserves a
  // non-void target value, so that contextual-only conversion is not a base
  // case unless the protected target itself returns `void`.
  // Positive intermediate results are stable across queries, while a negative
  // result is cached only for the query's top-level root because a cycle can
  // truncate an intermediate walk.
  const typeContainsTarget = (root: ts.Type): boolean => {
    const cached = topLevelContainsCache.get(root);
    if (cached !== undefined) return cached;
    const visited = new Set<ts.Type>();
    visited.add(root);
    const walk = (type: ts.Type): boolean => {
      if (typeIdentifiesTarget(type) || typeStructurallyIdentifiesTarget(type) || containsCache.has(type)) return true;
      if (visited.has(type)) return false;
      visited.add(type);
      const result = !(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) && childrenContainTarget(type);
      if (result) containsCache.set(type, true);
      return result;
    };
    const childrenContainTarget = (type: ts.Type): boolean => (
      type.isUnionOrIntersection()
        ? type.types.some(walk)
        : checker.getPropertiesOfType(type).some((property) => {
          const symbol = resolver.resolveAliasedSymbol(property);
          return (symbol !== undefined && isTarget(symbol))
            || walk(checker.getTypeOfSymbolAtLocation(property, canonicalDeclaration));
          })
          || [ts.IndexKind.String, ts.IndexKind.Number].some((kind) => {
            const indexType = checker.getIndexTypeOfType(type, kind);
            return indexType !== undefined && walk(indexType);
          })
          || (Boolean(type.flags & ts.TypeFlags.Object)
            && Boolean((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference)
            && checker.getTypeArguments(type as ts.TypeReference).some(walk))
    );
    const result = !(root.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) && childrenContainTarget(root);
    if (result) containsCache.set(root, true);
    topLevelContainsCache.set(root, result);
    return result;
  };
  const isDeclarationName = (node: ts.Expression): boolean => {
    const parent = node.parent;
    if (ts.isBindingElement(parent) && parent.name === node) return parent.dotDotDotToken === undefined;
    return (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isPropertyAssignment(parent)
      || ts.isPropertyDeclaration(parent) || ts.isEnumMember(parent) || ts.isFunctionLike(parent)
      || ts.isClassLike(parent) || ts.isMethodDeclaration(parent) || ts.isPropertySignature(parent)
      || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isEnumDeclaration(parent)
      || ts.isModuleDeclaration(parent) || ts.isImportEqualsDeclaration(parent)
      || ts.isTypeParameterDeclaration(parent))
      && (parent as ts.NamedDeclaration).name === node;
  };
  const isObjectDestructuringSource = (node: ts.Expression): boolean => (
    (ts.isVariableDeclaration(node.parent) || ts.isParameter(node.parent))
      && node.parent.initializer === node && ts.isObjectBindingPattern(node.parent.name)
  ) || (
    ts.isBinaryExpression(node.parent) && node.parent.right === node
      && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isObjectLiteralExpression(node.parent.left)
  ) || (
    ts.isForOfStatement(node.parent) && node.parent.expression === node
      && ts.isObjectLiteralExpression(node.parent.initializer)
  );
  const isAssignmentDestructuringTarget = (literal: ts.ObjectLiteralExpression): boolean => {
    const parent = literal.parent;
    return (ts.isBinaryExpression(parent) && parent.left === literal && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      || forOfAssignmentHead(literal) !== undefined
      || ((ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent))
        && ts.isObjectLiteralExpression(parent.parent) && isAssignmentDestructuringTarget(parent.parent));
  };
  /**
   * Keeps assignment-pattern write targets under the leaf/rest source check.
   * Their own declared types describe the destination rather than the value
   * being extracted, so re-evaluating them as aggregate value uses would
   * replace the authoritative source evidence with an unrelated type.
   */
  const isAssignmentDestructuringTargetIdentifier = (node: ts.Expression): boolean => {
    if (!ts.isIdentifier(node)) return false;
    const parent = node.parent;
    const belongsToAssignmentPattern = (leaf: ts.PropertyAssignment | ts.ShorthandPropertyAssignment): boolean => (
      ts.isObjectLiteralExpression(leaf.parent) && isAssignmentDestructuringTarget(leaf.parent)
    );
    if (ts.isSpreadAssignment(parent) && parent.expression === node) {
      return ts.isObjectLiteralExpression(parent.parent) && isAssignmentDestructuringTarget(parent.parent);
    }
    if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
      return belongsToAssignmentPattern(parent);
    }
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
      return belongsToAssignmentPattern(parent);
    }
    if (ts.isBinaryExpression(parent) && parent.left === node
      && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAssignment(parent.parent) && parent.parent.initializer === parent) {
      return belongsToAssignmentPattern(parent.parent);
    }
    return false;
  };
  const isAggregateEscape = (node: ts.Expression): boolean => {
    if (isWithinTypeNode(node) || isDeclarationName(node) || isAssignmentDestructuringTargetIdentifier(node)) return false;
    if (ts.isIdentifier(node) && (isDeclarationIntroduction(node) || ts.isNamespaceExport(node.parent))) return false;
    if (ts.isStringLiteral(node) && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent))) return false;
    if (isTransparentWrapper(node.parent) || isObjectDestructuringSource(node)) return false;
    const innermost = unwrapExpression(node, true);
    if (ts.isObjectLiteralExpression(innermost) || ts.isArrayLiteralExpression(innermost)) return false;
    if (ts.isBinaryExpression(innermost)
      && innermost.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && innermost.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return false;
    if ((ts.isPropertyAccessExpression(innermost) || ts.isElementAccessExpression(innermost))
      && resolver.resolvePropertyReference(innermost, isTarget, indexSignatureMaySelect).kind !== 'none') return false;
    if ((ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent))
      && node.parent.expression === node) return false;
    if ((ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) && node.parent.expression === node) return false;
    const type = checker.getTypeAtLocation(innermost);
    return !typeMayContainTargetValue(type) && typeContainsTarget(type);
  };
  const restDestructuringEscape = (node: ts.BindingElement | ts.SpreadAssignment): boolean => {
    const sourceTypes = destructuringElementSourceTypes(node);
    if (sourceTypes === undefined || !sourceTypes.some(typeContainsTarget)) return false;
    recordUnsafe(ts.isBindingElement(node) ? node.name : node.expression);
    return true;
  };
  const visitDestructuringValueChildren = (node: DestructuringLeaf): void => {
    const name = leafKey(node);
    if (ts.isComputedPropertyName(name)) visit(name.expression);
    if (ts.isBindingElement(node) && node.initializer !== undefined) visit(node.initializer);
    if (ts.isShorthandPropertyAssignment(node) && node.objectAssignmentInitializer !== undefined) {
      visit(node.objectAssignmentInitializer);
    }
    if (ts.isPropertyAssignment(node) && ts.isBinaryExpression(node.initializer)
      && node.initializer.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      visit(node.initializer.right);
    }
  };
  const visitClassifiedCalleeParts = (callee: ts.Expression): void => {
    const reference = unwrapExpression(callee);
    if (ts.isPropertyAccessExpression(reference)) visit(reference.expression);
    if (ts.isElementAccessExpression(reference)) {
      visit(reference.expression);
      if (reference.argumentExpression !== undefined) visit(reference.argumentExpression);
    }
  };
  /**
   * Visits value-bearing syntax while preserving the first authoritative
   * classification for each reference. Assignment-array elements receive a
   * source-aware fallback only after ordinary identity resolution finds no
   * target, which confines that extra path to destructuring writes. After a
   * successful array-slot match, traversal selectively revisits
   * the write target's receiver and, for element access, its computed key before
   * returning so independent target references in those subtrees are retained.
   */
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const resolution = resolver.resolvePropertyReference(node.expression, isTarget, indexSignatureMaySelect);
      if (resolution.kind === 'exact') {
        directCalls.push({ call: node });
        classifiedCallees.add(node.expression);
      } else if (resolution.kind === 'potential') {
        recordUnsafe(node.expression);
        classifiedCallees.add(node.expression);
      }
    } else if (ts.isBindingElement(node) && node.dotDotDotToken !== undefined) {
      if (restDestructuringEscape(node)) return;
    } else if (ts.isSpreadAssignment(node) && ts.isObjectLiteralExpression(node.parent)
      && isAssignmentDestructuringTarget(node.parent)) {
      if (restDestructuringEscape(node)) return;
    } else if (ts.isBindingElement(node) || ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      if (recordDestructuringReference(node)) {
        visitDestructuringValueChildren(node);
        return;
      }
      if (ts.isShorthandPropertyAssignment(node)
        && node.objectAssignmentInitializer === undefined
        && resolver.resolveAliasedSymbol(checker.getShorthandAssignmentValueSymbol(node)) !== undefined
        && isTarget(resolver.resolveAliasedSymbol(checker.getShorthandAssignmentValueSymbol(node)) as ts.Symbol)) {
        recordUnsafe(node.name);
        return;
      }
    } else if (ts.isIdentifier(node)) {
      const reference = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
        ? node.parent
        : node;
      const resolution = resolver.resolvePropertyReference(reference, isTarget, indexSignatureMaySelect);
      if (
        !isDeclarationIntroduction(node)
        && !isWithinTypeNode(node)
        && resolution.kind !== 'none'
      ) {
        recordUnsafe(node);
      } else {
        recordArrayLiteralAssignmentElement(node);
      }
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      let handledByOrdinaryResolution = false;
      if (ts.isElementAccessExpression(node)) {
        const resolution = resolver.resolvePropertyReference(node, isTarget, indexSignatureMaySelect);
        if (resolution.kind !== 'none') {
          recordUnsafe(node);
          handledByOrdinaryResolution = true;
        }
      }
      if (!handledByOrdinaryResolution && recordArrayLiteralAssignmentElement(node)) {
        visit(node.expression);
        if (ts.isElementAccessExpression(node)) visit(node.argumentExpression);
        return;
      }
    } else if (ts.isExportDeclaration(node)
      && !node.isTypeOnly
      && node.moduleSpecifier !== undefined
      && (node.exportClause === undefined || ts.isNamespaceExport(node.exportClause))) {
      const module = checker.getSymbolAtLocation(node.moduleSpecifier);
      if (module !== undefined && checker.getExportsOfModule(module).some((symbol) => (
        resolver.resolveAliasedSymbol(symbol) !== undefined
        && isTarget(resolver.resolveAliasedSymbol(symbol) as ts.Symbol)
      ))) {
        recordUnsafe(node);
      }
    }

    if (ts.isExpression(node) && isAggregateEscape(node)) recordUnsafe(node);

    ts.forEachChild(node, (child) => {
      if (classifiedCallees.has(child)) visitClassifiedCalleeParts(child as ts.Expression);
      else visit(child);
    });
  };

  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile) visit(sourceFile);
  }
  return { directCalls, unsafeReferences };
}
