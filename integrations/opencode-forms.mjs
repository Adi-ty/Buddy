const text = (value, limit) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= limit

// Buddy's question panel represents required text/choice questions, not a
// general form editor. Leave richer forms in OpenCode instead of losing rules.
export function formQuestions(form) {
  if (!Array.isArray(form.fields) || !form.fields.length || form.fields.length > 8) return null
  const keys = new Set()
  const questions = []
  for (const field of form.fields) {
    if (
      !field ||
      !text(field.key, 256) ||
      keys.has(field.key) ||
      !['string', 'multiselect', 'boolean'].includes(field.type) ||
      field.required === false ||
      field.hidden === true ||
      [
        'when',
        'default',
        'format',
        'minLength',
        'maxLength',
        'pattern',
        'minItems',
        'maxItems',
        'minimum',
        'maximum',
      ].some((key) => field[key] !== undefined)
    )
      return null
    keys.add(field.key)
    const options =
      field.type === 'boolean'
        ? [
            { label: 'Yes', value: true },
            { label: 'No', value: false },
          ]
        : (field.options ?? [])
    if (
      !Array.isArray(options) ||
      options.length > 16 ||
      options.some(
        (option) =>
          !option ||
          !text(option.label, 256) ||
          (option.description !== undefined &&
            (typeof option.description !== 'string' || option.description.length > 2048)) ||
          (field.type !== 'boolean' && typeof option.value !== 'string'),
      ) ||
      new Set(options.map((option) => option.label)).size !== options.length
    )
      return null
    const custom = field.type !== 'boolean' && field.custom !== false
    const question = field.description || field.title || form.title || 'Please provide an answer.'
    if (
      !text(question, 4096) ||
      questions.some((q) => q.text === question) ||
      (!custom && !options.length)
    )
      return null
    questions.push({
      text: question,
      header: field.title ?? '',
      multiple: field.type === 'multiselect',
      custom,
      options: options.map((option) => ({
        label: option.label,
        description: option.description ?? '',
      })),
    })
  }
  return questions
}

export function formAnswer(form, answers) {
  const questions = formQuestions(form)
  if (!questions || !Array.isArray(answers) || answers.length !== questions.length)
    throw new Error('Invalid form answer')
  return Object.fromEntries(
    form.fields.map((field, index) => {
      const question = questions[index]
      const values = answers[index]
      if (
        !Array.isArray(values) ||
        !values.length ||
        (!question.multiple && values.length !== 1) ||
        new Set(values).size !== values.length
      )
        throw new Error('Invalid form answer')
      const selected = values.map((value) => {
        if (!text(value, 8000)) throw new Error('Invalid form answer')
        if (field.type === 'boolean') {
          if (!['Yes', 'No'].includes(value)) throw new Error('Invalid form answer')
          return value === 'Yes'
        }
        const option = field.options?.find((option) => option.label === value)
        if (!option && !question.custom) throw new Error('Invalid form answer')
        return option ? option.value : value
      })
      return [field.key, question.multiple ? selected : selected[0]]
    }),
  )
}
