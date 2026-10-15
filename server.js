import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import express from 'express'
import { initSCSchema } from './src/db/scSchema.js'
import { createSCRouter } from './src/routes/scRoutes.js'
import { ingestGameData } from './src/services/scDataIngestor.js'

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 3001)
const HOST = process.env.HOST ?? '127.0.0.1'
const DB_PATH = process.env.SC_DB_PATH ?? path.join(rootDir, 'data', 'sc.db')
const DATA_DIR = process.env.SC_DATA_DIR

export async function createServer({ dbPath = DB_PATH, dataDir = DATA_DIR } = {}) {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true })

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  initSCSchema(db)

  if (dataDir) {
    const result = await ingestGameData(db, dataDir)
    console.log(`[sc] Ingested ${result.ships} ships and ${result.components} components from ${dataDir}`)
  }

  const app = express()
  app.disable('x-powered-by')
  app.use('/api/sc', createSCRouter(db))

  return { app, db }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app, db } = await createServer()
  const server = app.listen(PORT, HOST, () => {
    console.log(`[sc] API listening on http://${HOST}:${PORT}/api/sc`)
  })

  const shutdown = () => {
    server.close(() => {
      db.close()
      process.exit(0)
    })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
