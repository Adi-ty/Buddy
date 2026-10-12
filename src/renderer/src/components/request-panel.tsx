import { useEffect, useRef, useState } from 'react'
import type { AgentRequest, AgentResponse } from '@shared/contracts'
import { errorMessage } from '@shared/error-message'
import { Button } from './ui/button'
import { Notice } from './ui/notice'
import { Check, LoaderCircle, X } from 'lucide-react'

export function RequestPanel({
  request,
  overlay = false,
  sessionName,
}: {
  request: AgentRequest
  overlay?: boolean
  sessionName?: string
}) {
  const [answers, setAnswers] = useState<string[][]>(() => request.questions.map(() => []))
  const [custom, setCustom] = useState<Record<number, string>>({})
  const [writing, setWriting] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const activeInput = useRef(false)
  useEffect(() => {
    if (writing !== null && !overlay) input.current?.focus()
  }, [writing, overlay])
  useEffect(
    () => () => {
      if (activeInput.current) void window.buddy.setOverlayInput(false).catch(() => {})
    },
    [],
  )
  const send = async (response: AgentResponse) => {
    if (
      sending ||
      (request.submitting &&
        !('decision' in response && response.decision === 'native' && request.mirrored))
    )
      return
    setSending(true)
    setError(null)
    try {
      await window.buddy.respondToRequest(request.id, response)
      if (activeInput.current) {
        activeInput.current = false
        await window.buddy.setOverlayInput(false)
      }
    } catch (error) {
      setError(errorMessage(error, 'Couldn’t send. Try again.'))
    } finally {
      setSending(false)
    }
  }
  const busy = sending || request.submitting
  const finalAnswers = answers.map((value, i) => (custom[i]?.trim() ? [custom[i].trim()] : value))
  const beginWriting = async (i: number) => {
    setWriting(i)
    try {
      if (overlay) {
        await window.buddy.setOverlayInput(true)
        activeInput.current = true
      }
      input.current?.focus()
    } catch {
      setError('Text input is unavailable. Use your agent’s window.')
    }
  }
  return (
    <section
      className="request-panel"
      aria-label={request.kind === 'permission' ? 'Approval request' : 'Agent questions'}
    >
      <div className="request-context">
        {sessionName && (
          <p className="truncate text-[10px] text-muted-foreground" title={sessionName}>
            {sessionName}
          </p>
        )}
        <h3 className="mt-1 text-xs font-semibold text-attention">
          {request.kind === 'permission'
            ? `Allow ${request.tool ?? 'this tool'}?`
            : 'Your agent needs an answer'}
        </h3>
      </div>
      {request.kind === 'permission' ? (
        <pre className="request-details" tabIndex={0}>
          {request.details}
        </pre>
      ) : (
        request.questions.map((question, i) => (
          <fieldset key={i} disabled={busy} className="mt-3 space-y-2">
            <legend className="mb-2 text-xs font-medium leading-5">{question.text}</legend>
            {question.multiple && (
              <p className="text-[10px] text-muted-foreground">Choose one or more</p>
            )}
            {question.options.map((option) => (
              <label key={option.label} className="question-option">
                <input
                  type={question.multiple ? 'checkbox' : 'radio'}
                  name={`${request.id}-${i}`}
                  checked={!custom[i]?.trim() && answers[i]?.includes(option.label)}
                  onChange={() => {
                    setCustom((state) => ({ ...state, [i]: '' }))
                    setAnswers((state) =>
                      state.map((value, at) =>
                        at !== i
                          ? value
                          : question.multiple
                            ? value.includes(option.label)
                              ? value.filter((s) => s !== option.label)
                              : [...value, option.label]
                            : [option.label],
                      ),
                    )
                  }}
                />
                <span>
                  <span className="block font-medium">{option.label}</span>
                  {option.description && (
                    <span className="mt-0.5 block text-muted-foreground">{option.description}</span>
                  )}
                </span>
              </label>
            ))}
            {question.custom &&
              (writing === i ? (
                <textarea
                  ref={input}
                  aria-label={`Custom answer: ${question.header || question.text}`}
                  value={custom[i] ?? ''}
                  maxLength={4096}
                  rows={2}
                  className="question-input"
                  onPointerDown={() => {
                    if (overlay)
                      void window.buddy
                        .setOverlayInput(true)
                        .then(() => {
                          activeInput.current = true
                          input.current?.focus()
                        })
                        .catch(() =>
                          setError('Text input is unavailable. Use your agent’s window.'),
                        )
                  }}
                  onChange={(event) =>
                    setCustom((state) => ({ ...state, [i]: event.target.value }))
                  }
                />
              ) : (
                <Button variant="ghost" size="sm" onClick={() => void beginWriting(i)}>
                  Write your answer
                </Button>
              ))}
          </fieldset>
        ))
      )}
      <Notice
        className="mt-3"
        message={
          error || request.error
            ? {
                text: errorMessage(error ?? request.error, 'Couldn’t send. Try again.'),
                error: true,
              }
            : null
        }
      />
      <div className="mt-3 flex flex-wrap gap-2">
        {request.kind === 'permission' ? (
          <>
            {(!request.allowedDecisions || request.allowedDecisions.includes('allow')) && (
              <Button size="sm" disabled={busy} onClick={() => void send({ decision: 'allow' })}>
                <Check /> {request.allowLabel ?? 'Allow once'}
              </Button>
            )}
            {(!request.allowedDecisions || request.allowedDecisions.includes('reject')) && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void send({ decision: 'reject' })}
              >
                <X /> Deny
              </Button>
            )}
          </>
        ) : (
          <Button
            size="sm"
            disabled={busy || finalAnswers.some((a) => !a.length)}
            onClick={() => void send({ answers: finalAnswers })}
          >
            Send answers
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={sending || (request.submitting && !request.mirrored)}
          onClick={() => void send({ decision: 'native' })}
        >
          Use agent window
        </Button>
      </div>
      {busy && (
        <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <LoaderCircle size={12} className="animate-spin" /> Waiting for the agent…
        </p>
      )}
    </section>
  )
}
