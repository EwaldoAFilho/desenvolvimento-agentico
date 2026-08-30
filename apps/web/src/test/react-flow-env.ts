/**
 * O jsdom nao mede layout; o `@xyflow/react` precisa de `ResizeObserver`, `DOMMatrixReadOnly`
 * e de dimensoes nao nulas para montar o viewport. Este modulo instala o minimo para que os
 * nos existam no DOM e possam ser consultados por texto e `aria-label`.
 */

type ResizeEntryLike = {
  readonly target: Element
  readonly contentRect: { readonly width: number; readonly height: number }
}

class FakeResizeObserver {
  private readonly callback: (entries: ResizeEntryLike[], observer: FakeResizeObserver) => void

  constructor(callback: (entries: ResizeEntryLike[], observer: FakeResizeObserver) => void) {
    this.callback = callback
  }

  observe(target: Element): void {
    this.callback([{ target, contentRect: { width: RECT.width, height: RECT.height } }], this)
  }

  unobserve(): void {}

  disconnect(): void {}
}

class FakeDOMMatrixReadOnly {
  readonly m22: number

  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([\d.]+)\)/)?.[1]
    this.m22 = scale === undefined ? 1 : Number(scale)
  }
}

const RECT = { x: 0, y: 0, top: 0, left: 0, bottom: 900, right: 1600, width: 1600, height: 900 }

let installed = false

export function installReactFlowEnv(): void {
  if (installed) return
  installed = true

  const scope = globalThis as unknown as Record<string, unknown>
  scope.ResizeObserver = FakeResizeObserver
  scope.DOMMatrixReadOnly = FakeDOMMatrixReadOnly

  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: {
      get(this: HTMLElement) {
        return Number.parseFloat(this.style.height) || 900
      },
    },
    offsetWidth: {
      get(this: HTMLElement) {
        return Number.parseFloat(this.style.width) || 1600
      },
    },
  })

  Element.prototype.getBoundingClientRect = function boundingRect(): DOMRect {
    return { ...RECT, toJSON: () => RECT } as DOMRect
  }

  const svg = SVGElement.prototype as unknown as { getBBox?: () => unknown }
  svg.getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 })
}
