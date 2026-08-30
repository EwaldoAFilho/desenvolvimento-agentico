import { EVENT_TYPES } from '@agentic/domain'
import { z } from 'zod'
import { NonNegativeIntSchema, TaskIdSchema } from '../common.js'
import { ActorDtoSchema, IsoDateTimeSchema } from './common.js'

export const EventTypeSchema = z.enum(EVENT_TYPES)

/**
 * `seq` e a chave do streaming: o cliente reconecta com `since=<ultimo seq>` e retoma sem
 * lacuna e sem duplicata (ARCHITECTURE 6.3). O payload varia por tipo e atravessa opaco.
 */
export const EventDtoSchema = z
  .object({
    seq: NonNegativeIntSchema,
    ts: IsoDateTimeSchema,
    type: EventTypeSchema,
    actor: ActorDtoSchema,
    taskId: TaskIdSchema.optional(),
    attemptId: z.string().optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()

export type EventDto = z.infer<typeof EventDtoSchema>
