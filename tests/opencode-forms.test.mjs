import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formQuestions, formAnswer } from '../integrations/opencode-forms.mjs'
const field = {
  key: 'choice',
  type: 'string',
  title: 'Choose',
  required: true,
  custom: false,
  options: [{ label: 'Keep', value: 'keep-original' }],
}

test('supported forms preserve keys, values, boolean and multi-select answers', () => {
  const form = {
    fields: [
      field,
      { key: 'confirm', type: 'boolean', title: 'Confirm', required: true },
      {
        key: 'targets',
        type: 'multiselect',
        title: 'Targets',
        required: true,
        options: [
          { label: 'Mac', value: 'darwin' },
          { label: 'Linux', value: 'linux' },
        ],
        custom: true,
      },
    ],
  }
  assert.equal(formQuestions(form).length, 3)
  assert.deepEqual(formAnswer(form, [['Keep'], ['No'], ['Mac', 'Custom']]), {
    choice: 'keep-original',
    confirm: false,
    targets: ['darwin', 'Custom'],
  })
  assert.throws(() => formAnswer(form, [['Keep']]))
  assert.throws(() => formAnswer(form, [['Unknown'], ['Yes'], ['Mac']]))
  assert.throws(() => formAnswer(form, [['Keep'], ['Maybe'], ['Mac']]))
  assert.throws(() => formAnswer(form, [['Keep'], ['Yes'], []]))
})

test('forms requiring unsupported semantics stay in the native agent', () => {
  for (const change of [
    { type: 'external', url: 'https://example.com' },
    { type: 'integer' },
    { type: 'number' },
    { required: false },
    { hidden: true },
    { when: [] },
    { default: 'Keep' },
    { format: 'email' },
    { minLength: 2 },
    { maxLength: 3 },
    { pattern: 'secret' },
    { minItems: 1 },
    { maxItems: 2 },
    { minimum: 0 },
    { maximum: 5 },
    {
      options: [
        { label: 'Repeat', value: 'a' },
        { label: 'Repeat', value: 'b' },
      ],
    },
    { options: [{ label: 'Missing native value' }] },
    { options: [{ label: 'x'.repeat(257), value: 'a' }] },
    { description: 'x'.repeat(4097) },
  ])
    assert.equal(
      formQuestions({ fields: [{ ...field, ...change }] }),
      null,
      JSON.stringify(change).slice(0, 100),
    )
  assert.equal(formQuestions({ fields: [] }), null)
  assert.equal(
    formQuestions({
      fields: Array.from({ length: 9 }, (_, i) => ({ ...field, key: String(i), title: String(i) })),
    }),
    null,
  )
  assert.equal(
    formQuestions({ fields: [field, { ...field, key: 'second' }] }),
    null,
    'Ambiguous displayed questions cannot be answered by index',
  )
})
