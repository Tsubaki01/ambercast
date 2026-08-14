/**
 * Provides the bounded architecture-test guard for direct reads of
 * detection-only accessibility-capture fields.
 *
 * It recognizes named property access and object destructuring, not bracket
 * access such as `capture['rawYaml']` or whole-capture/spread propagation.
 * Those unrecognized paths are an accepted, documented scope limit: this is a
 * declaration-aware direct-access check, not a complete data-flow proof that
 * detection-only values cannot reach a sink.
 */
import * as ts from 'typescript';

/** Records one resolved read of a detection-only accessibility-capture field. */
export type AccessibilityCaptureFieldAccessSite = {
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
  readonly field: 'rawYaml' | 'scalarValues';
  readonly allowed: boolean;
};

/**
 * Locates reads of `AccessibilityCapture`'s detection-only fields in a
 * program's non-declaration source files.
 *
 * The scanner resolves the `rawYaml` and `scalarValues` declarations exported
 * by the ports module, then compares declaration identity rather than field
 * spelling. That keeps unrelated same-named values outside this security
 * boundary and makes an allowlist expansion an explicit architectural choice.
 *
 * Property access resolves its identifier symbol directly because TypeScript
 * associates it with the accessed property. Destructuring instead resolves
 * the object binding pattern's type and asks that type for the effective
 * source property: a binding identifier names the newly introduced local, so
 * resolving it directly can lose the declaration being read. Each resolved
 * site records whether its file is in the supplied allowlist.
 *
 * Failure to resolve the ports source file, its exported
 * `AccessibilityCapture` type, or either target property declaration is a
 * configuration error and must throw. Returning no sites is reserved for a
 * correctly configured program with no matching direct reads, so a broken
 * architecture test cannot pass vacuously.
 *
 * @param program - The TypeScript program containing the ports module and
 *   source files to inspect.
 * @param portsModuleFileName - The source file exporting `AccessibilityCapture`.
 * @param allowedFileNames - Source files permitted to read detection-only
 *   fields.
 * @returns Every checker-resolved property access or destructuring read of a
 *   detection-only field.
 * @throws If the ports source, `AccessibilityCapture` export, `rawYaml`
 *   declaration, or `scalarValues` declaration cannot be resolved.
 */
export function scanAccessibilityCaptureFieldAccess(
  program: ts.Program,
  portsModuleFileName: string,
  allowedFileNames: ReadonlySet<string>,
): AccessibilityCaptureFieldAccessSite[] {
  const portsModule = program.getSourceFile(portsModuleFileName);
  if (portsModule === undefined) {
    throw new Error(`The ports module is not part of this TypeScript program: ${portsModuleFileName}`);
  }

  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(portsModule);
  const accessibilityCaptureSymbol = moduleSymbol === undefined
    ? undefined
    : checker.getExportsOfModule(moduleSymbol).find(({ name }) => name === 'AccessibilityCapture');
  if (accessibilityCaptureSymbol === undefined) {
    throw new Error(`The ports module does not export AccessibilityCapture: ${portsModuleFileName}`);
  }

  const accessibilityCaptureType = checker.getDeclaredTypeOfSymbol(accessibilityCaptureSymbol);
  const targetDeclarations = new Map<AccessibilityCaptureFieldAccessSite['field'], ts.Declaration>();
  for (const field of ['rawYaml', 'scalarValues'] as const) {
    const declaration = accessibilityCaptureType.getProperty(field)?.declarations?.find(ts.isPropertySignature);
    if (declaration === undefined) {
      throw new Error(`AccessibilityCapture does not declare ${field}: ${portsModuleFileName}`);
    }
    targetDeclarations.set(field, declaration);
  }

  const accessSites: AccessibilityCaptureFieldAccessSite[] = [];

  function resolvesToTargetDeclaration(
    symbol: ts.Symbol | undefined,
    field: AccessibilityCaptureFieldAccessSite['field'],
  ): boolean {
    if (symbol === undefined) {
      return false;
    }

    const resolvedSymbol = symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
    const targetDeclaration = targetDeclarations.get(field);

    return targetDeclaration !== undefined
      && (resolvedSymbol.declarations?.includes(targetDeclaration) ?? false);
  }

  function fieldName(node: ts.PropertyName | ts.BindingName): AccessibilityCaptureFieldAccessSite['field'] | undefined {
    if (!ts.isIdentifier(node) && !ts.isStringLiteral(node)) {
      return undefined;
    }

    return node.text === 'rawYaml' || node.text === 'scalarValues'
      ? node.text
      : undefined;
  }

  function recordAccess(
    sourceFile: ts.SourceFile,
    node: ts.Node,
    field: AccessibilityCaptureFieldAccessSite['field'],
  ): void {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    accessSites.push({
      fileName: sourceFile.fileName,
      line: position.line + 1,
      column: position.character + 1,
      field,
      allowed: allowedFileNames.has(sourceFile.fileName),
    });
  }

  function visit(sourceFile: ts.SourceFile, node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node)) {
      const field = fieldName(node.name);
      if (field !== undefined && resolvesToTargetDeclaration(checker.getSymbolAtLocation(node.name), field)) {
        recordAccess(sourceFile, node, field);
      }
    } else if (ts.isBindingElement(node)) {
      const field = fieldName(node.propertyName ?? node.name);
      const sourceProperty = field === undefined
        ? undefined
        : checker.getTypeAtLocation(node.parent).getProperty(field);
      if (field !== undefined && resolvesToTargetDeclaration(sourceProperty, field)) {
        recordAccess(sourceFile, node, field);
      }
    }

    ts.forEachChild(node, (child) => visit(sourceFile, child));
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile) {
      visit(sourceFile, sourceFile);
    }
  }

  return accessSites;
}
