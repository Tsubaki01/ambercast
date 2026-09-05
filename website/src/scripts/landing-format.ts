/**
 * These DOM-free formatters derive presentation from the approved copy instead of creating a
 * second text source. Keeping the split and escaping rules here lets Astro and the client share
 * the same textual contracts without a browser-dependent interpretation step.
 */

/** The route locale supplied explicitly by the landing page rather than inferred from the DOM. */
export type LandingLocale = 'en' | 'ja' | 'zh-cn';

/** Fragments whose concatenation preserves a heal note while only its lead receives emphasis. */
export interface HealNoteParts {
  lead: string;
  tail: string;
}

/** Fragments whose concatenation preserves a prerequisite description across locale-specific prose. */
export interface PrerequisiteParts {
  value: string;
  separator: string;
  note: string;
}

const JSON_NUMBER_AT_CURSOR = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const JSON_BARE_WORD_AT_CURSOR = /(?:true|false|null)(?![A-Za-z0-9])/y;

/**
 * Escapes the five entities used by landing-generated HTML. Renderers escape before wrapping
 * text, so copy remains text even where a builder must return HTML for a controlled panel sink.
 *
 * @param value - Text that will become HTML text content.
 * @returns The safely encoded text.
 */
export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/**
 * Classifies a prompt line for its visual treatment.
 *
 * @param line - One source line from the demo prompt.
 * @returns The visual class selected by the prompt renderer.
 */
export function classifyPromptLine(line: string): 'heading' | 'grant' | 'body' {
  return line.startsWith('# ') ? 'heading' : line.startsWith('@ambercast-secret') ? 'grant' : 'body';
}

/**
 * Separates the emphasized lead from a heal note without changing its accessible text. The
 * `lead + tail === text` invariant lets the template style only the lead while preserving every
 * locale's original punctuation and wording.
 *
 * @param text - The approved heal note.
 * @returns The emphasized lead and its untouched remainder.
 */
export function splitHealNote(text: string): HealNoteParts {
  const index = text.indexOf(' · ');
  return index === -1 ? { lead: text, tail: '' } : { lead: text.slice(0, index), tail: text.slice(index) };
}

/**
 * Separates a locale-specific prerequisite value from its optional note. The explicit separator
 * makes `value + separator + note === description`, including a trailing separator with no note.
 *
 * @param description - The approved prerequisite description.
 * @param locale - The explicit route locale; the component must not infer it from document state.
 * @returns The declaratively rendered value, separator, and note fragments.
 */
export function formatPrerequisite(description: string, locale: LandingLocale): PrerequisiteParts {
  const separator = locale === 'en' ? '. ' : '。';
  const index = description.indexOf(separator);
  return index === -1 ? { value: description, separator: '', note: '' } : { value: description.slice(0, index), separator, note: description.slice(index + separator.length) };
}

/**
 * Highlights one generated JSON line without claiming to parse arbitrary JSON.
 *
 * @remarks The input is one line generated from the demo plan, so this scanner only needs key
 * and value classes rather than JSON-parser recovery. A backslash consumes itself and the next
 * code unit together, preventing an escaped quote from ending a string. After a string closes,
 * look-ahead over whitespace classifies it as a key only when a colon follows. Every fragment is
 * escaped before its span is wrapped; markup-looking plan values therefore cannot cross the sink
 * boundary as DOM.
 *
 * @param text - A single already-valid JSON line from the demo plan.
 * @returns Safe HTML containing only JSON key and value spans.
 */
export function highlightJsonLine(text: string): string {
  let html = '';
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if (character === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (end < text.length) end += 1;
      const token = text.substring(index, end);
      let lookahead = end;
      while (/\s/.test(text[lookahead] ?? '')) lookahead += 1;
      html += `<span class="demo-json-${text[lookahead] === ':' ? 'key' : 'value'}">${escapeHtml(token)}</span>`;
      index = end;
      continue;
    }
    JSON_NUMBER_AT_CURSOR.lastIndex = index;
    const number = JSON_NUMBER_AT_CURSOR.exec(text);
    if (number) {
      html += `<span class="demo-json-value">${escapeHtml(number[0])}</span>`;
      index += number[0].length;
      continue;
    }
    JSON_BARE_WORD_AT_CURSOR.lastIndex = index;
    const bare = JSON_BARE_WORD_AT_CURSOR.exec(text);
    if (bare && (index === 0 || !/[A-Za-z0-9]/.test(text[index - 1]))) {
      html += `<span class="demo-json-value">${bare[0]}</span>`;
      index += bare[0].length;
      continue;
    }
    html += escapeHtml(character);
    index += 1;
  }
  return html;
}
