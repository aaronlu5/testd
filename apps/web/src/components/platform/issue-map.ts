import type { TestNode, ValidationIssue } from '~/api/types'

export type NodeIssues = {
  /** Messages for individual parameters, keyed by parameter name. */
  parameters: Record<string, string>
  other: string[]
}

export type MappedIssues = {
  byNode: Record<string, NodeIssues>
  /** Issues that do not belong to a single Step. */
  general: ValidationIssue[]
}

const NODE_PATH = /^\/nodes\/(\d+)(?:\/(.*))?$/

/** Attaches server validation issues (JSON pointers) to the Steps and parameters they describe. */
export const mapIssues = (
  issues: readonly ValidationIssue[],
  nodes: readonly Pick<TestNode, 'id'>[],
): MappedIssues => {
  const result: MappedIssues = { byNode: {}, general: [] }
  for (const issue of issues) {
    const match = NODE_PATH.exec(issue.path)
    const node = match ? nodes[Number(match[1])] : undefined
    if (!match || !node) {
      result.general.push(issue)
      continue
    }
    const entry = (result.byNode[node.id] ??= { parameters: {}, other: [] })
    const rest = match[2] ?? ''
    const parameter = /^parameters\/([^/]+)/.exec(rest)?.[1]
    if (parameter) entry.parameters[parameter] ??= issue.message
    else entry.other.push(`${rest || 'Step'}: ${issue.message}`)
  }
  return result
}
