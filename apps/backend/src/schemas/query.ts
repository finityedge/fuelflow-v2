import { z } from 'zod';

/**
 * A boolean arriving as a query-string value.
 *
 * `z.coerce.boolean()` looks like the obvious tool and is a trap here: `Boolean("false")` is
 * `true`, so every non-empty string coerces to true and `?includeInactive=false` would quietly
 * mean the opposite of what it says. Spelled out as an explicit two-value enum instead.
 */
export const booleanQueryParam = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');
