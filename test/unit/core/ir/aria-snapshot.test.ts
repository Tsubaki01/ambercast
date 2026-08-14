import { describe, expect, it } from 'vitest';
import {
  extractDiscardedScalarValues,
  isSnapshotInvalid,
  parseAriaSnapshot,
  SNAPSHOT_INVALID,
} from '#core/ir/aria-snapshot.js';
import type { JsonValueT } from '#core/ir/schema.js';

function root(children: JsonValueT[]): JsonValueT {
  return { role: 'root', name: '', children };
}

function node(role: string, name = '', children: JsonValueT[] = []): JsonValueT {
  return { role, name, children };
}

describe('parseAriaSnapshot', () => {
  it('parses a single flat item', () => {
    expect(parseAriaSnapshot('- button "Save"')).toEqual(root([node('button', 'Save')]));
  });

  it('builds parent-child edges across increasing and decreasing indentation depths', () => {
    expect(parseAriaSnapshot([
      '- navigation "Main":',
      '  - list:',
      '    - listitem:',
      '      - link "Home"',
      '  - link "Support"',
      '- contentinfo "Footer"',
    ].join('\n'))).toEqual(root([
      node('navigation', 'Main', [
        node('list', '', [node('listitem', '', [node('link', 'Home')])]),
        node('link', 'Support'),
      ]),
      node('contentinfo', 'Footer'),
    ]));
  });

  it.each([
    ['textbox'],
    ['searchbox'],
    ['combobox'],
    ['spinbutton'],
    ['slider'],
    ['generic'],
  ] as const)('does not promote a colon value to the name of %s', (role) => {
    expect(parseAriaSnapshot(`- ${role}: visible value`)).toEqual(root([node(role)]));
  });

  it('promotes a colon value to the name of an unnamed text node', () => {
    expect(parseAriaSnapshot('- text: Download the release')).toEqual(root([node('text', 'Download the release')]));
  });

  it('parses but does not promote a colon value when text already has an explicit name', () => {
    expect(parseAriaSnapshot('- text "Explicit name": replacement value')).toEqual(root([node('text', 'Explicit name')]));
  });

  it('assigns an empty name to a bareword role', () => {
    expect(parseAriaSnapshot('- separator')).toEqual(root([node('separator')]));
  });

  it('removes a structural colon from an unnamed role', () => {
    expect(parseAriaSnapshot('- listitem:')).toEqual(root([node('listitem')]));
  });

  it.each([
    ['a literal backslash', '\\\\', '\\'],
    ['an escaped double quote', '\\"', '"'],
    ['a backspace', '\\b', '\b'],
    ['a form feed', '\\f', '\f'],
    ['a line feed', '\\n', '\n'],
    ['a carriage return', '\\r', '\r'],
    ['a tab', '\\t', '\t'],
    ['a lowercase four-digit Unicode escape', '\\u001f', '\u001f'],
    ['a Unicode escape followed by a literal hex character', '\\u001fa', '\u001fa'],
  ] as const)('accepts the JSON.stringify name escape for %s', (_description, encoded, expectedName) => {
    expect(parseAriaSnapshot(`- button "${encoded}"`)).toEqual(root([node('button', expectedName)]));
  });

  it.each([
    ['uppercase Unicode hex', '\\u001F'],
    ['an unknown escape letter', '\\q'],
    ['an unterminated quote', undefined],
    ['a lone trailing backslash', undefined],
  ] as const)('rejects a quoted name containing %s', (_description, encoded) => {
    const snapshot = encoded === undefined
      ? _description === 'an unterminated quote'
        ? '- button "Save'
        : '- button "Save\\'
      : `- button "Save ${encoded}"`;

    expect(parseAriaSnapshot(snapshot)).toBe(SNAPSHOT_INVALID);
  });

  it.each([
    ['a literal backslash in a quote-required value', '\\\\ ', '\\ '],
    ['an escaped double quote', '\\"', '"'],
    ['a backspace', '\\b', '\b'],
    ['a form feed', '\\f', '\f'],
    ['a line feed', '\\n', '\n'],
    ['a carriage return', '\\r', '\r'],
    ['a tab', '\\t', '\t'],
    ['a lowercase two-digit control-byte escape', '\\x1f', '\u001f'],
    ['a control-byte escape followed by a literal hex character', '\\x01a', '\u0001a'],
    ['a NUL escape followed by a literal digit', '\\x001', '\u00001'],
  ] as const)('accepts the renderer value escape for %s', (_description, encoded, expectedName) => {
    expect(parseAriaSnapshot(`- text: "${encoded}"`)).toEqual(root([node('text', expectedName)]));
  });

  it.each([
    ['a colon-space name', '- \'button "Save: draft"\'', 'Save: draft'],
    ['a space-hash name', '- \'button "Save #1"\'', 'Save #1'],
    ['combined colon-space and space-hash text', '- \'button "Save: #1"\'', 'Save: #1'],
    ['doubled apostrophes', '- \'button "O\'\'Brien: draft"\'', "O'Brien: draft"],
    ['an escaped double quote nested in the outer quote', '- \'button "Save \\"draft\\": final"\'', 'Save "draft": final'],
    ['an attribute suffix', '- \'button "Save: draft" [ref=e1] [cursor=pointer]\'', 'Save: draft'],
  ] as const)('parses an outer-quoted key containing %s', (_description, snapshot, name) => {
    expect(parseAriaSnapshot(snapshot)).toEqual(root([node('button', name)]));
  });

  it.each([
    ['a trailing bare colon', '- \'group "Actions: "\':', node('group', 'Actions: ')],
    ['a colon-value continuation', '- \'text "Explicit: value"\': ignored', node('text', 'Explicit: value')],
  ] as const)('continues an outer-quoted key with %s', (_description, snapshot, expected) => {
    expect(parseAriaSnapshot(snapshot)).toEqual(root([expected]));
  });

  it.each([
    ['one hex digit', String.raw`- text: "\x1"`],
    ['uppercase value hex', String.raw`- text: "\x1F"`],
    ['a value Unicode escape', String.raw`- text: "\u001f"`],
    ['an unknown escape letter', String.raw`- text: "\q"`],
    ['an unterminated quote', '- text: "value'],
    ['a lone trailing backslash', '- text: "value\\'],
  ] as const)('rejects a value containing %s', (_description, snapshot) => {
    expect(parseAriaSnapshot(snapshot)).toBe(SNAPSHOT_INVALID);
  });

  it.each([
    ['trailing junk after a closed outer quote', '- \'button "Save: draft"\' unexpected'],
    ['a colon without a following space before more content', '- button:unexpected'],
    ['a nested attribute bracket', '- button "Save" [ref=[e1]]'],
    ['an unclosed attribute bracket', '- button "Save" [ref=e1'],
    ['an unterminated outer quote', '- \'button "Save: draft"'],
    ['a slash-wrapped renderer name', '- button /literal/'],
    ['a JSON-legal but renderer-inexact slash escape', String.raw`- button "Save \/ draft"`],
    ['an explicitly empty renderer name', '- button ""'],
    ['a renderer name longer than its emitted-name limit', `- button "${'a'.repeat(901)}"`],
    ['an unnecessarily outer-quoted bare role', "- 'button'"],
    ['an unnecessarily quoted plain value', '- text: "plain"'],
    ['a printable Unicode escape in a name', String.raw`- button "\u0061"`],
    ['a printable hexadecimal escape in a quoted value', String.raw`- text: "\x41 "`],
  ] as const)('rejects %s', (_description, snapshot) => {
    expect(parseAriaSnapshot(snapshot)).toBe(SNAPSHOT_INVALID);
  });

  it.each([
    ['an embedded C0 control byte', '- but\u0001ton', '- \'but\u0001ton\'', 'but\u0001ton'],
    ['an embedded C1 control byte', '- but\u0085ton', '- \'but\u0085ton\'', 'but\u0085ton'],
    ['a leading hyphen', '- -button', '- \'-button\'', '-button'],
    ['a colon followed by a space', '- button [ref=e1: detail]', '- \'button [ref=e1: detail]\'', 'button'],
    ['a space followed by a hash', '- button [ref=e1 #detail]', '- \'button [ref=e1 #detail]\'', 'button'],
    ['a leading YAML indicator', '- !button', '- \'!button\'', '!button'],
    ['an embedded curly brace', '- but{ton', '- \'but{ton\'', 'but{ton'],
    ['an embedded backtick', '- but`ton', '- \'but`ton\'', 'but`ton'],
    ['a leading square bracket', '- [button', '- \'[button\'', '[button'],
    ['a numeric YAML scalar collision', '- 123', '- \'123\'', '123'],
    ['a boolean YAML scalar collision', '- true', '- \'true\'', 'true'],
  ] as const)('rejects an unquoted key that needs renderer quoting for %s, but accepts the outer-quoted form', (
    _description,
    unquoted,
    quoted,
    expectedRole,
  ) => {
    expect(parseAriaSnapshot(unquoted)).toBe(SNAPSHOT_INVALID);
    expect(parseAriaSnapshot(quoted)).toEqual(root([node(expectedRole)]));
  });

  it.each([
    ['leading whitespace', '-  button', '- \' button\''],
    ['trailing whitespace', '- button ', '- \'button \''],
  ] as const)('rejects both forms of a key with %s', (_description, unquoted, quoted) => {
    expect(parseAriaSnapshot(unquoted)).toBe(SNAPSHOT_INVALID);
    expect(parseAriaSnapshot(quoted)).toBe(SNAPSHOT_INVALID);
  });

  it.each([
    ['leading whitespace', '- text:  value', '- text: " value"', ' value'],
    ['trailing whitespace', '- text: value ', '- text: "value "', 'value '],
    ['an embedded C0 control byte', '- text: va\u0001lue', '- text: "va\\x01lue"', 'va\u0001lue'],
    ['an embedded C1 control byte', '- text: va\u0085lue', '- text: "va\\x85lue"', 'va\u0085lue'],
    ['a leading hyphen', '- text: -value', '- text: "-value"', '-value'],
    ['a colon followed by a space', '- text: value: detail', '- text: "value: detail"', 'value: detail'],
    ['a colon at the end of the value', '- text: value:', '- text: "value:"', 'value:'],
    ['a space followed by a hash', '- text: value #detail', '- text: "value #detail"', 'value #detail'],
    ['an embedded line feed', '- text: value\ncontinued', '- text: "value\\ncontinued"', 'value\ncontinued'],
    ['an embedded carriage return', '- text: value\rcontinued', '- text: "value\\rcontinued"', 'value\rcontinued'],
    ['a leading YAML indicator', '- text: !value', '- text: "!value"', '!value'],
    ['an embedded curly brace', '- text: va{lue', '- text: "va{lue"', 'va{lue'],
    ['an embedded backtick', '- text: va`lue', '- text: "va`lue"', 'va`lue'],
    ['a leading square bracket', '- text: [value', '- text: "[value"', '[value'],
    ['a numeric YAML scalar collision', '- text: 123', '- text: "123"', '123'],
    ['a boolean YAML scalar collision', '- text: true', '- text: "true"', 'true'],
  ] as const)('rejects an unquoted value that needs renderer quoting for %s, but accepts the quoted form', (
    _description,
    unquoted,
    quoted,
    expectedName,
  ) => {
    expect(parseAriaSnapshot(unquoted)).toBe(SNAPSHOT_INVALID);
    expect(parseAriaSnapshot(quoted)).toEqual(root([node('text', expectedName)]));
  });

  it.each([
    ['a raw tab', '- text: "a\tb"'],
    ['a raw line feed', '- text: "a\nb"'],
    ['a raw carriage return', '- text: "a\rb"'],
  ] as const)('rejects %s inside a quoted value', (_description, snapshot) => {
    expect(parseAriaSnapshot(snapshot)).toBe(SNAPSHOT_INVALID);
  });

  it('preserves a raw tab in an unquoted value', () => {
    expect(parseAriaSnapshot('- text: a\tb')).toEqual(root([node('text', 'a\tb')]));
  });

  it('skips /url and /placeholder metadata without making either a tree node', () => {
    const snapshot = [
      '- link "Download":',
      '  - /url: /downloads/ambercast',
      '  - /placeholder: Search',
      '  - text: Download the release',
    ].join('\n');

    expect(parseAriaSnapshot(snapshot)).toEqual(root([
      node('link', 'Download', [node('text', 'Download the release')]),
    ]));
  });

  it.each([
    ['an unquoted metadata value', '- link "Download":\n  - /url: /downloads/ambercast'],
    ['a quoted metadata value that needs quoting', '- textbox "Search":\n  - /placeholder: " Search"'],
  ] as const)('accepts %s at exactly one level below its owning node', (_description, snapshot) => {
    expect(parseAriaSnapshot(snapshot)).not.toBe(SNAPSHOT_INVALID);
  });

  it.each([
    ['an unsupported metadata property', '- link "Download":\n  - /unknown: value'],
    ['metadata at the top level without an owning node', '- /url: /downloads/ambercast'],
    ['metadata more than one indentation level below its owning node', '- link "Download":\n    - /url: /downloads/ambercast'],
    ['an unquoted metadata value that the renderer would quote', '- textbox "Search":\n  - /placeholder:  Search'],
  ] as const)('rejects %s', (_description, snapshot) => {
    expect(parseAriaSnapshot(snapshot)).toBe(SNAPSHOT_INVALID);
  });

  it('discards an attribute suffix without preventing later lines from parsing', () => {
    expect(parseAriaSnapshot('- heading "Sign in" [level=1]\n- button "Continue"')).toEqual(root([
      node('heading', 'Sign in'),
      node('button', 'Continue'),
    ]));
  });

  it('places multiple top-level items beneath the one exact synthetic root shape', () => {
    expect(parseAriaSnapshot('- banner\n- main "Content"\n- contentinfo "Footer"')).toEqual(root([
      node('banner'),
      node('main', 'Content'),
      node('contentinfo', 'Footer'),
    ]));
  });

  it('returns the synthetic root with no children only for empty input', () => {
    expect(parseAriaSnapshot('')).toEqual(root([]));
  });

  it.each([
    ['a blank line between valid nodes', '- button "First"\n\n- button "Second"'],
    ['a trailing blank line', '- button "Only"\n'],
    ['a whitespace-only line', '- button "First"\n  \n- button "Second"'],
    ['a tab-indented line', '- group:\n\t- button "Submit"'],
    ['an odd-space-indented line', '- group:\n - button "Submit"'],
    ['an indentation jump greater than one level', '- group:\n    - button "Submit"'],
    ['a first line indented more than one level without an intervening parent', '    - button "Submit"'],
    ['a valid line surrounding an invalid line', '- button "First"\nnot an outline\n- button "Second"'],
  ] as const)('fails closed for %s', (_description, snapshot) => {
    expect(parseAriaSnapshot(snapshot)).toBe(SNAPSHOT_INVALID);
  });

  it('accepts CRLF-delimited lines with valid two-space nesting', () => {
    expect(parseAriaSnapshot('- group "Actions":\r\n  - button "Submit"')).toEqual(root([
      node('group', 'Actions', [node('button', 'Submit')]),
    ]));
  });

  it('builds a deeply nested valid outline without a depth limit', () => {
    const depth = 24;
    const snapshot = Array.from(
      { length: depth },
      (_, index) => `${'  '.repeat(index)}- group "Level ${index}":`,
    ).join('\n');
    let expected = node(`group`, `Level ${depth - 1}`);
    for (let index = depth - 2; index >= 0; index -= 1) {
      expected = node('group', `Level ${index}`, [expected]);
    }

    expect(parseAriaSnapshot(snapshot)).toEqual(root([expected]));
  });

  it('fails closed instead of skipping malformed unindented lines around valid outline lines', () => {
    expect(parseAriaSnapshot('heading "This is not an outline"\n- button "Continue"\ntrailing malformed text'))
      .toBe(SNAPSHOT_INVALID);
  });

  it('recognizes a JSON-round-tripped invalid marker structurally', () => {
    const clonedMarker = JSON.parse(JSON.stringify(SNAPSHOT_INVALID)) as JsonValueT;

    expect(clonedMarker).not.toBe(SNAPSHOT_INVALID);
    expect(isSnapshotInvalid(clonedMarker)).toBe(true);
  });

  it.each<[string, JsonValueT]>([
    ['a normally parsed root tree', parseAriaSnapshot('- button "Save"')],
    ['null', null],
    ['an array', []],
    ['a plain string', 'snapshotInvalid'],
    ['a number', 1],
    ['an empty object', {}],
    ['an object with a false marker field', { snapshotInvalid: false }],
    ['an object with a string marker field', { snapshotInvalid: 'true' }],
  ])('does not over-match %s as an invalid marker', (_description, value) => {
    expect(isSnapshotInvalid(value)).toBe(false);
  });
});

describe('extractDiscardedScalarValues', () => {
  it('excludes an unnamed text colon value because the tree promotes it into the node name', () => {
    expect(extractDiscardedScalarValues('- text: Promoted tree value')).toEqual([]);
  });

  it('includes colon values discarded from non-text and explicitly named text nodes', () => {
    expect(extractDiscardedScalarValues([
      '- textbox: Discarded textbox value',
      '- text "Explicit tree name": Discarded replacement value',
    ].join('\n'))).toEqual([
      'Discarded textbox value',
      'Discarded replacement value',
    ]);
  });

  it('includes decoded url and placeholder metadata values that never become tree nodes', () => {
    expect(extractDiscardedScalarValues([
      '- form "Sign in":',
      '  - /url: /account/sign-in',
      '  - /placeholder: Email address',
    ].join('\n'))).toEqual([
      '/account/sign-in',
      'Email address',
    ]);
  });

  it('keeps independently valid scalar evidence when an unrelated line makes the whole tree invalid', () => {
    const yaml = [
      '- textbox: Retained scalar value',
      'not an ARIA outline',
    ].join('\n');

    expect(parseAriaSnapshot(yaml)).toBe(SNAPSHOT_INVALID);
    expect(extractDiscardedScalarValues(yaml)).toEqual(['Retained scalar value']);
  });
});
