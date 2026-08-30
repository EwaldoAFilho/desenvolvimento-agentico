import type { DiagnosticSeverity } from '@agentic/domain'
import { DIAGNOSTIC_CODES, type DiagnosticCode } from './types.js'

export interface CatalogEntry {
  readonly severity: DiagnosticSeverity
  /** Nome curto da verificacao, como na tabela de ARCHITECTURE 7.1. */
  readonly title: string
  /** O que o humano faz a respeito. O compilador explica; quem corrige e a pessoa (P15). */
  readonly hint: string
}

/**
 * Copia executavel da tabela de ARCHITECTURE 7.1. A severidade mora aqui e em nenhum
 * outro lugar: quem emite um diagnostico nao escolhe a gravidade dele.
 */
export const DIAGNOSTIC_CATALOG: Readonly<Record<DiagnosticCode, CatalogEntry>> = {
  DA1000: {
    severity: 'ERROR',
    title: 'YAML invalido',
    hint: 'corrija a sintaxe do arquivo na linha indicada',
  },
  DA1001: {
    severity: 'ERROR',
    title: 'falha de schema',
    hint: 'confira o campo citado em docs/architecture/MISSION-FORMAT.md',
  },
  DA1002: {
    severity: 'ERROR',
    title: 'TaskId duplicado',
    hint: 'cada task precisa de um id unico na missao',
  },
  DA1003: {
    severity: 'ERROR',
    title: 'dependencia inexistente',
    hint: 'declare a task citada ou remova a dependencia',
  },
  DA1004: {
    severity: 'ERROR',
    title: 'auto-dependencia',
    hint: 'uma task nao pode esperar por si mesma',
  },
  DA1005: {
    severity: 'ERROR',
    title: 'ciclo',
    hint: 'quebre o ciclo removendo uma das dependencias listadas',
  },
  DA1006: {
    severity: 'ERROR',
    title: 'phase nao declarada',
    hint: 'declare a fase em `phases` ou aponte a task para uma fase existente',
  },
  DA1007: {
    severity: 'ERROR',
    title: 'gate inexistente',
    hint: 'declare o perfil em gates.yaml ou use um perfil existente',
  },
  DA1008: {
    severity: 'ERROR',
    title: 'touches invalido',
    hint: 'declare o escopo de escrita dentro do repositorio e fora de denyPaths',
  },
  DA1009: {
    severity: 'ERROR',
    title: 'objective vazio',
    hint: 'descreva o resultado verificavel da task',
  },
  DA1010: {
    severity: 'ERROR',
    title: 'paralelismo com workspace shared',
    hint: 'use workspace git-worktree ou reduza maxParallelTasks para 1',
  },
  DA1011: {
    severity: 'ERROR',
    title: 'perfil de agente inexistente',
    hint: 'declare o perfil no registry de providers do projeto',
  },
  DA2001: {
    severity: 'WARNING',
    title: 'conflito de touches entre concorrentes',
    hint: 'separe os escopos ou declare dependencia entre as duas tasks',
  },
  DA2002: {
    severity: 'WARNING',
    title: 'conclusao nao verificavel',
    hint: 'declare `validation` ou um `gate` para a task',
  },
  DA2003: {
    severity: 'WARNING',
    title: 'task grande demais',
    hint: 'considere dividir — a decisao de granularidade e humana (P15)',
  },
  DA2004: {
    severity: 'WARNING',
    title: 'fragmentacao excessiva',
    hint: 'considere unir a cadeia — a decisao de granularidade e humana (P15)',
  },
  DA2005: {
    severity: 'WARNING',
    title: 'touches amplo demais',
    hint: 'aponte para o subdiretorio realmente alterado',
  },
  DA2006: {
    severity: 'WARNING',
    title: 'trabalho orfao',
    hint: 'ligue a task ao restante do plano ou cubra-a pelo mission gate',
  },
  DA2007: {
    severity: 'WARNING',
    title: 'risco alto sem revisao',
    hint: 'mantenha requireReview em task de risco alto',
  },
  DA2008: {
    severity: 'WARNING',
    title: 'revisao cruzada sem segundo fornecedor',
    hint: 'declare um segundo provider apto a revisar no registry',
  },
  DA3001: {
    severity: 'INFO',
    title: 'fase posterior sem dependencia anterior',
    hint: 'fase nao cria dependencia: confirme se a ordem pretendida esta declarada',
  },
  DA3002: {
    severity: 'INFO',
    title: 'sem paralelismo real',
    hint: 'o plano e uma cadeia linear: nenhum executor extra reduz o tempo',
  },
}

export function severityOf(code: DiagnosticCode): DiagnosticSeverity {
  return DIAGNOSTIC_CATALOG[code].severity
}

export function hintOf(code: DiagnosticCode): string {
  return DIAGNOSTIC_CATALOG[code].hint
}

export function isDiagnosticCode(value: string): value is DiagnosticCode {
  return (DIAGNOSTIC_CODES as readonly string[]).includes(value)
}
