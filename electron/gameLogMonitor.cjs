const fs = require('node:fs')
const { createGameLogParserState, parseGameLogLines } = require('./gameLogParser.cjs')

function startGameLogMonitor(logPath, channel, onEvent, onStatus = () => {}) {
  let offset = 0
  let fileIdentity = ''
  let parserState = createGameLogParserState(channel)
  let stopped = false

  function readAvailable() {
    if (stopped) return
    let stat
    try {
      stat = fs.statSync(logPath)
    } catch {
      onStatus('waiting')
      return
    }

    const nextIdentity = `${stat.dev}:${stat.ino}`
    if (nextIdentity !== fileIdentity || stat.size < offset) {
      fileIdentity = nextIdentity
      offset = 0
      parserState = createGameLogParserState(channel)
    }

    if (stat.size <= offset) {
      onStatus('watching')
      return
    }

    const descriptor = fs.openSync(logPath, 'r')
    try {
      const bytes = Buffer.alloc(stat.size - offset)
      const bytesRead = fs.readSync(descriptor, bytes, 0, bytes.length, offset)
      const chunk = bytes.subarray(0, bytesRead)
      const lastNewline = chunk.lastIndexOf(0x0a)
      if (lastNewline < 0) return

      const completeText = chunk.subarray(0, lastNewline + 1).toString('utf8')
      offset += lastNewline + 1
      const events = parseGameLogLines(completeText.split(/\r?\n/), parserState)
      for (const event of events) onEvent(event)
      onStatus('watching')
    } finally {
      fs.closeSync(descriptor)
    }
  }

  const listener = () => readAvailable()
  fs.watchFile(logPath, { interval: 1000, persistent: false }, listener)
  readAvailable()

  return {
    logPath,
    stop() {
      stopped = true
      fs.unwatchFile(logPath, listener)
    },
  }
}

module.exports = { startGameLogMonitor }
