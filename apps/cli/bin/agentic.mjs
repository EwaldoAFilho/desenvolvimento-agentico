#!/usr/bin/env node
// Entrada executavel. Camada fina de verdade: resolve o modulo compilado e devolve o
// codigo de saida. Toda a decisao vive em src/.
import process from 'node:process'

const { main } = await import('../dist/index.js')

process.exitCode = await main(process.argv)
