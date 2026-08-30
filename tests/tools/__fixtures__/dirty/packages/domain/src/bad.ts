import { openDatabase } from '@agentic/persistence'
import { readFileSync } from 'node:fs'
export const illegal = [openDatabase, readFileSync]
