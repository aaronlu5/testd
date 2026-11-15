import type { JsonValue } from '~/api/types'
import { isSensitiveName } from '~/components/platform/json-object'

export type OverrideResult = {
  value: Record<string, JsonValue>
  errors: Record<string, string>
}

/**
 * Turns the override text boxes into the `variableOverrides` request field. Blank boxes are
 * skipped, values parse as JSON when they can and are otherwise plain text, and names that look
 * like secrets are refused: secrets must never travel with a Run request.
 */
export const buildOverrides = (
  declared: readonly string[],
  text: Readonly<Record<string, string>>,
): OverrideResult => {
  const result: OverrideResult = { value: {}, errors: {} }
  for (const name of declared) {
    const raw = text[name]
    if (raw === undefined || raw.trim() === '') continue
    if (isSensitiveName(name)) {
      result.errors[name] = 'Secrets cannot be passed as overrides.'
      continue
    }
    try {
      result.value[name] = JSON.parse(raw.trim()) as JsonValue
    } catch {
      result.value[name] = raw
    }
  }
  return result
}
