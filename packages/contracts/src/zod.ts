import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Adds `.openapi()` metadata support to every Zod schema. All contract modules import `z`
// from here so the extension is guaranteed to run first.
extendZodWithOpenApi(z);

export { z };
