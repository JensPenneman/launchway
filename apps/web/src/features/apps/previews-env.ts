/** Quotes a value for `.env` text when it would not survive `parseDotenv` unquoted. */
function quote(value: string): string {
  if (value === '' || /^[^\s"'#\\]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

/** `KEY=value` lines for an override map, in key order; parseDotenv reads them back. */
export function formatDotenv(values: Readonly<Record<string, string>>): string {
  return Object.keys(values)
    .sort()
    .map((key) => `${key}=${quote(values[key] ?? '')}`)
    .join('\n');
}
