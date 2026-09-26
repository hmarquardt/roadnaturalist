// A SMALL, FAIL-CLOSED JSON SCHEMA CHECKER.
//
// The probe catalog is described by a committed JSON Schema (data/investigator/probe-catalog.schema.json), and this is
// the only thing that executes it. It implements the subset of JSON Schema the catalog actually uses and refuses to
// run a schema that uses anything else, so the schema can never appear to enforce a constraint that nothing checks.
//
// It is dependency-free on purpose: the catalog is validated in the browser, in the Worker, in Node tests, and in the
// review CLI, and none of those should need an npm package to answer "is this declaration well formed?".
//
// Issues carry both a JSON Pointer (for a machine) and a sentence (for a reviewer); the catalog validator turns them
// into messages that lead with the probe id and the fact that is wrong.

const SUPPORTED_KEYWORDS = new Set(['$schema', '$id', 'title', 'description', '$defs', '$ref', 'type', 'required',
  'properties', 'additionalProperties', 'items', 'enum', 'const', 'pattern', 'minLength', 'minItems', 'format']);

export const pointerOf = (base, segment) => `${base}/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`;

const typeNameOf = value => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value);

const matchesType = (value, type) => {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
};

const isRealDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const list = values => values.map(value => (value === null ? 'null' : JSON.stringify(value))).join(', ');
const quote = value => (typeof value === 'string' ? `"${value.length > 60 ? `${value.slice(0, 57)}…` : value}"` : JSON.stringify(value));

function assertKeywordsSupported(schema, pointer, root) {
  for (const keyword of Object.keys(schema)) {
    if (SUPPORTED_KEYWORDS.has(keyword)) continue;
    throw new TypeError(`schema keyword "${keyword}" at ${pointer || '/'} is not implemented by the catalog checker; add it deliberately rather than letting the schema claim an unenforced rule`);
  }
  if (schema.$ref !== undefined) {
    const match = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
    if (!match || !root.$defs?.[match[1]]) throw new TypeError(`schema $ref "${schema.$ref}" at ${pointer || '/'} does not resolve to a local $defs entry`);
  }
}

export function checkAgainstSchema(value, schema, { root = schema, pointer = '', issues = [] } = {}) {
  assertKeywordsSupported(schema, pointer, root);
  const definition = schema.$ref ? root.$defs[/^#\/\$defs\/(.+)$/.exec(schema.$ref)[1]] : schema;
  if (definition !== schema) return checkAgainstSchema(value, definition, { root, pointer, issues });

  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    issues.push({ pointer: pointer || '/', keyword: 'const', message: `must be ${quote(schema.const)}` });
  }
  if (schema.enum && !schema.enum.some(entry => JSON.stringify(entry) === JSON.stringify(value))) {
    issues.push({ pointer: pointer || '/', keyword: 'enum', params: { allowed: schema.enum }, message: `must be one of ${list(schema.enum)}; found ${quote(value)}` });
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => matchesType(value, type))) {
      issues.push({ pointer: pointer || '/', keyword: 'type', params: { expected: types }, message: `must be ${list(types)}; found ${typeNameOf(value)}` });
      return issues;
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({ pointer: pointer || '/', keyword: 'minLength', message: `must not be empty (minimum ${schema.minLength} character(s))` });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      issues.push({ pointer: pointer || '/', keyword: 'pattern', params: { pattern: schema.pattern }, message: `${quote(value)} does not match ${schema.pattern}` });
    }
    if (schema.format === 'date' && !isRealDate(value)) {
      issues.push({ pointer: pointer || '/', keyword: 'format', message: `${quote(value)} is not a real calendar date in YYYY-MM-DD form` });
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({ pointer: pointer || '/', keyword: 'minItems', message: `must have at least ${schema.minItems} entry(ies)` });
    }
    if (schema.items) value.forEach((entry, index) => checkAgainstSchema(entry, schema.items, { root, pointer: pointerOf(pointer, index), issues }));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        issues.push({ pointer: pointerOf(pointer, key), keyword: 'required', message: 'is required and is missing' });
      }
    }
    const properties = schema.properties ?? {};
    for (const [key, entry] of Object.entries(value)) {
      if (properties[key]) { checkAgainstSchema(entry, properties[key], { root, pointer: pointerOf(pointer, key), issues }); continue; }
      if (schema.additionalProperties === false) {
        issues.push({ pointer: pointerOf(pointer, key), keyword: 'additionalProperties', params: { allowed: Object.keys(properties) },
          message: `is not a known field here (known fields: ${Object.keys(properties).join(', ')}); check the spelling` });
      }
    }
  }
  return issues;
}

export const checkSchemaValue = (value, schema) => checkAgainstSchema(value, schema, { root: schema, pointer: '', issues: [] });

