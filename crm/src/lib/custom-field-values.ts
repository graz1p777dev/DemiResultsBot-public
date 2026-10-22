/**
 * Separates explicitly configured custom fields from unrecognised keys without
 * treating a meaningful `false` value as empty. The caller persists `known` to
 * declared fields and `unknown` to an entity's JSONB extra_data.
 */
export function partitionCustomFieldValues(
  values: Record<string, unknown>,
  knownKeys: Iterable<string>,
): { known: Record<string, unknown>; unknown: Record<string, unknown> } {
  const knownSet = new Set(knownKeys)
  const known: Record<string, unknown> = {}
  const unknown: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(values)) {
    if (knownSet.has(key)) known[key] = value
    else unknown[key] = value
  }

  return { known, unknown }
}
