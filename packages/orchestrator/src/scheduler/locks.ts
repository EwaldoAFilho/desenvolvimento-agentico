import { type PathScope, pathScopeSetsConflict, type TaskId } from '@agentic/domain'
import type { ActiveLock } from './types.js'

/**
 * Escopos ja tomados: os locks das tentativas em voo mais os reservados pelas decisoes
 * desta mesma leva. Duas decisoes simultaneas colidirem seria I2 violada no despacho —
 * o par precisa ser recusado aqui, nao no orquestrador.
 *
 * A regra de sobreposicao e a do dominio (`pathScopesConflict`, via conjunto). Nao ha
 * comparacao de prefixo reimplementada aqui.
 */
export class ScopeLedger {
  private readonly held: ActiveLock[]

  constructor(locks: readonly ActiveLock[]) {
    this.held = locks.map((lock) => ({ taskId: lock.taskId, paths: [...lock.paths] }))
  }

  /** Lock da propria task e ignorado: e a tentativa anterior dela, nao um concorrente. */
  conflicts(task: TaskId, touches: readonly PathScope[]): boolean {
    return this.held.some(
      (lock) => lock.taskId !== task && pathScopeSetsConflict(lock.paths, touches),
    )
  }

  reserve(task: TaskId, touches: readonly PathScope[]): void {
    this.held.push({ taskId: task, paths: [...touches] })
  }
}
