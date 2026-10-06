/** Field kinds the generic credentials form can render. */
export type SchemaFieldKind = 'string' | 'secret' | 'boolean' | 'enum' | 'number';

export interface SchemaField {
  name: string;
  label: string;
  description: string | null;
  kind: SchemaFieldKind;
  required: boolean;
  options: string[];
  defaultValue: string | boolean | number | null;
}

type JsonSchema = Record<string, unknown>;

const SECRET_NAME = /(token|secret|password|passphrase|api[-_]?key|private[-_]?key)/i;

function asObject(value: unknown): JsonSchema | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonSchema)
    : null;
}

function humanize(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function fieldKind(name: string, schema: JsonSchema): SchemaFieldKind | null {
  if (Array.isArray(schema.enum) && schema.enum.every((v) => typeof v === 'string')) return 'enum';
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  if (type === 'boolean') return 'boolean';
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'string') {
    const secret =
      schema.format === 'password' ||
      schema.writeOnly === true ||
      schema['x-secret'] === true ||
      SECRET_NAME.test(name);
    return secret ? 'secret' : 'string';
  }
  return null;
}

/**
 * Turns the JSON Schema of a DNS provider's credentials into form fields. Only flat objects with
 * string / secret / boolean / number / enum properties are supported; anything else is skipped.
 */
export function schemaToFields(schema: unknown): SchemaField[] {
  const root = asObject(schema);
  const properties = asObject(root?.properties);
  if (!root || !properties) return [];
  const required = new Set(
    Array.isArray(root.required) ? root.required.filter((v) => typeof v === 'string') : [],
  );
  const fields: SchemaField[] = [];
  for (const [name, value] of Object.entries(properties)) {
    const property = asObject(value);
    if (!property) continue;
    const kind = fieldKind(name, property);
    if (!kind) continue;
    const def = property.default;
    fields.push({
      name,
      label: typeof property.title === 'string' ? property.title : humanize(name),
      description: typeof property.description === 'string' ? property.description : null,
      kind,
      required: required.has(name),
      options: kind === 'enum' ? (property.enum as string[]) : [],
      defaultValue:
        typeof def === 'string' || typeof def === 'boolean' || typeof def === 'number' ? def : null,
    });
  }
  return fields;
}

/** Converts form values (strings from inputs) into the credentials object for the API. */
export function fieldsToCredentials(
  fields: readonly SchemaField[],
  values: Record<string, string | boolean>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (field.kind === 'boolean') {
      result[field.name] = value === true;
      continue;
    }
    if (typeof value !== 'string' || value === '') continue;
    result[field.name] = field.kind === 'number' ? Number(value) : value;
  }
  return result;
}
