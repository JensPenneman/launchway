import { describe, expect, it } from 'vitest';
import { fieldsToCredentials, schemaToFields } from './json-schema-form';

const cloudflare = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    apiToken: { type: 'string', minLength: 1, description: 'Zone:DNS:Edit token' },
    accountId: { type: 'string' },
    proxiedByDefault: { type: 'boolean', default: false },
    region: { type: 'string', enum: ['eu', 'us'] },
    ttl: { type: 'integer', default: 1 },
    nested: { type: 'object', properties: {} },
  },
  required: ['apiToken'],
  additionalProperties: false,
};

describe('schemaToFields', () => {
  it('maps supported property types and detects secrets', () => {
    const fields = schemaToFields(cloudflare);
    expect(fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ['apiToken', 'secret', true],
      ['accountId', 'string', false],
      ['proxiedByDefault', 'boolean', false],
      ['region', 'enum', false],
      ['ttl', 'number', false],
    ]);
    expect(fields[0]?.label).toBe('Api token');
    expect(fields[0]?.description).toBe('Zone:DNS:Edit token');
    expect(fields[3]?.options).toEqual(['eu', 'us']);
  });

  it('honours format: password and ignores non-object schemas', () => {
    expect(
      schemaToFields({
        type: 'object',
        properties: { pin: { type: 'string', format: 'password' } },
      })[0]?.kind,
    ).toBe('secret');
    expect(schemaToFields(null)).toEqual([]);
    expect(schemaToFields({ type: 'string' })).toEqual([]);
  });
});

describe('fieldsToCredentials', () => {
  it('drops empty strings and converts booleans and numbers', () => {
    const fields = schemaToFields(cloudflare);
    expect(
      fieldsToCredentials(fields, {
        apiToken: 'abc',
        accountId: '',
        proxiedByDefault: true,
        ttl: '300',
      }),
    ).toEqual({ apiToken: 'abc', proxiedByDefault: true, ttl: 300 });
  });
});
