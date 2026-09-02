#!/usr/bin/env node
/**
 * Fitness function das fronteiras arquiteturais.
 *
 * Roda dentro de `npm run lint`. Um import proibido quebra o lint — a regra de
 * dependencia nao e convencao, e verificacao (ADR-0001).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALLOWED, NO_NODE_BUILTINS, NO_VENDOR_NAMES, VENDOR_WORDS } from './boundaries.config.mjs'

const SCOPE = '@agentic/'
const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs'])
const SKIP_DIR = new Set(['node_modules', 'dist', 'coverage', '.git', '__fixtures__'])

/** Extrai especificadores de `import ... from 'x'`, `export ... from 'x'` e `import('x')`. */
export function extractSpecifiers(source) {
  const out = []
  const patterns = [
    /\bimport\s+[^'"();]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"();]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) {
    let m = re.exec(source)
    while (m !== null) {
      if (m[1]) out.push(m[1])
      m = re.exec(source)
    }
  }
  return out
}

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) yield* walk(full)
    else if (SOURCE_EXT.has(name.slice(name.lastIndexOf('.')))) yield full
  }
}

/** Remove comentarios e strings para a busca textual de nomes de fornecedor. */
function stripNoise(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/**
 * @param {string} rootDir raiz do repositorio (ou de uma fixture)
 * @returns {{package: string, file: string, rule: string, detail: string}[]}
 */
export function checkBoundaries(rootDir) {
  const violations = []
  for (const [pkg, allowed] of Object.entries(ALLOWED)) {
    const base = ['packages', 'apps', 'extensions']
      .map((d) => join(rootDir, d, pkg))
      .find((p) => {
        try {
          return statSync(p).isDirectory()
        } catch {
          return false
        }
      })
    if (!base) continue
    const allow = new Set(allowed)
    for (const file of walk(base)) {
      const rel = relative(rootDir, file).split(sep).join('/')
      const raw = readFileSync(file, 'utf8')
      for (const spec of extractSpecifiers(raw)) {
        if (spec.startsWith(SCOPE)) {
          const target = spec.slice(SCOPE.length).split('/')[0]
          if (target !== pkg && !allow.has(target)) {
            violations.push({
              package: pkg,
              file: rel,
              rule: 'forbidden-import',
              detail: `${pkg} nao pode importar @agentic/${target}`,
            })
          }
        } else if (spec.startsWith('node:') && NO_NODE_BUILTINS.includes(pkg)) {
          violations.push({
            package: pkg,
            file: rel,
            rule: 'no-node-builtins',
            detail: `${pkg} deve ser puro; import de ${spec} nao e permitido`,
          })
        } else if (spec.startsWith('../')) {
          const climbs = spec.match(/\.\.\//g)?.length ?? 0
          if (climbs >= 3 && spec.includes('packages/')) {
            violations.push({
              package: pkg,
              file: rel,
              rule: 'no-cross-package-relative',
              detail: `use @agentic/* em vez de caminho relativo: ${spec}`,
            })
          }
        }
      }
      if (NO_VENDOR_NAMES.includes(pkg)) {
        const text = stripNoise(raw).toLowerCase()
        for (const word of VENDOR_WORDS) {
          if (text.includes(word)) {
            violations.push({
              package: pkg,
              file: rel,
              rule: 'no-vendor-name',
              detail: `P18: "${word}" nao pode aparecer em ${pkg}`,
            })
          }
        }
      }
    }
  }
  return violations
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1].replace(/\\/g, '/')
if (isMain) {
  const root = process.argv[2] ?? process.cwd()
  const violations = checkBoundaries(root)
  if (violations.length === 0) {
    console.log('fronteiras: ok')
    process.exit(0)
  }
  console.error(`fronteiras: ${violations.length} violacao(oes)\n`)
  for (const v of violations) {
    console.error(`  ${v.file}\n    [${v.rule}] ${v.detail}`)
  }
  process.exit(1)
}
