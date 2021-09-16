'use strict'

const expandPath = require('@antora/expand-path-helper')
const { promises: fsp } = require('fs')
const ospath = require('path')
const posixify = ospath.sep === '\\' ? (p) => p.replace(/\\/g, '/') : undefined
const publishStream = require('./common/publish-stream')
const { dest: vfsDest } = require('vinyl-fs')

const { DEFAULT_DEST_FS } = require('../constants.js')

function publishToFs (config, files, playbook) {
  const destDir = config.path || DEFAULT_DEST_FS
  const absDestDir = expandPath(destDir, { dot: playbook.dir })
  const report = {
    provider: 'fs',
    path: destDir,
    resolvedPath: absDestDir,
    fileUri: 'file://' + (posixify ? '/' + posixify(absDestDir) : absDestDir),
  }
  return config.clean
    ? rmdir(absDestDir)
      .then(() => publishStream(vfsDest(absDestDir), files))
      .then(() => report)
    : publishStream(vfsDest(absDestDir), files).then(() => report)
}

/**
 * Removes the specified directory (including all of its contents) or file.
 * Equivalent to fs.promises.rmdir(dir, { recursive: true }) in Node 12.
 */
function rmdir (dir) {
  return fsp
    .readdir(dir, { withFileTypes: true })
    .then((lst) =>
      Promise.all(
        lst.map((it) =>
          it.isDirectory()
            ? rmdir(ospath.join(dir, it.name))
            : fsp.unlink(ospath.join(dir, it.name)).catch((unlinkErr) => {
              if (unlinkErr.code !== 'ENOENT') throw unlinkErr
            })
        )
      )
    )
    .then(() => fsp.rmdir(dir))
    .catch((err) => {
      if (err.code === 'ENOENT') return
      if (err.code === 'ENOTDIR') {
        return fsp.unlink(dir).catch((unlinkErr) => {
          if (unlinkErr.code !== 'ENOENT') throw unlinkErr
        })
      }
      throw err
    })
}

module.exports = publishToFs
