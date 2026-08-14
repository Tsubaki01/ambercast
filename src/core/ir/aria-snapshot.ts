import type { JsonValueT } from './schema.js';

/**
 * A serializable node in the synthetic-root accessibility tree.
 *
 * Every accepted node carries the role and accessible name that participate in
 * locator matching, plus its ordered children. The role, name, and children
 * field bindings are readonly, but `children` deliberately remains a mutable
 * array so tree construction can append children before exposing the
 * serializable result. This type does not claim deep immutability.
 */
export type AccessibilityNode = {
  readonly role: string;
  readonly name: string;
  readonly children: AccessibilityNode[];
};

/**
 * Marks ARIA evidence that cannot be recognized safely.
 *
 * The frozen, JSON-round-trippable marker intentionally has no tree fields.
 * That makes it structurally distinct from both a valid tree and the empty
 * synthetic root, and lets consumers recognize invalid evidence without
 * relying on object identity that cloning or serialization would lose.
 */
export const SNAPSHOT_INVALID = Object.freeze({ snapshotInvalid: true } as const);

/**
 * Determines whether serializable evidence carries the invalid-snapshot
 * marker.
 *
 * @param value - The JSON value passed across the snapshot boundary.
 * @returns Whether the value structurally represents {@link SNAPSHOT_INVALID}.
 *
 * @remarks
 * Structural recognition keeps the marker meaningful after a JSON round trip
 * while leaving arbitrary malformed values on the ordinary malformed-tree
 * path. The check requires an object with a true `snapshotInvalid` field; it
 * never depends on the frozen object's reference identity.
 */
export function isSnapshotInvalid(value: JsonValueT): boolean {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && (value as { readonly snapshotInvalid?: unknown }).snapshotInvalid === true;
}

type ParsedKey = {
  readonly role: string;
  readonly name: string;
  readonly hasExplicitName: boolean;
  readonly nextIndex: number;
};

type ParsedValue = {
  readonly value: string;
  readonly nextIndex: number;
};

function yamlStringNeedsQuotes(value: string): boolean {
  return value.length === 0
    || /^\s|\s$/.test(value)
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value)
    || /^-/.test(value)
    || /[\n:](\s|$)/.test(value)
    || /\s#/.test(value)
    || /[\n\r]/.test(value)
    || /^[&*\],?!>|@"'#%]/.test(value)
    || /[{}`]/.test(value)
    || /^\[/.test(value)
    || !Number.isNaN(Number(value))
    || ['y', 'n', 'yes', 'no', 'true', 'false', 'on', 'off', 'null'].includes(value.toLowerCase());
}

function isLowercaseHex(value: string): boolean {
  return /^[0-9a-f]+$/.test(value);
}

function yamlEscapeRendererValue(value: string): string {
  if (!yamlStringNeedsQuotes(value)) {
    return value;
  }

  return '"' + value.replace(/[\\"\x00-\x1f\x7f-\x9f]/g, (character) => {
    switch (character) {
      case '\\':
        return '\\\\';
      case '"':
        return '\\"';
      case '\b':
        return '\\b';
      case '\f':
        return '\\f';
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      default:
        return '\\x' + character.charCodeAt(0).toString(16).padStart(2, '0');
    }
  }) + '"';
}

function parseRendererName(input: string, start: number): ParsedValue | undefined {
  let index = start + 1;

  while (index < input.length) {
    const character = input[index];
    if (character === '"') {
      const encoded = input.slice(start, index + 1);
      try {
        const value = JSON.parse(encoded) as unknown;
        return typeof value !== 'string'
          || value.length === 0
          || value.length > 900
          || JSON.stringify(value) !== encoded
          ? undefined
          : { value, nextIndex: index + 1 };
      } catch {
        return undefined;
      }
    }

    if (character !== '\\') {
      index += 1;
      continue;
    }

    const escape = input[index + 1];
    if (escape === undefined) {
      return undefined;
    }

    if (escape === 'u') {
      const digits = input.slice(index + 2, index + 6);
      if (digits.length !== 4 || !isLowercaseHex(digits)) {
        return undefined;
      }
      index += 6;
      continue;
    }

    if (!['\\', '"', 'b', 'f', 'n', 'r', 't'].includes(escape)) {
      return undefined;
    }
    index += 2;
  }

  return undefined;
}

function parseRendererValue(input: string, start: number): ParsedValue | undefined {
  if (input[start] !== '"') {
    const value = input.slice(start);
    return value.length > 0 && !yamlStringNeedsQuotes(value)
      ? { value, nextIndex: input.length }
      : undefined;
  }

  let index = start + 1;
  let value = '';
  while (index < input.length) {
    const character = input[index];
    if (character === undefined) {
      return undefined;
    }
    if (character === '"') {
      const encoded = input.slice(start, index + 1);
      return index + 1 !== input.length
        || !yamlStringNeedsQuotes(value)
        || yamlEscapeRendererValue(value) !== encoded
        ? undefined
        : { value, nextIndex: index + 1 };
    }

    if (character !== '\\') {
      const code = character.charCodeAt(0);
      if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || (code >= 127 && code <= 159)) {
        return undefined;
      }
      value += character;
      index += 1;
      continue;
    }

    const escape = input[index + 1];
    if (escape === undefined) {
      return undefined;
    }

    if (escape === 'x') {
      const digits = input.slice(index + 2, index + 4);
      if (digits.length !== 2 || !isLowercaseHex(digits)) {
        return undefined;
      }
      value += String.fromCharCode(Number.parseInt(digits, 16));
      index += 4;
      continue;
    }

    const namedEscapes: Readonly<Record<string, string>> = {
      '\\': '\\',
      '"': '"',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    const decoded = namedEscapes[escape];
    if (decoded === undefined) {
      return undefined;
    }
    value += decoded;
    index += 2;
  }

  return undefined;
}

function parseUnquotedKey(input: string, start: number): ParsedKey | undefined {
  let index = start;
  while (index < input.length && input[index] !== ' ' && input[index] !== ':') {
    index += 1;
  }

  const role = input.slice(start, index);
  if (role.length === 0) {
    return undefined;
  }

  let name = '';
  let hasExplicitName = false;
  let sawAttribute = false;
  while (input[index] === ' ') {
    const next = input[index + 1];
    if (next === '"' && !hasExplicitName && !sawAttribute) {
      const parsedName = parseRendererName(input, index + 1);
      if (parsedName === undefined) {
        return undefined;
      }
      name = parsedName.value;
      hasExplicitName = true;
      index = parsedName.nextIndex;
      continue;
    }

    if (next !== '[') {
      return undefined;
    }

    const attributeStart = index + 2;
    let attributeEnd = attributeStart;
    while (attributeEnd < input.length && input[attributeEnd] !== ']') {
      if (input[attributeEnd] === '[') {
        return undefined;
      }
      attributeEnd += 1;
    }
    if (input[attributeEnd] !== ']') {
      return undefined;
    }
    sawAttribute = true;
    index = attributeEnd + 1;
  }

  return { role, name, hasExplicitName, nextIndex: index };
}

function parseOuterQuotedKey(input: string, start: number): ParsedKey | undefined {
  let index = start + 1;
  let inner = '';
  while (index < input.length) {
    if (input[index] !== "'") {
      inner += input[index];
      index += 1;
      continue;
    }

    if (input[index + 1] === "'") {
      inner += "'";
      index += 2;
      continue;
    }

    const parsedKey = parseUnquotedKey(inner, 0);
    return parsedKey === undefined || parsedKey.nextIndex !== inner.length || !yamlStringNeedsQuotes(inner)
      ? undefined
      : { ...parsedKey, nextIndex: index + 1 };
  }

  return undefined;
}

function parseNodeLine(line: string, start: number): AccessibilityNode | undefined {
  const outerQuoted = line[start] === "'";
  const parsedKey = outerQuoted
    ? parseOuterQuotedKey(line, start)
    : parseUnquotedKey(line, start);
  if (parsedKey === undefined) {
    return undefined;
  }

  if (!outerQuoted && yamlStringNeedsQuotes(line.slice(start, parsedKey.nextIndex))) {
    return undefined;
  }

  const suffixStart = parsedKey.nextIndex;
  let colonValue: string | undefined;
  if (suffixStart < line.length) {
    if (line[suffixStart] !== ':') {
      return undefined;
    }
    if (suffixStart + 1 < line.length) {
      if (line[suffixStart + 1] !== ' ') {
        return undefined;
      }
      const parsedValue = parseRendererValue(line, suffixStart + 2);
      if (parsedValue === undefined || parsedValue.nextIndex !== line.length) {
        return undefined;
      }
      colonValue = parsedValue.value;
    }
  }

  return {
    role: parsedKey.role,
    name: !parsedKey.hasExplicitName && parsedKey.role === 'text' && colonValue !== undefined
      ? colonValue
      : parsedKey.name,
    children: [],
  };
}

function isValidMetadataLine(line: string, start: number): boolean {
  const colon = line.indexOf(':', start);
  if (colon === -1 || line[colon + 1] !== ' ') {
    return false;
  }

  const property = line.slice(start + 1, colon);
  if (property !== 'url' && property !== 'placeholder') {
    return false;
  }

  const parsedValue = parseRendererValue(line, colon + 2);
  return parsedValue !== undefined && parsedValue.nextIndex === line.length;
}

/**
 * Parses one Playwright `ariaSnapshot()` result into a synthetic-root tree.
 *
 * @param yaml - The renderer's newline-delimited ARIA outline.
 * @returns A `{ role: 'root', name: '', children: [] }` tree for empty input,
 *   a parsed synthetic-root tree for recognized input, or
 *   {@link SNAPSHOT_INVALID} when any nonempty input line is not a supported
 *   renderer shape.
 *
 * @remarks
 * This is deliberately a small, dependency-free scanner rather than a general
 * YAML parser. It fail-closes as soon as a line does not fit the supported
 * renderer form, making unfamiliar evidence unsafe to fingerprint instead of
 * silently dropping details that could change the target's identity.
 *
 * Empty input is the sole blank snapshot accepted at this boundary. Other
 * blank lines invalidate the entire result because the renderer does not emit
 * them, and skipping them could build a partial tree with a changed identity.
 *
 * Identity-bearing content must use the renderer's canonical spelling,
 * including its escaping and quotation decisions. The scanner checks captured
 * key text rather than reconstructing it so this decision stays aligned with
 * the renderer's complete-key behavior. Attribute tokens are deliberately
 * parsed more loosely and discarded: they do not feed the descriptor or hash,
 * so enforcing their vocabulary would add version fragility without an
 * identity or security benefit.
 *
 * A colon value becomes a node name only for an unnamed `text` node. This
 * narrow allowlist prevents unverified future output from becoming trusted
 * identity data. Slash-wrapped literal names remain unrecognized and invalid
 * rather than being misparsed.
 *
 * Playwright's renderer is a private-format dependency. Updating
 * `playwright-core` requires revalidating the accepted grammar against a
 * real-browser corpus before new output shapes can be trusted.
 */
export function parseAriaSnapshot(yaml: string): JsonValueT {
  const root: AccessibilityNode = { role: 'root', name: '', children: [] };
  if (yaml === '') {
    return root;
  }

  const stack: { readonly depth: number; readonly node: AccessibilityNode }[] = [{ depth: -1, node: root }];
  let lastNodeDepth = -1;
  for (const line of yaml.split(/\r?\n/)) {
    if (line.length === 0) {
      return SNAPSHOT_INVALID;
    }

    let indentation = 0;
    while (line[indentation] === ' ') {
      indentation += 1;
    }
    if (indentation % 2 !== 0 || !line.startsWith('- ', indentation)) {
      return SNAPSHOT_INVALID;
    }

    const depth = indentation / 2;
    const contentStart = indentation + 2;
    if (contentStart === line.length) {
      return SNAPSHOT_INVALID;
    }

    if (line[contentStart] === '/') {
      const owner = stack.at(-1);
      if (depth === 0 || owner === undefined || owner.depth !== depth - 1 || !isValidMetadataLine(line, contentStart)) {
        return SNAPSHOT_INVALID;
      }
      continue;
    }

    if (depth > lastNodeDepth + 1) {
      return SNAPSHOT_INVALID;
    }
    while (stack.at(-1)?.depth !== undefined && (stack.at(-1)?.depth ?? -1) >= depth) {
      stack.pop();
    }
    const parent = stack.at(-1);
    const node = parseNodeLine(line, contentStart);
    if (parent === undefined || node === undefined) {
      return SNAPSHOT_INVALID;
    }

    parent.node.children.push(node);
    stack.push({ depth, node });
    lastNodeDepth = depth;
  }

  return root;
}
