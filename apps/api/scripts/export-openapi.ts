// Writes the OpenAPI document to apps/api/openapi.json without starting the server.
// Used by `pnpm openapi:generate` to generate the web client.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from '../src/openapi.js';

const target = new URL('../openapi.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`OpenAPI document written to ${fileURLToPath(target)}`);
process.exit(0);
