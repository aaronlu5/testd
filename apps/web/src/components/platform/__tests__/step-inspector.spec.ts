import { describe, expect, it } from 'vitest'
import { RouterLinkStub, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { StepTypeMetadata, TestNode } from '~/api/types'
import CodeEditor from '~/components/platform/CodeEditor.vue'
import StepInspector from '~/components/platform/StepInspector.vue'

const delayType: StepTypeMetadata = {
  type: 'delay',
  displayName: 'Delay',
  description: 'Waits.',
  configSchema: {
    type: 'object',
    required: ['durationSeconds'],
    additionalProperties: false,
    properties: { durationSeconds: { type: 'number', minimum: 0, maximum: 60 } },
  },
  sensitivePaths: [],
  defaults: { durationSeconds: 1 },
  capabilities: { external: false, supportsRetry: true, supportsArtifacts: false },
}

const assertType: StepTypeMetadata = {
  type: 'assert',
  displayName: 'Assert',
  configSchema: {
    type: 'object',
    required: ['actual', 'operator'],
    additionalProperties: false,
    properties: { actual: {}, operator: { enum: ['equals', 'exists'] }, expected: {} },
  },
  sensitivePaths: [],
  defaults: { operator: 'equals' },
  capabilities: { external: false, supportsRetry: false, supportsArtifacts: false },
}

const secretType: StepTypeMetadata = {
  type: 'http',
  displayName: 'HTTP',
  configSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, apiKey: { type: 'string' } },
  },
  sensitivePaths: ['/apiKey'],
  defaults: {},
  capabilities: { external: true, supportsRetry: true, supportsArtifacts: false },
}

const node = (type: string, parameters: TestNode['parameters']): TestNode => ({
  id: `${type}-1`,
  type,
  name: type,
  parameters,
})

const mountInspector = (props: Record<string, unknown>) =>
  mount(StepInspector, { props: props as never, global: { stubs: { RouterLink: RouterLinkStub } } })

describe('Step inspector', () => {
  it('renders a form from the Step JSON Schema', () => {
    const wrapper = mountInspector({
      node: node('delay', { durationSeconds: 2 }),
      stepType: delayType,
    })
    const input = wrapper.get('#param-delay-1-durationSeconds')
    expect((input.element as HTMLInputElement).value).toBe('2')
    expect(wrapper.text()).toContain('Duration Seconds')
    expect(wrapper.find('[data-testid="expression-help"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="step-defaults"]').text()).toContain('"durationSeconds": 1')
  })

  it('emits typed parameter updates', async () => {
    const wrapper = mountInspector({
      node: node('delay', { durationSeconds: 1 }),
      stepType: delayType,
    })
    await wrapper.get('#param-delay-1-durationSeconds').setValue('3')
    const updates = wrapper.emitted('update') ?? []
    expect(updates[updates.length - 1]).toEqual([{ parameters: { durationSeconds: 3 } }])
  })

  it('shows field-level validation messages', () => {
    const wrapper = mountInspector({
      node: node('delay', { durationSeconds: -5 }),
      stepType: delayType,
    })
    const error = wrapper.get('[data-testid="field-durationSeconds"] [role="alert"]')
    expect(error.text()).toBe('Must be at least 0.')
    expect(wrapper.get('#param-delay-1-durationSeconds').attributes('aria-invalid')).toBe('true')
  })

  it('reports a missing required field', () => {
    const wrapper = mountInspector({ node: node('delay', {}), stepType: delayType })
    expect(wrapper.get('[data-testid="field-durationSeconds"]').text()).toContain(
      'This field is required.',
    )
  })

  it('accepts an expression where a number is expected', async () => {
    const wrapper = mountInspector({
      node: node('delay', { durationSeconds: 1 }),
      stepType: delayType,
    })
    await wrapper.get('#param-delay-1-durationSeconds').setValue('{{variables.wait}}')
    const updates = wrapper.emitted('update') ?? []
    expect(updates[updates.length - 1]).toEqual([
      { parameters: { durationSeconds: '{{variables.wait}}' } },
    ])
  })

  it('shows server-side messages next to the field', () => {
    const wrapper = mountInspector({
      node: node('assert', { actual: 1, operator: 'equals' }),
      stepType: assertType,
      serverErrors: { expected: 'is required for operator "equals"' },
    })
    expect(wrapper.get('[data-testid="field-expected"]').text()).toContain(
      'is required for operator "equals"',
    )
  })

  it('edits any-JSON parameters as JSON or text and rejects broken JSON', async () => {
    const wrapper = mountInspector({
      node: node('assert', { actual: 1, operator: 'equals', expected: 'x' }),
      stepType: assertType,
    })
    const editor = wrapper
      .findAllComponents(CodeEditor)
      .find((candidate) => candidate.props('id') === 'param-assert-1-expected')!
    editor.vm.$emit('update:modelValue', '{"a": 1}')
    await nextTick()
    const updates = wrapper.emitted('update') ?? []
    expect(updates[updates.length - 1]).toEqual([
      { parameters: { actual: 1, operator: 'equals', expected: { a: 1 } } },
    ])
    editor.vm.$emit('update:modelValue', '{"a": ')
    await nextTick()
    expect(wrapper.get('[data-testid="field-expected"] [role="alert"]').text()).toBe(
      'This is not valid JSON.',
    )
  })

  it('edits a SQL statement in a SQL code editor and keeps it as text', async () => {
    const sqlType: StepTypeMetadata = {
      type: 'sql.query',
      displayName: 'SQL Server query',
      configSchema: {
        type: 'object',
        required: ['statement'],
        properties: { statement: { type: 'string', minLength: 1 } },
      },
      sensitivePaths: [],
      defaults: {},
      capabilities: { external: true, supportsRetry: true, supportsArtifacts: false },
    }
    const wrapper = mountInspector({
      node: node('sql.query', { statement: 'SELECT 1' }),
      stepType: sqlType,
    })
    const editor = wrapper.getComponent(CodeEditor)
    expect(editor.props('language')).toBe('sql')
    editor.vm.$emit('update:modelValue', 'SELECT id\nFROM dbo.Orders')
    await nextTick()
    const updates = wrapper.emitted('update') ?? []
    expect(updates[updates.length - 1]).toEqual([
      { parameters: { statement: 'SELECT id\nFROM dbo.Orders' } },
    ])
  })

  it('never renders or retains secret values', () => {
    const wrapper = mountInspector({
      node: node('http', { path: '/x', apiKey: 'hunter2-secret' }),
      stepType: secretType,
    })
    const field = wrapper.get('#param-http-1-apiKey')
    expect(field.attributes('disabled')).toBeDefined()
    expect((field.element as HTMLInputElement).value).toBe('')
    expect(wrapper.html()).not.toContain('hunter2-secret')
    expect(wrapper.text()).toContain('Secrets are never entered here')
  })

  const blobType: StepTypeMetadata = {
    type: 'blob.upload',
    displayName: 'Blob upload',
    configSchema: {
      type: 'object',
      required: ['target', 'content'],
      properties: {
        target: { type: 'string' },
        blobName: { type: 'string' },
        files: { type: 'array' },
        content: { description: 'String or JSON value to upload.' },
        contentEncoding: { enum: ['utf8', 'base64'] },
      },
    },
    sensitivePaths: ['content'],
    defaults: {},
    capabilities: { external: true, supportsRetry: true, supportsArtifacts: false },
  }

  it('offers the targets of the chosen Environment that fit the Step', async () => {
    const wrapper = mountInspector({
      node: node('blob.upload', { target: 'local-storage' }),
      stepType: blobType,
      environmentTargets: [
        { name: 'local-storage', kind: 'azureBlob' },
        { name: 'orders-api', kind: 'http' },
      ],
    })
    const options = wrapper.get('[id="param-blob.upload-1-target"]').findAll('option')
    expect(options.map((option) => option.text())).toEqual(['(select a target)', 'local-storage'])
  })

  it('keeps a free-text target when no Environment is chosen', () => {
    const wrapper = mountInspector({ node: node('blob.upload', {}), stepType: blobType })
    expect(wrapper.get('[id="param-blob.upload-1-target"]').element.tagName).toBe('INPUT')
  })

  it('switches Blob upload to files, which replace the blob name and content', async () => {
    const wrapper = mountInspector({
      node: node('blob.upload', { blobName: 'a.json', content: 'x' }),
      stepType: blobType,
    })
    await wrapper.get('[data-testid="source-file"]').setValue(true)
    expect(wrapper.emitted('update')?.[0]?.[0]).toEqual({ parameters: { files: [] } })
  })

  it('lists stored files, disables the blob name and hides the content field', () => {
    const wrapper = mountInspector({
      node: node('blob.upload', {
        files: [
          { name: 'a.csv', content: 'AQID' },
          { name: 'b.csv', content: 'aGk=' },
        ],
      }),
      stepType: blobType,
    })
    expect(wrapper.get('[data-testid="blob-files"]').text()).toContain('a.csv')
    expect(wrapper.get('[data-testid="blob-files"]').text()).toContain('b.csv')
    expect(wrapper.find('[data-testid="field-content"]').exists()).toBe(false)
    const blobName = wrapper.get('[id="param-blob.upload-1-blobName"]')
    expect(blobName.attributes('disabled')).toBeDefined()
  })

  it('removes a stored file', async () => {
    const wrapper = mountInspector({
      node: node('blob.upload', {
        files: [
          { name: 'a.csv', content: 'AQID' },
          { name: 'b.csv', content: 'aGk=' },
        ],
      }),
      stepType: blobType,
    })
    await wrapper.get('[aria-label="Remove a.csv"]').trigger('click')
    expect(wrapper.emitted('update')?.[0]?.[0]).toEqual({
      parameters: { files: [{ name: 'b.csv', content: 'aGk=' }] },
    })
  })

  const httpType: StepTypeMetadata = {
    type: 'http.request',
    displayName: 'HTTP request',
    configSchema: {
      type: 'object',
      required: ['target', 'path'],
      properties: {
        target: { type: 'string' },
        path: { type: 'string' },
        mock: { type: 'boolean' },
        mockStatus: { type: 'integer', minimum: 100, maximum: 599 },
        mockBody: { description: 'JSON value returned when mocking.' },
      },
    },
    sensitivePaths: [],
    defaults: {},
    capabilities: { external: true, supportsRetry: true, supportsArtifacts: true },
  }

  it('shows the mock status and body only while Mock is ticked', async () => {
    const off = mountInspector({
      node: node('http.request', { target: 'api', path: '/x' }),
      stepType: httpType,
    })
    expect(off.find('[data-testid="field-mock"]').exists()).toBe(true)
    expect(off.find('[data-testid="field-mockStatus"]').exists()).toBe(false)
    expect(off.find('[data-testid="field-mockBody"]').exists()).toBe(false)

    const on = mountInspector({
      node: node('http.request', { target: 'api', path: '/x', mock: true }),
      stepType: httpType,
    })
    expect(on.find('[data-testid="field-mockStatus"]').exists()).toBe(true)
    expect(on.find('[data-testid="field-mockBody"]').exists()).toBe(true)
  })

  it('lists only earlier Steps in the expression help', () => {
    const wrapper = mountInspector({
      node: node('delay', { durationSeconds: 1 }),
      stepType: delayType,
      previous: ['first', 'second'],
    })
    expect(wrapper.get('[data-testid="expression-help"]').text()).toContain('first')
  })

  it('warns when the Step type is not offered by the server', () => {
    const wrapper = mountInspector({ node: node('mystery', {}) })
    expect(wrapper.text()).toContain('not available on this server')
  })
})
