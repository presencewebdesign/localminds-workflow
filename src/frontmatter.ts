/**
 * Minimal, dependency-free YAML-frontmatter parser/serializer.
 *
 * The extension ships with zero runtime dependencies, so we hand-roll just
 * enough YAML to round-trip the small, flat frontmatter blocks our entity
 * files use: scalars (string/number/boolean), inline arrays (`[a, b]`),
 * block arrays (`- item`), and a single level of nested objects for prompt
 * arguments. Anything fancier than that is intentionally unsupported.
 */

export type FrontmatterValue =
  | string
  | number
  | boolean
  | null
  | FrontmatterValue[]
  | { [key: string]: FrontmatterValue };

export interface ParsedDocument {
  data: Record<string, FrontmatterValue>;
  body: string;
}

const FENCE = '---';

/** Parse a document of the form `---\n<yaml>\n---\n<body>`. */
export function parseFrontmatter(raw: string): ParsedDocument {
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith(FENCE)) {
    return { data: {}, body: text };
  }

  const end = text.indexOf(`\n${FENCE}`, FENCE.length);
  if (end === -1) {
    return { data: {}, body: text };
  }

  const yaml = text.slice(FENCE.length + 1, end);
  let rest = text.slice(end + 1 + FENCE.length + 1);
  if (rest.startsWith('\n')) rest = rest.slice(1);

  return { data: parseYamlBlock(yaml), body: rest };
}

function parseYamlBlock(yaml: string): Record<string, FrontmatterValue> {
  const lines = yaml.split('\n');
  const data: Record<string, FrontmatterValue> = {};

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }

    const indent = line.length - line.trimStart().length;
    if (indent > 0) {
      // Stray indented line with no parent key; skip defensively.
      i++;
      continue;
    }

    const colon = findKeyColon(line);
    if (colon === -1) {
      i++;
      continue;
    }

    const key = line.slice(0, colon).trim();
    const valuePart = line.slice(colon + 1).trim();

    if (valuePart === '') {
      // Could be a block array or a nested object on following indented lines.
      const { value, next } = parseBlockValue(lines, i + 1);
      data[key] = value;
      i = next;
    } else {
      data[key] = parseScalarOrInline(valuePart);
      i++;
    }
  }

  return data;
}

/** Find the colon that separates a key from its value, ignoring colons in quotes. */
function findKeyColon(line: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === ':' && !inSingle && !inDouble) {
      const after = line[i + 1];
      if (after === undefined || after === ' ') return i;
    }
  }
  return -1;
}

function parseBlockValue(
  lines: string[],
  start: number,
): { value: FrontmatterValue; next: number } {
  // Determine the indentation of the block from the first non-empty child.
  let i = start;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i >= lines.length) return { value: '', next: i };

  const firstChild = lines[i];
  const childIndent = firstChild.length - firstChild.trimStart().length;
  if (childIndent === 0) return { value: '', next: start };

  const isArray = firstChild.trimStart().startsWith('- ') || firstChild.trim() === '-';

  if (isArray) {
    const arr: FrontmatterValue[] = [];
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const indent = line.length - line.trimStart().length;
      if (indent < childIndent) break;
      const trimmed = line.trimStart();
      if (!trimmed.startsWith('-')) break;
      const itemText = trimmed.slice(1).trim();
      // Inline object on an array item (`- name: x`) — collect nested keys.
      if (itemText && findKeyColon(itemText) !== -1) {
        const obj: Record<string, FrontmatterValue> = {};
        const colon = findKeyColon(itemText);
        obj[itemText.slice(0, colon).trim()] = parseScalarOrInline(itemText.slice(colon + 1).trim());
        i++;
        // Subsequent more-indented key lines belong to this object.
        while (i < lines.length) {
          const sub = lines[i];
          if (!sub.trim()) { i++; continue; }
          const subIndent = sub.length - sub.trimStart().length;
          if (subIndent <= childIndent) break;
          const subColon = findKeyColon(sub);
          if (subColon === -1) break;
          obj[sub.slice(0, subColon).trim()] = parseScalarOrInline(sub.slice(subColon + 1).trim());
          i++;
        }
        arr.push(obj);
      } else {
        arr.push(parseScalarOrInline(itemText));
        i++;
      }
    }
    return { value: arr, next: i };
  }

  // Nested object block.
  const obj: Record<string, FrontmatterValue> = {};
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const indent = line.length - line.trimStart().length;
    if (indent < childIndent) break;
    const colon = findKeyColon(line);
    if (colon === -1) break;
    obj[line.slice(0, colon).trim()] = parseScalarOrInline(line.slice(colon + 1).trim());
    i++;
  }
  return { value: obj, next: i };
}

function parseScalarOrInline(text: string): FrontmatterValue {
  if (text === '') return '';

  // Inline array: [a, b, c]
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner).map((s) => parseScalar(s.trim()));
  }

  return parseScalar(text);
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let current = '';
  for (const c of text) {
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
    }
    current += c;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function parseScalar(text: string): FrontmatterValue {
  if (text === '') return '';
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+$/.test(text)) return parseInt(text, 10);
  if (/^-?\d*\.\d+$/.test(text)) return parseFloat(text);
  return text;
}

/** Serialize data + body back into a frontmatter document. */
export function serializeFrontmatter(
  data: Record<string, FrontmatterValue>,
  body: string,
): string {
  const yaml = serializeYaml(data);
  const cleanBody = body.replace(/\r\n/g, '\n').replace(/^\n+/, '');
  return `${FENCE}\n${yaml}${FENCE}\n\n${cleanBody.endsWith('\n') ? cleanBody : cleanBody + '\n'}`;
}

function serializeYaml(data: Record<string, FrontmatterValue>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    appendYamlEntry(lines, key, value, 0);
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

function appendYamlEntry(
  lines: string[],
  key: string,
  value: FrontmatterValue,
  indent: number,
): void {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}${key}: []`);
      return;
    }
    const allScalar = value.every((v) => typeof v !== 'object' || v === null);
    if (allScalar) {
      lines.push(`${pad}${key}: [${value.map((v) => serializeScalar(v as FrontmatterValue)).join(', ')}]`);
      return;
    }
    lines.push(`${pad}${key}:`);
    for (const item of value) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const entries = Object.entries(item);
        entries.forEach(([k, v], idx) => {
          const prefix = idx === 0 ? `${pad}  - ` : `${pad}    `;
          lines.push(`${prefix}${k}: ${serializeScalar(v)}`);
        });
      } else {
        lines.push(`${pad}  - ${serializeScalar(item as FrontmatterValue)}`);
      }
    }
    return;
  }

  if (value && typeof value === 'object') {
    lines.push(`${pad}${key}:`);
    for (const [k, v] of Object.entries(value)) {
      appendYamlEntry(lines, k, v, indent + 1);
    }
    return;
  }

  lines.push(`${pad}${key}: ${serializeScalar(value)}`);
}

function serializeScalar(value: FrontmatterValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  const str = String(value);
  // Quote strings that could be misparsed.
  if (
    str === '' ||
    /^[\s]|[\s]$/.test(str) ||
    /[:#[\]{},&*!|>'"%@`]/.test(str) ||
    /^(true|false|null|~)$/.test(str) ||
    /^-?\d/.test(str)
  ) {
    return JSON.stringify(str);
  }
  return str;
}
