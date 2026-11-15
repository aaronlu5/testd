import type { JsonObject, JsonValue } from '~/api/types'

export type ParsedObject = { ok: true; value: JsonObject } | { ok: false; error: string }

/** Parses text that must be a JSON object, with an error message fit for display. */
export const parseJsonObject = (text: string): ParsedObject => {
  if (text.trim() === '') return { ok: false, error: 'Enter a JSON object.' }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    const reason = error instanceof SyntaxError ? error.message : 'invalid JSON'
    return { ok: false, error: `This is not valid JSON: ${reason}` }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return { ok: false, error: 'The top level must be a JSON object, not an array or a value.' }
  return { ok: true, value: value as JsonObject }
}

const SENSITIVE_KEY = /(secret|password|passwd|token|apikey|api_key|credential|connectionstring)/i

export const isSensitiveName = (name: string): boolean => SENSITIVE_KEY.test(name)

/** Paths of keys that look like secrets; Test Data is stored in plain text. */
export const sensitiveKeyWarnings = (value: JsonValue, path = ''): string[] => {
  if (Array.isArray(value))
    return value.flatMap((item, index) => sensitiveKeyWarnings(item, `${path}[${index}]`))
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => {
    const here = path ? `${path}.${key}` : key
    const own = SENSITIVE_KEY.test(key)
      ? [
          `“${here}” looks like a secret. Test Data is stored unencrypted; use an Environment secret instead.`,
        ]
      : []
    return [...own, ...sensitiveKeyWarnings(child, here)]
  })
}
