const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function normalizeGameRoot(root) {
  const resolved = path.resolve(root)
  return ['LIVE', 'PTU'].includes(path.basename(resolved).toUpperCase()) ? path.dirname(resolved) : resolved
}

function getDefaultGameRoots() {
  const home = os.homedir()
  const roots = new Set()
  const add = (root) => { if (root) roots.add(path.resolve(root)) }

  if (process.platform === 'win32') {
    add(path.join(process.env.ProgramFiles || '', 'Roberts Space Industries', 'StarCitizen'))
    add(path.join(process.env['ProgramFiles(x86)'] || '', 'Roberts Space Industries', 'StarCitizen'))
    add(path.join(home, 'Games', 'Roberts Space Industries', 'StarCitizen'))
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const drive = `${letter}:\\`
      if (!fs.existsSync(drive)) continue
      add(path.join(drive, 'Program Files', 'Roberts Space Industries', 'StarCitizen'))
      add(path.join(drive, 'Program Files (x86)', 'Roberts Space Industries', 'StarCitizen'))
      add(path.join(drive, 'Roberts Space Industries', 'StarCitizen'))
      add(path.join(drive, 'Games', 'Roberts Space Industries', 'StarCitizen'))
      add(path.join(drive, 'Games', 'StarCitizen'))
    }
  } else {
    add(path.join(home, 'Games', 'Roberts Space Industries', 'StarCitizen'))
    add(path.join(home, '.local', 'share', 'Roberts Space Industries', 'StarCitizen'))
    add(path.join(home, '.wine', 'drive_c', 'Program Files', 'Roberts Space Industries', 'StarCitizen'))
    add(path.join(home, '.wine', 'drive_c', 'Games', 'Roberts Space Industries', 'StarCitizen'))
  }

  return [...roots]
}

function detectGameInstallations(customRoots = []) {
  const roots = new Set(getDefaultGameRoots())
  for (const root of customRoots.slice(0, 20)) {
    if (typeof root === 'string' && root.trim() && root.length < 1024) roots.add(normalizeGameRoot(root))
  }

  return [...roots].flatMap((root) => ['LIVE', 'PTU'].flatMap((channel) => {
    const installPath = path.join(root, channel)
    const dataFile = path.join(installPath, 'Data.p4k')
    const executable = path.join(installPath, 'Bin64', 'StarCitizen.exe')
    return fs.existsSync(dataFile) && fs.existsSync(executable) ? [{ channel, path: installPath }] : []
  }))
}

module.exports = { detectGameInstallations, normalizeGameRoot }