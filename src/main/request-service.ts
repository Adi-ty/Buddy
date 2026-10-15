import type { AgentRequest, AgentResponse } from '../shared/contracts'
import { validateResponse } from './tracking/request-response'

export type RequestOutcome = 'confirmed' | 'expired' | 'unavailable'
export type ResponseOrigin = 'buddy' | 'telegram'
export interface RequestResolution {
  id: string
  outcome: RequestOutcome
  origin?: ResponseOrigin
}

// One main-process operation for every interface. Adapters remain responsible
// for checking live connection ownership immediately before dispatch.
export class RequestService {
  private readonly attempts = new Map<string, ResponseOrigin>()
  private readonly listeners = new Set<(resolution: RequestResolution) => void>()
  constructor(
    private readonly live: () => AgentRequest[],
    private readonly available: () => boolean,
    private readonly dispatch: (id: string, response: AgentResponse) => Promise<void>,
  ) {}
  snapshot(): AgentRequest[] {
    return this.available() ? this.live() : []
  }
  subscribe(listener: (resolution: RequestResolution) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  resolve(id: string, outcome: RequestOutcome | 'rejected'): void {
    const origin = this.attempts.get(id)
    this.attempts.delete(id)
    if (outcome === 'rejected') return
    for (const listener of this.listeners) listener({ id, outcome, origin })
  }
  reconcile(): void {
    const live = new Set(this.snapshot().map((request) => request.id))
    for (const id of this.attempts.keys()) if (!live.has(id)) this.resolve(id, 'unavailable')
  }
  async respond(id: unknown, value: unknown, origin: ResponseOrigin): Promise<void> {
    const request = this.snapshot().find((item) => item.id === id)
    if (!request || Date.now() >= request.expiresAt)
      throw new Error('This request is no longer pending.')
    const response = validateResponse(request, value)
    if ('decision' in response && response.decision === 'native') {
      await this.dispatch(request.id, response)
      return
    }
    if (request.submitting || this.attempts.has(request.id))
      throw new Error('A response is already being sent. Check the agent before continuing.')
    this.attempts.set(request.id, origin)
    try {
      await this.dispatch(request.id, response)
    } catch (error) {
      // Adapters may throw only before dispatch. An uncertain mutation stays
      // submitting until the native request retires; never retry it here.
      this.attempts.delete(request.id)
      throw error
    }
  }
}
