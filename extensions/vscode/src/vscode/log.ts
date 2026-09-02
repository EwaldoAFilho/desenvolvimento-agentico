import * as vscode from 'vscode'

/** Um canal de saida, o mesmo para a extensao e para as linhas do `agentic serve`. */
export class AgenticLog implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('Agentic', { log: true })

  info(line: string): void {
    this.channel.info(line)
  }

  warn(line: string): void {
    this.channel.warn(line)
  }

  error(line: string): void {
    this.channel.error(line)
  }

  /** Linha vinda do processo filho, sem reformatar. */
  child(line: string): void {
    this.channel.appendLine(`[serve] ${line}`)
  }

  show(): void {
    this.channel.show(true)
  }

  dispose(): void {
    this.channel.dispose()
  }
}
