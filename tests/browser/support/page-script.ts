import type { Page } from '@playwright/test'

/**
 * Codigo que roda DENTRO da pagina, num lugar so.
 *
 * O `tsconfig.typecheck.json` do repositorio cobre `tests/**` com as libs de Node e SEM
 * `lib: DOM` — mexer nisso e fora do escopo desta task. Entao o codigo de pagina entra
 * como TEXTO (`page.evaluate` aceita expressao em string) e o retorno e tipado aqui, em
 * vez de espalhar `declare const document` pelos specs. Cada funcao devolve um dado
 * simples; nenhuma esconde assercao.
 */

async function run<T>(page: Page, expression: string): Promise<T> {
  return page.evaluate<T>(expression)
}

export interface DocumentOverflow {
  readonly scrollWidth: number
  readonly clientWidth: number
}

export async function documentOverflow(page: Page): Promise<DocumentOverflow> {
  return run<DocumentOverflow>(
    page,
    '({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })',
  )
}

export interface FocusSignature {
  readonly tag: string
  /**
   * Endereco do elemento focado. Para um nó do DAG e o `data-testid` do CARD interno
   * (`task-node-T01`) — o mesmo endereco que o resto da suite usa —, porque o elemento
   * focavel do react-flow nao carrega testid proprio.
   */
  readonly id: string
  readonly text: string
  readonly outlineStyle: string
  readonly outlineWidth: string
}

/**
 * Quem esta focado e SE o foco aparece. O nó do DAG e um caso especial: o elemento focavel
 * e o container do react-flow, mas o contorno e desenhado no card interno
 * (`.react-flow__node:focus-visible .task-node`) — por isso o card entra na conta.
 */
const FOCUS_SIGNATURE = `(() => {
  const el = document.activeElement
  if (el === null || el === document.body) {
    return { tag: 'BODY', id: '', text: '', outlineStyle: 'none', outlineWidth: '0px' }
  }
  const own = getComputedStyle(el)
  const card = el.querySelector('.task-node')
  const painted = card !== null && getComputedStyle(card).outlineStyle !== 'none' ? getComputedStyle(card) : own
  const nome =
    (card !== null && card.getAttribute('data-testid')) ||
    el.getAttribute('data-testid') ||
    el.getAttribute('data-id') ||
    el.id ||
    ''
  return {
    tag: el.tagName,
    id: nome,
    text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    outlineStyle: painted.outlineStyle,
    outlineWidth: painted.outlineWidth,
  }
})()`

export async function focusSignature(page: Page): Promise<FocusSignature> {
  return run<FocusSignature>(page, FOCUS_SIGNATURE)
}

export interface StatusChange {
  readonly taskId: string
  readonly status: string
  readonly at: number
}

/**
 * Linha do tempo do DOM.
 *
 * O run inteiro dura poucos segundos e alguns estados (`READY`, `REVIEW`) vivem
 * milissegundos: sondar a tela de fora perderia justamente o instante que interessa. Um
 * `MutationObserver` instalado ANTES do primeiro script da pagina registra toda mudanca de
 * `data-status` no momento em que o React a aplica — e o que permite afirmar "o dependente
 * acendeu depois que a dependencia concluiu" sem recarregar nada.
 */
export const STATUS_TIMELINE_SCRIPT = `(() => {
  var PREFIX = 'task-node-'
  var entries = []
  window.__agenticTimeline = entries
  function record(el) {
    if (!el || typeof el.getAttribute !== 'function') return
    var testId = el.getAttribute('data-testid')
    if (typeof testId !== 'string' || testId.indexOf(PREFIX) !== 0) return
    var taskId = testId.slice(PREFIX.length)
    var status = el.getAttribute('data-status') || ''
    for (var i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i].taskId === taskId) {
        if (entries[i].status === status) return
        break
      }
    }
    entries.push({ taskId: taskId, status: status, at: Date.now() })
  }
  function scan(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return
    record(root)
    var found = root.querySelectorAll('[data-testid^="' + PREFIX + '"]')
    for (var i = 0; i < found.length; i += 1) record(found[i])
  }
  var observer = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i += 1) {
      var record_ = records[i]
      if (record_.type === 'attributes') record(record_.target)
      else for (var j = 0; j < record_.addedNodes.length; j += 1) scan(record_.addedNodes[j])
    }
  })
  function start() {
    scan(document.body)
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-status'],
    })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()`

/** Instala o observador para TODO documento seguinte — inclusive apos um reload. */
export async function installStatusTimeline(page: Page): Promise<void> {
  await page.addInitScript({ content: STATUS_TIMELINE_SCRIPT })
}

export async function statusTimeline(page: Page): Promise<readonly StatusChange[]> {
  return run<readonly StatusChange[]>(page, 'window.__agenticTimeline || []')
}

/** Estado de cada task como o DOM mostra AGORA. */
export async function taskStatuses(page: Page): Promise<Readonly<Record<string, string>>> {
  return run<Readonly<Record<string, string>>>(
    page,
    `(() => {
      var out = {}
      var nodes = document.querySelectorAll('[data-testid^="task-node-"]')
      for (var i = 0; i < nodes.length; i += 1) {
        out[nodes[i].getAttribute('data-testid').slice('task-node-'.length)] =
          nodes[i].getAttribute('data-status')
      }
      return out
    })()`,
  )
}

/**
 * Retangulos dos cards, em coordenadas de tela. Serve a UMA pergunta: dois nos se
 * sobrepoem? Sobreposicao e ilegibilidade — nao e questao de gosto.
 */
export interface NodeRect {
  readonly taskId: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export async function taskNodeRects(page: Page): Promise<readonly NodeRect[]> {
  return run<readonly NodeRect[]>(
    page,
    `(() => {
      var nodes = document.querySelectorAll('[data-testid^="task-node-"]')
      var out = []
      for (var i = 0; i < nodes.length; i += 1) {
        var box = nodes[i].getBoundingClientRect()
        out.push({
          taskId: nodes[i].getAttribute('data-testid').slice('task-node-'.length),
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
        })
      }
      return out
    })()`,
  )
}
