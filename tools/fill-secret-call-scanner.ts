/**
 * Provides the bounded architecture-test guard for direct calls to the
 * browser port's secret-fill method.
 *
 * It recognizes direct dot-access and string-literal element-access calls
 * resolved by TypeScript to `BrowserSession.fillSecret`, not string-matched
 * method names. The guard is deliberately structural rather than a complete
 * data-flow proof: a rebound or destructured method reference, an aliased
 * indirection, or a call through a differently typed value can evade it,
 * while unrelated same-named methods remain outside the boundary.
 */
import * as ts from 'typescript';

/** Records one checker-resolved call to `BrowserSession.fillSecret`. */
export type FillSecretCallSite = {
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
  readonly allowed: boolean;
};

/**
 * Locates direct calls resolved to the browser port's `fillSecret` method in
 * non-declaration source files.
 *
 * The scanner resolves the `BrowserSession` export from the ports module,
 * obtains its declared type through
 * `checker.getDeclaredTypeOfSymbol(...)`, and finds the `fillSecret` property
 * with `.getProperty('fillSecret')`; this is an interface method rather than
 * a standalone function declaration. It then walks every non-declaration
 * source file for call expressions whose dot-access or string-literal
 * element-access method name is `fillSecret`. A candidate is recorded only
 * when its checker-resolved symbol, after alias resolution, includes that
 * interface-method declaration. Each site records whether its source file
 * appears in the explicit allowlist.
 *
 * @param program - The TypeScript program containing source files to inspect.
 * @param portsModuleFileName - The source file exporting `BrowserSession`.
 * @param allowedFileNames - Source files permitted to call the secret-fill port.
 * @returns Every resolved secret-fill call site and its allowlist status.
 * @throws If the ports module, `BrowserSession` export, or `fillSecret` method
 *   declaration cannot be resolved.
 */
export function scanFillSecretCallSites(
  program: ts.Program,
  portsModuleFileName: string,
  allowedFileNames: ReadonlySet<string>,
): FillSecretCallSite[] {
  const portsModule = program.getSourceFile(portsModuleFileName);
  if (portsModule === undefined) {
    throw new Error(`The ports module is not part of this TypeScript program: ${portsModuleFileName}`);
  }

  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(portsModule);
  const browserSessionSymbol = moduleSymbol === undefined
    ? undefined
    : checker.getExportsOfModule(moduleSymbol).find(({ name }) => name === 'BrowserSession');
  if (browserSessionSymbol === undefined) {
    throw new Error(`The ports module does not export BrowserSession: ${portsModuleFileName}`);
  }

  const fillSecretSymbol = checker.getDeclaredTypeOfSymbol(browserSessionSymbol).getProperty('fillSecret');
  const fillSecretDeclarations = fillSecretSymbol?.declarations ?? [];
  if (fillSecretDeclarations.length === 0) {
    throw new Error(`BrowserSession does not declare fillSecret: ${portsModuleFileName}`);
  }

  const callSites: FillSecretCallSite[] = [];

  function resolvesToFillSecret(symbol: ts.Symbol | undefined): boolean {
    if (symbol === undefined) {
      return false;
    }

    const resolvedSymbol = symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
    return resolvedSymbol.declarations?.some((declaration) => fillSecretDeclarations.includes(declaration)) ?? false;
  }

  function visit(sourceFile: ts.SourceFile, node: ts.Node): void {
    const accessName = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'fillSecret'
      ? node.expression.name
      : ts.isCallExpression(node) && ts.isElementAccessExpression(node.expression)
        && node.expression.argumentExpression !== undefined
        && ts.isStringLiteralLike(node.expression.argumentExpression)
        && node.expression.argumentExpression.text === 'fillSecret'
        ? node.expression.argumentExpression
        : undefined;

    if (accessName !== undefined && resolvesToFillSecret(checker.getSymbolAtLocation(accessName))) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      callSites.push({
        fileName: sourceFile.fileName,
        line: position.line + 1,
        column: position.character + 1,
        allowed: allowedFileNames.has(sourceFile.fileName),
      });
    }

    ts.forEachChild(node, (child) => visit(sourceFile, child));
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile) {
      visit(sourceFile, sourceFile);
    }
  }

  return callSites;
}
