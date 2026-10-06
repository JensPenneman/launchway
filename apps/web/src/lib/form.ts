import type { z } from '@slipway/contracts';
import { type FieldErrors, type FieldValues, type Resolver, set } from 'react-hook-form';

type Issue = z.core.$ZodRawIssue;

/** Friendlier wording for Zod's default messages (schema-specific messages still win). */
export function friendlyMessage(issue: Issue): string | undefined {
  switch (issue.code) {
    case 'too_small':
      if (issue.origin === 'string') {
        return issue.minimum === 1 ? 'Required' : `Must be at least ${issue.minimum} characters`;
      }
      if (issue.origin === 'array') return `Choose at least ${issue.minimum}`;
      return `Must be at least ${issue.minimum}`;
    case 'too_big':
      return issue.origin === 'string'
        ? `Must be at most ${issue.maximum} characters`
        : `Must be at most ${issue.maximum}`;
    case 'invalid_format':
      if (issue.format === 'email') return 'Enter a valid e-mail address';
      if (issue.format === 'url') return 'Enter a valid URL';
      return undefined;
    case 'invalid_type':
      return issue.input === undefined || issue.input === '' ? 'Required' : undefined;
    default:
      return undefined;
  }
}

/** react-hook-form resolver for a contracts (Zod) schema. */
export function zodResolver<Input extends FieldValues, Output>(
  schema: z.ZodType<Output, Input>,
): Resolver<Input, unknown, Output> {
  return async (values) => {
    const result = await schema.safeParseAsync(values, { error: friendlyMessage });
    if (result.success) return { values: result.data, errors: {} };
    const errors: FieldErrors<Input> = {};
    for (const issue of result.error.issues) {
      const path = issue.path.map(String).join('.') || 'root';
      set(errors, path, { type: issue.code, message: issue.message });
    }
    return { values: {}, errors };
  };
}

/** First validation message for a single value, or undefined when it is valid. */
export function fieldError(schema: z.ZodType, value: unknown): string | undefined {
  return schema.safeParse(value, { error: friendlyMessage }).error?.issues[0]?.message;
}
