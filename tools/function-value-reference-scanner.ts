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
 * outside the guarantee; none is an allow-path,
 * so a protected authority reached through one requires scanner extension or
 * explicit review.
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
 * sources as potential. It will cover local rebinds, declaration and assignment
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
  const leafKey = (node: DestructuringLeaf): ts.PropertyName | ts.BindingName => (
    ts.isBindingElement(node) ? node.propertyName ?? node.name : node.name
  );
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
  const rootDestructuringSourceTypes = (node: DestructuringSource): readonly ts.Type[] | undefined => {
    if (ts.isBindingElement(node)) {
      const container = node.parent.parent;
      if (ts.isVariableDeclaration(container) && container.initializer !== undefined) {
        return sourceTypesThroughWrappers(container.initializer);
      }
      if (ts.isParameter(container)) return parameterSourceTypes(container);
      return undefined;
    }
    const objectLiteral = node.parent;
    const assignment = ts.isObjectLiteralExpression(objectLiteral) ? objectLiteral.parent : undefined;
    if (assignment === undefined || !ts.isBinaryExpression(assignment)
      || assignment.left !== objectLiteral
      || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
    return sourceTypesThroughWrappers(assignment.right);
  };
  const destructuringElementSourceTypes = (node: DestructuringSource): readonly ts.Type[] | undefined => {
    const rootTypes = rootDestructuringSourceTypes(node);
    if (rootTypes !== undefined) return rootTypes;

    const outer = outerDestructuringLeaf(node);
    if (outer === undefined) return undefined;
    const outerSourceTypes = destructuringElementSourceTypes(outer);
    if (outerSourceTypes === undefined) return undefined;
    const candidates = keyCandidates(leafKey(outer));
    const sourceTypes = outerSourceTypes.flatMap((outerSourceType) => {
      if (outerSourceType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return [outerSourceType];
      return selectedPropertyTypes(outerSourceType, candidates, leafKey(outer));
    });
    return sourceTypes.length === 0 ? undefined : sourceTypes;
  };
  const reportNodeForDestructuringLeaf = (node: DestructuringLeaf): ts.Node => {
    if (ts.isBindingElement(node) || ts.isShorthandPropertyAssignment(node)) return node.name;
    return ts.isComputedPropertyName(node.name) ? node.name : node.initializer ?? node.name;
  };
  const recordDestructuringReference = (node: DestructuringLeaf): boolean => {
    if (ts.isBindingElement(node) && !ts.isIdentifier(node.name)) return false;
    if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.initializer)) return false;
    const sourceTypes = destructuringElementSourceTypes(node);
    if (sourceTypes === undefined) return false;
    const candidates = keyCandidates(leafKey(node));
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
  );
  const isAssignmentDestructuringTarget = (literal: ts.ObjectLiteralExpression): boolean => {
    const parent = literal.parent;
    return (ts.isBinaryExpression(parent) && parent.left === literal && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
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
      }
    } else if (ts.isElementAccessExpression(node)) {
      const resolution = resolver.resolvePropertyReference(node, isTarget, indexSignatureMaySelect);
      if (resolution.kind !== 'none') {
        recordUnsafe(node);
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
