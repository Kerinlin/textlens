import type { ResultReadyAck, ResultSessionSnapshot } from '../../shared'
import {
  hydrateActionEventStore,
  type ResultHydrationOutcome
} from './actionEventStore'

export interface ResultSessionBootstrapDependencies {
  beginResultReady(sessionId: string): Promise<ResultSessionSnapshot | null>
  hydrate(snapshot: ResultSessionSnapshot): ResultHydrationOutcome
  ackResultReady(ack: ResultReadyAck): Promise<boolean>
  defer(callback: () => void): void
  reportError(error: unknown, operation: 'result-ready-recovery'): void
}

export interface ResultSessionBootstrap {
  readonly sessionId: string
  start(): Promise<ResultSessionSnapshot | null>
  retryStart(): Promise<ResultSessionSnapshot | null>
  recover(): Promise<ResultSessionSnapshot | null>
  reveal(run: () => Promise<void>): Promise<void>
}

interface HandshakeOutcome {
  snapshot: ResultSessionSnapshot | null
  recoveryNeeded: boolean
  ackAccepted: boolean
}

export function reportBootstrapError(error: unknown, operation: string): void {
  console.warn('[Flick][renderer]', {
    scope: 'result',
    operation,
    errorClass: error instanceof Error ? error.name || 'Error' : typeof error
  })
}

const browserDependencies: ResultSessionBootstrapDependencies = {
  beginResultReady: (sessionId) => window.textLens.beginResultReady(sessionId),
  hydrate: hydrateActionEventStore,
  ackResultReady: (ack) => window.textLens.ackResultReady(ack),
  defer: (callback) => queueMicrotask(callback),
  reportError: reportBootstrapError
}

export function createResultSessionBootstrap(
  sessionId: string,
  dependencies: ResultSessionBootstrapDependencies = browserDependencies
): ResultSessionBootstrap {
  let startupPromise: Promise<ResultSessionSnapshot | null> | null = null
  let startupFailure: unknown = null
  let recoveryPromise: Promise<ResultSessionSnapshot | null> | null = null
  let freshHandshakePromise: Promise<ResultSessionSnapshot | null> | null = null
  let postAckRecoveryScheduled = false
  let revealPromise: Promise<void> | null = null

  const handshake = async (): Promise<HandshakeOutcome> => {
    const snapshot = await dependencies.beginResultReady(sessionId)
    if (!snapshot) return { snapshot: null, recoveryNeeded: false, ackAccepted: true }

    const hydration = dependencies.hydrate(snapshot)
    const ackAccepted = await dependencies.ackResultReady(hydration.ack)
    return { snapshot, recoveryNeeded: hydration.recoveryNeeded, ackAccepted }
  }

  const schedulePostAckRecovery = (): void => {
    if (postAckRecoveryScheduled) return
    postAckRecoveryScheduled = true
    dependencies.defer(() => {
      postAckRecoveryScheduled = false
      // Queue behind completion handlers so a recovery can never reuse its
      // own settled Promise instead of starting a new handshake.
      void Promise.resolve()
        .then(() => recover())
        .catch((error: unknown) => dependencies.reportError(error, 'result-ready-recovery'))
    })
  }

  const handshakeUntilAccepted = (): Promise<ResultSessionSnapshot | null> => {
    if (freshHandshakePromise) return freshHandshakePromise

    let attemptPromise!: Promise<ResultSessionSnapshot | null>
    const run = async (): Promise<ResultSessionSnapshot | null> => {
      const outcome = await handshake()
      if (outcome.ackAccepted) {
        if (freshHandshakePromise === attemptPromise) freshHandshakePromise = null
        if (outcome.recoveryNeeded) schedulePostAckRecovery()
        return outcome.snapshot
      }

      await new Promise<void>((resolve) => dependencies.defer(resolve))
      return run()
    }

    attemptPromise = run()
    freshHandshakePromise = attemptPromise
    const clear = (): void => {
      if (freshHandshakePromise === attemptPromise) freshHandshakePromise = null
    }
    void attemptPromise.then(clear, clear)
    return attemptPromise
  }

  const start = (): Promise<ResultSessionSnapshot | null> => {
    if (startupPromise) return startupPromise
    if (startupFailure !== null) return Promise.reject(startupFailure)

    const attempt = handshakeUntilAccepted()
    startupPromise = attempt
    void attempt.then(
      () => undefined,
      (error: unknown) => {
        if (startupPromise === attempt) {
          startupPromise = null
          startupFailure = error
        }
      }
    )
    return attempt
  }

  const retryStart = (): Promise<ResultSessionSnapshot | null> => {
    if (startupPromise) return startupPromise
    startupFailure = null
    return start()
  }

  const recover = (): Promise<ResultSessionSnapshot | null> => {
    if (recoveryPromise) return recoveryPromise

    const attempt = handshakeUntilAccepted()
    recoveryPromise = attempt
    const clear = (): void => {
      if (recoveryPromise === attempt) recoveryPromise = null
    }
    void attempt.then(clear, clear)
    return attempt
  }

  return {
    sessionId,
    start,
    retryStart,
    recover,
    reveal(run: () => Promise<void>): Promise<void> {
      if (!revealPromise) revealPromise = run()
      return revealPromise
    }
  }
}
