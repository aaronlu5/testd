import Ajv, { type ErrorObject } from 'ajv'
import type { JsonObject, JsonSchema, JsonValue } from '~/api/types'

/**
 * Minimal JSON Schema form model for Step parameters. It handles the shapes Step schemas use:
 * strings, numbers, booleans, enums, and "any JSON" properties (`{}`) that may hold an expression.
 * Anything it cannot render as a simple control falls back to a JSON editor.
 */

export type FieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'json'

export type FieldDefinition = {
  key: string
  label: string
  kind: FieldKind
  required: boolean
  description?: string
  options?: JsonValue[]
  minimum?: number
  maximum?: number
  maxLength?: number
  /** Secrets are never entered, shown, or kept by the form. */
  sensitive: boolean
  /** The value may be entered, but the platform masks it in logs and run records. */
  redacted: boolean
}

type SchemaProperty = {
  type?: string | string[]
  enum?: JsonValue[]
  description?: string
  title?: string
  minimum?: number
  maximum?: number
  maxLength?: number
}

const SENSITIVE_KEY = /(secret|password|passwd|token|apikey|api_key|credential|connectionstring)/i
const EXPRESSION = /\{\{[\s\S]*?\}\}/

export const containsExpression = (value: unknown): boolean =>
  typeof value === 'string' && EXPRESSION.test(value)

const humanize = (key: string): string =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())

const kindOf = (property: SchemaProperty): FieldKind => {
  if (Array.isArray(property.enum)) return 'enum'
  const type = Array.isArray(property.type) ? undefined : property.type
  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean')
    return type
  return 'json'
}

export const buildFields = (
  schema: JsonSchema | undefined,
  sensitivePaths: readonly string[] = [],
): FieldDefinition[] => {
  const root = (schema ?? {}) as {
    properties?: Record<string, SchemaProperty>
    required?: string[]
  }
  const required = new Set(root.required ?? [])
  // Step `sensitivePaths` say what to mask in logs, not that the author may not type it (a blob
  // upload's `content` is both required input and masked). Only credential-like names are blocked.
  const redacted = new Set(sensitivePaths.map((path) => path.replace(/^\/+/, '').split('/')[0]))
  return Object.entries(root.properties ?? {}).map(([key, property]) => ({
    key,
    label: property.title ?? humanize(key),
    kind: kindOf(property),
    required: required.has(key),
    description: property.description,
    options: property.enum,
    minimum: property.minimum,
    maximum: property.maximum,
    maxLength: property.maxLength,
    sensitive: SENSITIVE_KEY.test(key),
    redacted: redacted.has(key),
  }))
}

/** Text shown in the control for a stored value. */
export const formatForInput = (value: JsonValue | undefined, field: FieldDefinition): string => {
  if (value === undefined) return ''
  if (field.kind !== 'json') return typeof value === 'string' ? value : JSON.stringify(value)
  if (typeof value === 'string') {
    // A string that would parse as other JSON is quoted so it round-trips as a string.
    try {
      const parsed: unknown = JSON.parse(value)
      return typeof parsed === 'string' ? value : JSON.stringify(value)
    } catch {
      return value
    }
  }
  return JSON.stringify(value, null, 2)
}

export type ParsedInput = { omit: true } | { value: JsonValue } | { error: string }

/** Converts control text back to a value; expressions are kept as strings in any field. */
export const parseInput = (text: string, field: FieldDefinition): ParsedInput => {
  if (text.trim() === '') return { omit: true }
  if (field.kind === 'string' || field.kind === 'enum') return { value: text }
  if (field.kind === 'number' || field.kind === 'integer') {
    const trimmed = text.trim()
    if (containsExpression(trimmed)) return { value: trimmed }
    const parsed = Number(trimmed)
    return Number.isFinite(parsed)
      ? { value: parsed }
      : { error: 'Enter a number or an expression such as {{variables.count}}.' }
  }
  const trimmed = text.trim()
  try {
    return { value: JSON.parse(trimmed) as JsonValue }
  } catch {
    if (/^[[{]/.test(trimmed) && !containsExpression(trimmed))
      return { error: 'This is not valid JSON.' }
    return { value: text }
  }
}

const ajv = new Ajv({ allErrors: true, strict: false })
const compiled = new WeakMap<object, ReturnType<Ajv['compile']>>()

const validatorFor = (schema: JsonSchema) => {
  let validate = compiled.get(schema)
  if (!validate) {
    validate = ajv.compile(schema)
    compiled.set(schema, validate)
  }
  return validate
}

const messageFor = (error: ErrorObject): string => {
  switch (error.keyword) {
    case 'required':
      return 'This field is required.'
    case 'minimum':
      return `Must be at least ${(error.params as { limit: number }).limit}.`
    case 'maximum':
      return `Must be at most ${(error.params as { limit: number }).limit}.`
    case 'maxLength':
      return `Must be at most ${(error.params as { limit: number }).limit} characters.`
    case 'enum':
      return 'Choose one of the allowed values.'
    case 'type':
      return `Must be ${String((error.params as { type: string }).type)}.`
    default:
      return error.message ?? 'This value is not valid.'
  }
}

export type FieldErrors = { fields: Record<string, string>; form: string[] }

/**
 * Field-level validation against the Step schema. Values holding an expression are skipped for
 * type and range checks, because they only become concrete when the Run executes.
 */
export const validateParameters = (
  schema: JsonSchema | undefined,
  parameters: JsonObject,
): FieldErrors => {
  const result: FieldErrors = { fields: {}, form: [] }
  if (!schema) return result
  const validate = validatorFor(schema)
  if (validate(parameters)) return result

  for (const error of validate.errors ?? []) {
    const key =
      error.keyword === 'required'
        ? (error.params as { missingProperty: string }).missingProperty
        : error.instancePath.split('/')[1]
    if (error.keyword === 'additionalProperties') {
      result.form.push(
        `Unknown parameter "${(error.params as { additionalProperty: string }).additionalProperty}".`,
      )
      continue
    }
    if (key === undefined || key === '') {
      result.form.push(messageFor(error))
      continue
    }
    if (error.keyword !== 'required' && containsExpression(parameters[decodeURIComponent(key)]))
      continue
    result.fields[key] ??= messageFor(error)
  }
  return result
}
