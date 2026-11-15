import { compileMockPattern, matchesMockPattern } from '@test-platform/contracts'
import type { JsonValue, MockRule, MockRuleMethod } from '~/api/types'

export const MOCK_RULE_METHODS: readonly MockRuleMethod[] = [
  'GET',
  'HEAD',
  'OPTIONS',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]

/** A rule as the form holds it: every field is text until it is saved. */
export type RuleDraft = {
  uid: number
  name: string
  /** Empty means any method. */
  method: '' | MockRuleMethod
  path: string
  status: string
  /** JSON text; empty means no response body. */
  bodyText: string
}

let nextUid = 1
export const ruleUid = (): number => nextUid++

export const blankRule = (): RuleDraft => ({
  uid: ruleUid(),
  name: '',
  method: '',
  path: '/',
  status: '200',
  bodyText: '{\n  \n}',
})

export const fromRule = (rule: MockRule): RuleDraft => ({
  uid: ruleUid(),
  name: rule.name ?? '',
  method: rule.method ?? '',
  path: rule.path,
  status: String(rule.status),
  bodyText: rule.body === undefined ? '' : JSON.stringify(rule.body, null, 2),
})

export type RuleIssues = { path?: string; status?: string; body?: string }

export const ruleIssues = (rule: RuleDraft): RuleIssues => {
  const issues: RuleIssues = {}
  const path = rule.path
  if (!path.startsWith('/')) issues.path = 'The path must start with "/".'
  else {
    try {
      compileMockPattern(path)
    } catch (error) {
      issues.path = `Not a valid regular expression: ${error instanceof Error ? error.message : 'unknown error'}.`
    }
  }
  const status = Number(rule.status)
  if (!/^\d+$/.test(rule.status.trim()) || status < 100 || status > 599)
    issues.status = 'Use a status code from 100 to 599.'
  if (rule.bodyText.trim() !== '') {
    try {
      JSON.parse(rule.bodyText)
    } catch {
      issues.body = 'The body must be valid JSON.'
    }
  }
  return issues
}

export const hasRuleIssues = (rule: RuleDraft): boolean => Object.keys(ruleIssues(rule)).length > 0

/** The saved form of a rule; an invalid body is left out (the form blocks saving first). */
export const toRule = (rule: RuleDraft): MockRule => {
  let body: JsonValue | undefined
  if (rule.bodyText.trim() !== '') {
    try {
      body = JSON.parse(rule.bodyText) as JsonValue
    } catch {
      body = undefined
    }
  }
  return {
    ...(rule.name.trim() ? { name: rule.name.trim() } : {}),
    ...(rule.method ? { method: rule.method } : {}),
    path: rule.path,
    status: Number(rule.status),
    ...(body !== undefined ? { body } : {}),
  }
}

/** Index of the first rule that answers the request, using the same rules as the server. */
export const firstMatch = (
  rules: readonly RuleDraft[],
  method: string,
  path: string,
  query = '',
): number =>
  rules.findIndex((rule) => {
    if (rule.method && rule.method !== method.toUpperCase()) return false
    if (ruleIssues(rule).path) return false
    return matchesMockPattern(compileMockPattern(rule.path), path, query)
  })

/** Splits a typed request into its path and its query string (without the "?"). */
export const requestParts = (text: string): { path: string; query: string } => {
  const trimmed = text.trim()
  const cut = trimmed.indexOf('?')
  return cut < 0
    ? { path: trimmed, query: '' }
    : { path: trimmed.slice(0, cut), query: trimmed.slice(cut + 1) }
}
