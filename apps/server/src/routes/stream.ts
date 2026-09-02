import type { DomainEvent } from '@agentic/domain'
import { toEventDto, toProviderHealthDto } from '@agentic/orchestrator'
import type { FastifyInstance } from 'fastify'
import type { ServerDeps } from '../deps.js'
import { parseRunId } from '../dto.js'
import { optionalInt } from '../query.js'
import { SseChannel } from '../sse.js'
import { loadRunOr404 } from './read.js'

interface RunParams {
  readonly id: string
}

/**
 * SSE do dashboard.
 *
 * `since` e EXCLUSIVO. O store entrega o backlog a partir dele e depois os novos, sempre em
 * ordem de `seq` — e por isso que reconectar com `since=<ultimo seq visto>` retoma sem
 * lacuna e sem duplicata (ARCHITECTURE 6.3, DASHBOARD 6). O servidor nao reordena, nao
 * filtra e nao deduplica: quem garante a ordem e a chave `seq` do event log.
 */
/**
 * Streams abertos por instancia, para o encerramento conseguir FECHAR.
 *
 * `app.close()` espera as conexoes ativas terminarem, e um stream sequestrado
 * (`reply.hijack()`) e uma conexao ativa que nunca termina sozinha. Medido: com um so
 * cliente do dashboard conectado, o servidor nao fechava. Um gancho `onClose` nao resolve —
 * o Fastify fecha o socket do servidor ANTES dos ganchos registrados na montagem (ordem
 * LIFO), entao quem encerra chama `closeStreams` explicitamente, antes de `app.close()`. O
 * cliente reconecta com `since` e nao perde nada (DASHBOARD 6).
 */
const STREAMS = new WeakMap<FastifyInstance, Set<() => void>>()

/** Encerra todo stream SSE aberto nesta instancia. Devolve quantos havia. */
export function closeStreams(app: FastifyInstance): number {
  const abertos = STREAMS.get(app)
  if (abertos === undefined) return 0
  const quantos = abertos.size
  for (const finish of [...abertos]) finish()
  return quantos
}

export function registerStreamRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const abertos = new Set<() => void>()
  STREAMS.set(app, abertos)

  app.get<{ Params: RunParams }>('/api/runs/:id/stream', async (request, reply) => {
    const id = parseRunId(request.params.id)
    await loadRunOr404(deps, id)
    const query = request.query as Record<string, unknown>
    const since = optionalInt(query.since, 'since') ?? 0

    // A partir daqui o socket e nosso: fastify nao serializa mais nada nesta resposta.
    reply.hijack()
    const channel = new SseChannel(reply.raw)
    channel.open()

    const iterator = deps.plane.persistence.events
      .subscribe(id, since)
      [Symbol.asyncIterator]() as AsyncIterator<DomainEvent>

    let heartbeat: ReturnType<typeof setInterval> | undefined
    let finished = false

    const finish = (): void => {
      if (finished) return
      finished = true
      abertos.delete(finish)
      if (heartbeat !== undefined) clearInterval(heartbeat)
      heartbeat = undefined
      // Encerra o iterador do store: cliente que sumiu nao deixa assinatura pendurada.
      void iterator.return?.(undefined)
      channel.close()
    }

    abertos.add(finish)
    request.raw.on('close', finish)
    request.raw.on('aborted', finish)
    request.raw.on('error', finish)
    reply.raw.on('close', finish)
    reply.raw.on('error', finish)

    const providers = async (): Promise<void> => {
      try {
        const health = await deps.plane.registry.health()
        channel.send('providers', health.map(toProviderHealthDto))
      } catch {
        // saude e informacao, nao contrato do stream: falha de sonda nao derruba a conexao
      }
    }

    heartbeat = setInterval(() => {
      if (channel.closed) {
        finish()
        return
      }
      channel.heartbeat()
      void providers()
    }, deps.heartbeatMs)
    heartbeat.unref?.()

    const pump = async (): Promise<void> => {
      for (;;) {
        const next = await iterator.next()
        if (next.done === true || finished || channel.closed) return
        if (!channel.send('event', toEventDto(next.value), next.value.seq)) return
      }
    }

    void pump()
      .catch(() => undefined)
      .then(finish)
  })
}
