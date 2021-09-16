'use strict'

const camelCaseKeys = require('camelcase-keys')
const { createHash } = require('crypto')
const createHttpPlugin = require('./git-plugin-http')
const decodeUint8Array = require('./decode-uint8-array')
const EventEmitter = require('events')
const expandPath = require('@antora/expand-path-helper')
const File = require('./file')
const flattenDeep = require('./flatten-deep')
const fs = require('fs')
const { promises: fsp } = fs
const getCacheDir = require('cache-directory')
const GitCredentialManagerStore = require('./git-credential-manager-store')
const git = require('./git')
const { NotFoundError, ObjectTypeError, UnknownTransportError, UrlParseError } = git.Errors
const invariably = { false: () => false, void: () => undefined, emptyArray: () => [] }
const { makeRe: makePicomatchRx } = require('picomatch')
const matcher = require('matcher')
const MultiProgress = require('multi-progress')
const ospath = require('path')
const { posix: path } = ospath
const posixify = ospath.sep === '\\' ? (p) => p.replace(/\\/g, '/') : undefined
const { fs: resolvePathGlobsFs, git: resolvePathGlobsGit } = require('./resolve-path-globs')
const { Transform } = require('stream')
const map = (transform, flush = undefined) => new Transform({ objectMode: true, transform, flush })
const userRequire = require('@antora/user-require-helper')
const vfs = require('vinyl-fs')
const yaml = require('js-yaml')

const {
  COMPONENT_DESC_FILENAME,
  CONTENT_CACHE_FOLDER,
  CONTENT_SRC_GLOB,
  CONTENT_SRC_OPTS,
  FILE_MODES,
  GIT_CORE,
  GIT_OPERATION_LABEL_LENGTH,
  GIT_PROGRESS_PHASES,
  PICOMATCH_VERSION_OPTS,
  SYMLINK_FILE_MODE,
  VALID_STATE_FILENAME,
} = require('./constants')

const ANY_SEPARATOR_RX = /[:/]/
const CSV_RX = /\s*,\s*/
const VENTILATED_CSV_RX = /\s*,\s+/
const EDIT_URL_TEMPLATE_VAR_RX = /\{(web_url|ref(?:hash|name)|path)\}/g
const GIT_SUFFIX_RX = /(?:(?:(?:\.git)?\/)?\.git|\/)$/
const GIT_URI_DETECTOR_RX = /:(?:\/\/|[^/\\])/
const HEADS_DIR_RX = /^heads\//
const HOSTED_GIT_REPO_RX = /^(?:https?:\/\/|.+@)(git(?:hub|lab)\.com|bitbucket\.org|pagure\.io)[/:](.+?)(?:\.git)?$/
const HTTP_ERROR_CODE_RX = new RegExp('^' + git.Errors.HttpError.code + '$', 'i')
const PATH_SEPARATOR_RX = /[/]/g
const SHORTEN_REF_RX = /^refs\/(?:heads|remotes\/[^/]+|tags)\//
const SPACE_RX = / /g
const SUPERFLUOUS_SEPARATORS_RX = /^\/+|\/+$|\/+(?=\/)/g
const URL_AUTH_CLEANER_RX = /^(https?:\/\/)[^/@]*@/
const URL_AUTH_EXTRACTOR_RX = /^(https?:\/\/)(?:([^/:@]+)?(?::([^/@]+)?)?@)?(.*)/
const URL_PORT_CLEANER_RX = /^([^/]+):[0-9]+(?=\/)/

/**
 * Aggregates files from the specified content sources so they can be loaded
 * into Antora's virtual file catalog.
 *
 * Currently assumes each source points to a local or remote git repository.
 * Clones the repository, if necessary, then walks the git tree (or worktree) of
 * the specified branches and tags, starting from the specified start path(s).
 * Creates a virtual file containing the contents and location metadata for each
 * file matched. The files are then roughly organized by component version.
 *
 * @memberof content-aggregator
 *
 * @param {Object} playbook - The configuration object for Antora.
 * @param {Object} playbook.dir - The working directory of the playbook.
 * @param {Object} playbook.runtime - The runtime configuration object for Antora.
 * @param {String} [playbook.runtime.cacheDir=undefined] - The base cache directory.
 * @param {Boolean} [playbook.runtime.fetch=undefined] - Whether to fetch
 * updates from managed git repositories.
 * @param {Boolean} [playbook.runtime.quiet=false] - Whether to be suppress progress
 * bars that show progress of clone and fetch operations.
 * @param {Array} playbook.git - The git configuration object for Antora.
 * @param {Boolean} [playbook.git.ensureGitSuffix=true] - Whether the .git
 * suffix is automatically appended to each repository URL, if missing.
 * @param {Array} playbook.content - An array of content sources.
 *
 * @returns {Promise<Object>} A map of files organized by component version.
 */
function aggregateContent (playbook) {
  const startDir = playbook.dir || '.'
  const { branches, editUrl, tags, sources } = playbook.content
  const { cacheDir, fetch, quiet } = playbook.runtime
  return ensureCacheDir(cacheDir, startDir).then((resolvedCacheDir) => {
    const gitPlugins = loadGitPlugins(
      Object.assign({ ensureGitSuffix: true }, playbook.git),
      playbook.network || {},
      startDir
    )
    const sourcesByUrl = sources.reduce(
      (accum, source) => accum.set(source.url, [...(accum.get(source.url) || []), source]),
      new Map()
    )
    const progress = !quiet && createProgress(sourcesByUrl.keys(), process.stdout)
    return Promise.all(
      [...sourcesByUrl.entries()].map(([url, sources]) =>
        loadRepository(url, {
          cacheDir: resolvedCacheDir,
          gitPlugins,
          fetchTags: tagsSpecified(sources, tags),
          progress,
          fetch,
          startDir,
        }).then(({ repo, authStatus }) =>
          Promise.all(
            sources.map((source) => {
              source = Object.assign({ branches, editUrl, tags }, source)
              // NOTE if repository is managed (has a url property), we can assume the remote name is origin
              // TODO if the repo has no remotes, then remoteName should be undefined
              const remoteName = repo.url ? 'origin' : source.remote || 'origin'
              return collectFilesFromSource(source, repo, remoteName, authStatus)
            })
          )
        )
      )
    )
      .then(buildAggregate)
      .catch((err) => {
        progress && progress.terminate()
        throw err
      })
  })
}

function buildAggregate (componentVersionBuckets) {
  return [
    ...flattenDeep(componentVersionBuckets)
      .reduce((accum, batch) => {
        const key = batch.version + '@' + batch.name
        const entry = accum.get(key)
        if (!entry) return accum.set(key, batch)
        const files = batch.files
        ;(batch.files = entry.files).push(...files)
        Object.assign(entry, batch)
        return accum
      }, new Map())
      .values(),
  ]
}

async function loadRepository (url, opts) {
  let dir
  let repo
  let authStatus
  if (~url.indexOf(':') && GIT_URI_DETECTOR_RX.test(url)) {
    let displayUrl
    let credentials
    ;({ displayUrl, url, credentials } = extractCredentials(url))
    const { cacheDir, fetch, fetchTags, gitPlugins, progress } = opts
    dir = ospath.join(cacheDir, generateCloneFolderName(displayUrl))
    // NOTE the presence of the url property on the repo object implies the repository is remote
    repo = { cache: {}, dir, fs, gitdir: dir, noCheckout: true, url }
    const validStateFile = ospath.join(dir, VALID_STATE_FILENAME)
    try {
      await fsp.access(validStateFile)
      if (fetch) {
        await fsp.unlink(validStateFile)
        const fetchOpts = buildFetchOptions(repo, progress, displayUrl, credentials, gitPlugins, fetchTags, 'fetch')
        await git
          .fetch(fetchOpts)
          .then(() => {
            const credentialManager = gitPlugins.credentialManager
            authStatus = credentials ? 'auth-embedded' : credentialManager.status({ url }) ? 'auth-required' : undefined
            return git.setConfig(Object.assign({ path: 'remote.origin.private', value: authStatus }, repo))
          })
          .catch((fetchErr) => {
            if (fetchOpts.onProgress) fetchOpts.onProgress.finish(fetchErr)
            if (HTTP_ERROR_CODE_RX.test(fetchErr.code) && fetchErr.data.statusCode === 401) fetchErr.rethrow = true
            throw fetchErr
          })
          .then(() => fsp.writeFile(validStateFile, '').catch(invariably.void))
          .then(() => fetchOpts.onProgress && fetchOpts.onProgress.finish())
      } else {
        authStatus = await git.getConfig(Object.assign({ path: 'remote.origin.private' }, repo))
      }
    } catch (gitErr) {
      await rmdir(dir)
      if (gitErr.rethrow) throw transformGitCloneError(gitErr, displayUrl)
      const fetchOpts = buildFetchOptions(repo, progress, displayUrl, credentials, gitPlugins, fetchTags, 'clone')
      await git
        .clone(fetchOpts)
        .then(() => git.resolveRef(Object.assign({ ref: 'HEAD', depth: 1 }, repo)))
        .then(() => {
          const credentialManager = gitPlugins.credentialManager
          authStatus = credentials ? 'auth-embedded' : credentialManager.status({ url }) ? 'auth-required' : undefined
          return git.setConfig(Object.assign({ path: 'remote.origin.private', value: authStatus }, repo))
        })
        .catch(async (cloneErr) => {
          // FIXME triggering the error handler here causes assertion problems in the test suite
          //if (fetchOpts.onProgress) fetchOpts.onProgress.finish(cloneErr)
          throw transformGitCloneError(cloneErr, displayUrl)
        })
        .then(() => fsp.writeFile(validStateFile, '').catch(invariably.void))
        .then(() => fetchOpts.onProgress && fetchOpts.onProgress.finish())
    }
  } else if (await isDirectory((dir = expandPath(url, { dot: opts.startDir })))) {
    const gitdir = ospath.join(dir, '.git')
    repo = (await isDirectory(gitdir))
      ? { cache: {}, dir, fs, gitdir }
      : { cache: {}, dir, fs, gitdir: dir, noCheckout: true }
    try {
      await git.resolveRef(Object.assign({ ref: 'HEAD', depth: 1 }, repo))
    } catch {
      throw new Error(
        `Local content source must be a git repository: ${dir}${url !== dir ? ' (url: ' + url + ')' : ''}`
      )
    }
  } else {
    throw new Error(`Local content source does not exist: ${dir}${url !== dir ? ' (url: ' + url + ')' : ''}`)
  }
  return { repo, authStatus }
}

function extractCredentials (url) {
  if ((url.startsWith('https://') || url.startsWith('http://')) && ~url.indexOf('@')) {
    // Common oauth2 formats: (QUESTION should we try to coerce token only into one of these formats?)
    // GitHub: <token>:x-oauth-basic@ (or <token>@)
    // GitHub App: x-access-token:<token>@
    // GitLab: oauth2:<token>@
    // BitBucket: x-token-auth:<token>@
    const [, scheme, username, password, rest] = url.match(URL_AUTH_EXTRACTOR_RX)
    const displayUrl = (url = scheme + rest)
    // NOTE if only username is present, assume it's an oauth token and set password to empty string
    const credentials = username ? { username, password: password || '' } : {}
    return { displayUrl, url, credentials }
  } else if (url.startsWith('git@')) {
    return { displayUrl: url, url: 'https://' + url.substr(4).replace(':', '/') }
  } else {
    return { displayUrl: url, url }
  }
}

async function collectFilesFromSource (source, repo, remoteName, authStatus) {
  const originUrl = repo.url || (await resolveRemoteUrl(repo, remoteName))
  return selectReferences(source, repo, remoteName).then((refs) =>
    Promise.all(refs.map((ref) => collectFilesFromReference(source, repo, remoteName, authStatus, ref, originUrl)))
  )
}

// QUESTION should we resolve HEAD to a ref eagerly to avoid having to do a match on it?
async function selectReferences (source, repo, remote) {
  let { branches: branchPatterns, tags: tagPatterns, worktrees: worktreePatterns = '.' } = source
  const isBare = repo.noCheckout
  const noWorktree = repo.url ? undefined : null
  const refs = new Map()
  if (tagPatterns) {
    tagPatterns = Array.isArray(tagPatterns)
      ? tagPatterns.map((pattern) => String(pattern))
      : String(tagPatterns).split(CSV_RX)
    if (tagPatterns.length) {
      const tags = await git.listTags(repo)
      for (const shortname of tags.length ? matcher(tags, tagPatterns) : tags) {
        // NOTE tags are stored using symbol keys to distinguish them from branches
        refs.set(Symbol(shortname), { shortname, fullname: 'tags/' + shortname, type: 'tag', head: noWorktree })
      }
    }
  }
  if (branchPatterns) {
    if (worktreePatterns) {
      if (worktreePatterns === '.') {
        worktreePatterns = ['.']
      } else if (worktreePatterns === true) {
        worktreePatterns = ['.', '*']
      } else {
        worktreePatterns = Array.isArray(worktreePatterns)
          ? worktreePatterns.map((pattern) => String(pattern))
          : String(worktreePatterns).split(CSV_RX)
      }
    }
    const branchPatternsString = String(branchPatterns)
    if (branchPatternsString === 'HEAD' || branchPatternsString === '.') {
      const currentBranch = await getCurrentBranchName(repo, remote)
      if (currentBranch) {
        branchPatterns = [currentBranch]
      } else {
        if (!isBare) {
          // NOTE current branch is undefined when HEAD is detached
          const head = worktreePatterns[0] === '.' ? repo.dir : noWorktree
          refs.set('HEAD', { shortname: 'HEAD', fullname: 'HEAD', type: 'branch', detached: true, head })
        }
        return [...refs.values()]
      }
    } else if (
      (branchPatterns = Array.isArray(branchPatterns)
        ? branchPatterns.map((pattern) => String(pattern))
        : branchPatternsString.split(CSV_RX)).length
    ) {
      let headBranchIdx
      // NOTE we can assume at least two entries if HEAD or . are present
      if (~(headBranchIdx = branchPatterns.indexOf('HEAD')) || ~(headBranchIdx = branchPatterns.indexOf('.'))) {
        const currentBranch = await getCurrentBranchName(repo, remote)
        if (currentBranch) {
          // NOTE ignore if current branch is already in list
          if (~branchPatterns.indexOf(currentBranch)) {
            branchPatterns.splice(headBranchIdx, 1)
          } else {
            branchPatterns[headBranchIdx] = currentBranch
          }
        } else {
          if (!isBare) {
            let head = noWorktree
            if (worktreePatterns[0] === '.') {
              worktreePatterns = worktreePatterns.slice(1)
              head = repo.dir
            }
            // NOTE current branch is undefined when HEAD is detached
            refs.set('HEAD', { shortname: 'HEAD', fullname: 'HEAD', type: 'branch', detached: true, head })
          }
          branchPatterns.splice(headBranchIdx, 1)
        }
      }
    } else {
      return [...refs.values()]
    }
    // NOTE isomorphic-git includes HEAD in list of remote branches (see https://isomorphic-git.org/docs/listBranches)
    const remoteBranches = (await git.listBranches(Object.assign({ remote }, repo))).filter((it) => it !== 'HEAD')
    if (remoteBranches.length) {
      for (const shortname of matcher(remoteBranches, branchPatterns)) {
        const fullname = 'remotes/' + remote + '/' + shortname
        refs.set(shortname, { shortname, fullname, type: 'branch', remote, head: noWorktree })
      }
    }
    // NOTE only consider local branches if repo has a worktree or there are no remote tracking branches
    if (!isBare) {
      const localBranches = await git.listBranches(repo)
      if (localBranches.length) {
        const worktrees = await findWorktrees(repo, worktreePatterns)
        for (const shortname of matcher(localBranches, branchPatterns)) {
          const head = worktrees.get(shortname) || noWorktree
          refs.set(shortname, { shortname, fullname: 'heads/' + shortname, type: 'branch', head })
        }
      }
    } else if (!remoteBranches.length) {
      // QUESTION should local branches be used if the only remote branch is HEAD?
      const localBranches = await git.listBranches(repo)
      for (const shortname of localBranches.length ? matcher(localBranches, branchPatterns) : localBranches) {
        refs.set(shortname, { shortname, fullname: 'heads/' + shortname, type: 'branch', head: noWorktree })
      }
    }
  }
  return [...refs.values()]
}

/**
 * Returns the current branch name unless the HEAD is detached.
 */
function getCurrentBranchName (repo, remote) {
  let refPromise
  if (repo.noCheckout) {
    refPromise = git
      .resolveRef(Object.assign({ ref: 'refs/remotes/' + remote + '/HEAD', depth: 2 }, repo))
      .catch(() => git.resolveRef(Object.assign({ ref: 'HEAD', depth: 2 }, repo)))
  } else {
    refPromise = git.resolveRef(Object.assign({ ref: 'HEAD', depth: 2 }, repo))
  }
  return refPromise.then((ref) => (ref.startsWith('refs/') ? ref.replace(SHORTEN_REF_RX, '') : undefined))
}

async function collectFilesFromReference (source, repo, remoteName, authStatus, ref, originUrl) {
  const url = repo.url
  const displayUrl = url || repo.dir
  const { version, editUrl } = source
  const worktreePath = ref.head
  if (!worktreePath) {
    ref.oid = await git.resolveRef(
      Object.assign(ref.detached ? { ref: 'HEAD', depth: 1 } : { ref: 'refs/' + ref.fullname }, repo)
    )
  }
  if ('startPaths' in source) {
    let startPaths
    startPaths = Array.isArray((startPaths = source.startPaths))
      ? startPaths.map(coerceToString).map(cleanStartPath)
      : (startPaths = coerceToString(startPaths)) && startPaths.split(VENTILATED_CSV_RX).map(cleanStartPath)
    startPaths = await (worktreePath
      ? resolvePathGlobsFs(worktreePath, startPaths)
      : resolvePathGlobsGit(repo, ref.oid, startPaths))
    if (!startPaths.length) {
      const refInfo = `ref: ${ref.fullname.replace(HEADS_DIR_RX, '')}${worktreePath ? ' <worktree>' : ''}`
      throw new Error(`no start paths found in ${displayUrl} (${refInfo})`)
    }
    return Promise.all(
      startPaths.map((startPath) =>
        collectFilesFromStartPath(startPath, repo, authStatus, ref, worktreePath, originUrl, editUrl, version)
      )
    )
  }
  const startPath = cleanStartPath(coerceToString(source.startPath))
  return collectFilesFromStartPath(startPath, repo, authStatus, ref, worktreePath, originUrl, editUrl, version)
}

function collectFilesFromStartPath (startPath, repo, authStatus, ref, worktreePath, originUrl, editUrl, version) {
  return (worktreePath
    ? readFilesFromWorktree(worktreePath, startPath)
    : readFilesFromGitTree(repo, ref.oid, startPath)
  )
    .then((files) => {
      const componentVersionBucket = loadComponentDescriptor(files, ref, version)
      const origin = computeOrigin(originUrl, authStatus, repo.gitdir, ref, startPath, worktreePath, editUrl)
      componentVersionBucket.files = files.map((file) => assignFileProperties(file, origin))
      return componentVersionBucket
    })
    .catch((err) => {
      const refInfo = `ref: ${ref.fullname.replace(HEADS_DIR_RX, '')}${worktreePath ? ' <worktree>' : ''}`
      const pathInfo = !startPath || err.message.startsWith('the start path ') ? '' : ' | path: ' + startPath
      throw Object.assign(err, { message: `${err.message} in ${repo.url || repo.dir} (${refInfo}${pathInfo})` })
    })
}

function readFilesFromWorktree (worktreePath, startPath) {
  const cwd = ospath.join(worktreePath, startPath)
  return fsp
    .stat(cwd)
    .catch(() => {
      throw new Error(`the start path '${startPath}' does not exist`)
    })
    .then((stat) => {
      if (!stat.isDirectory()) throw new Error(`the start path '${startPath}' is not a directory`)
      return new Promise((resolve, reject) =>
        vfs
          .src(CONTENT_SRC_GLOB, Object.assign({ cwd }, CONTENT_SRC_OPTS))
          .on('error', (err) => {
            if (err.code === 'ENOENT' && err.syscall === 'stat') {
              try {
                if (fs.lstatSync(err.path).isSymbolicLink()) {
                  err.message = `Broken symbolic link detected at ${ospath.relative(cwd, err.path)}`
                }
              } catch {}
            } else if (err.code === 'ELOOP') {
              err.message = `Symbolic link cycle detected at ${ospath.relative(cwd, err.path)}`
            }
            reject(err)
          })
          .pipe(relativizeFiles())
          .pipe(collectFiles(resolve))
      )
    })
}

/**
 * Transforms the path of every file in the stream to a relative posix path.
 *
 * Applies a mapping function to all files in the stream so they end up with a
 * posixified path relative to the file's base instead of the filesystem root.
 * This mapper also filters out any directories (indicated by file.isNull())
 * that got caught up in the glob.
 */
function relativizeFiles () {
  return map((file, enc, next) => {
    if (file.isNull()) {
      next()
    } else {
      next(
        null,
        new File({
          path: posixify ? posixify(file.relative) : file.relative,
          contents: file.contents,
          stat: file.stat,
          src: { abspath: file.path },
        })
      )
    }
  })
}

function collectFiles (done) {
  const accum = []
  return map(
    (file, enc, next) => {
      accum.push(file)
      next()
    },
    () => done(accum)
  )
}

function readFilesFromGitTree (repo, oid, startPath) {
  return git
    .readTree(Object.assign({ oid }, repo))
    .then((root) =>
      getGitTreeAtStartPath(repo, oid, startPath).then((start) =>
        srcGitTree(repo, Object.assign(root, { dirname: '' }), start)
      )
    )
}

function getGitTreeAtStartPath (repo, oid, startPath) {
  return git
    .readTree(Object.assign({ oid, filepath: startPath }, repo))
    .catch((err) => {
      const m = err instanceof ObjectTypeError && err.data.expected === 'tree' ? 'is not a directory' : 'does not exist'
      throw new Error(`the start path '${startPath}' ${m}`)
    })
    .then((result) => Object.assign(result, { dirname: startPath }))
}

function srcGitTree (repo, root, start) {
  return new Promise((resolve, reject) => {
    const files = []
    createGitTreeWalker(repo, root, filterGitEntry)
      .on('entry', (entry) => files.push(entryToFile(entry)))
      .on('error', reject)
      .on('end', () => resolve(Promise.all(files)))
      .walk(start)
  })
}

function createGitTreeWalker (repo, root, filter) {
  return Object.assign(new EventEmitter(), {
    walk (start) {
      return (
        visitGitTree(this, repo, root, filter, start)
          .then(() => this.emit('end'))
          // NOTE if error is thrown, promises already being resolved won't halt
          .catch((err) => this.emit('error', err))
      )
    },
  })
}

function visitGitTree (emitter, repo, root, filter, parent, dirname = '', following = new Set()) {
  const reads = []
  for (const entry of parent.tree) {
    const filterVerdict = filter(entry)
    if (filterVerdict) {
      const vfilePath = dirname ? path.join(dirname, entry.path) : entry.path
      if (entry.type === 'tree') {
        reads.push(
          git.readTree(Object.assign({ oid: entry.oid }, repo)).then((subtree) => {
            Object.assign(subtree, { dirname: path.join(parent.dirname, entry.path) })
            return visitGitTree(emitter, repo, root, filter, subtree, vfilePath, following)
          })
        )
      } else if (entry.type === 'blob') {
        let mode
        if (entry.mode === SYMLINK_FILE_MODE) {
          reads.push(
            readGitSymlink(repo, root, parent, entry, following)
              .catch((err) => {
                // NOTE this error could be caught after promise chain has already been rejected
                if (err instanceof NotFoundError) {
                  err.message = `Broken symbolic link detected at ${vfilePath}`
                } else if (err.code === 'SymbolicLinkCycleError') {
                  err.message = `Symbolic link cycle detected at ${vfilePath}`
                }
                throw err
              })
              .then((target) => {
                if (target.type === 'tree') {
                  return visitGitTree(emitter, repo, root, filter, target, vfilePath, new Set(following).add(entry.oid))
                } else if (target.type === 'blob' && filterVerdict === true && (mode = FILE_MODES[target.mode])) {
                  emitter.emit('entry', Object.assign({ mode, oid: target.oid, path: vfilePath }, repo))
                }
              })
          )
        } else if ((mode = FILE_MODES[entry.mode])) {
          emitter.emit('entry', Object.assign({ mode, oid: entry.oid, path: vfilePath }, repo))
        }
      }
    }
  }
  return Promise.all(reads)
}

function readGitSymlink (repo, root, parent, { oid }, following) {
  if (following.size !== (following = new Set(following).add(oid)).size) {
    return git.readBlob(Object.assign({ oid }, repo)).then(({ blob: target }) => {
      target = decodeUint8Array(target)
      let targetParent
      if (parent.dirname) {
        const dirname = parent.dirname + '/'
        target = path.join(dirname, target)
        if (target.startsWith(dirname)) {
          target = target.substr(dirname.length)
          targetParent = parent
        } else {
          targetParent = root
        }
      } else {
        target = path.normalize(target)
        targetParent = root
      }
      return readGitObjectAtPath(repo, root, targetParent, target.split('/'), following)
    })
  }
  const err = { name: 'SymbolicLinkCycleError', code: 'SymbolicLinkCycleError', oid }
  return Promise.reject(Object.assign(new Error(`Symbolic link cycle found at oid: ${err.oid}`), err))
}

// QUESTION: could we use this to resolve the start path too?
function readGitObjectAtPath (repo, root, parent, pathSegments, following) {
  const firstPathSegment = pathSegments[0]
  for (const entry of parent.tree) {
    if (entry.path === firstPathSegment) {
      return entry.type === 'tree'
        ? git.readTree(Object.assign({ oid: entry.oid }, repo)).then((subtree) => {
          Object.assign(subtree, { dirname: path.join(parent.dirname, entry.path) })
          return (pathSegments = pathSegments.slice(1)).length
            ? readGitObjectAtPath(repo, root, subtree, pathSegments, following)
            : Object.assign(subtree, { type: 'tree' })
        })
        : entry.mode === SYMLINK_FILE_MODE
          ? readGitSymlink(repo, root, parent, entry, following)
          : Promise.resolve(entry)
    }
  }
  return Promise.reject(new NotFoundError(`No file or directory found at "${parent.oid}:${pathSegments.join('/')}"`))
}

/**
 * Returns true (or 'treeOnly' if the entry is a symlink tree) if the entry
 * should be processed or false if it should be skipped. An entry with a path
 * (basename) that begins with dot ('.') is marked as skipped.
 */
function filterGitEntry (entry) {
  const entryPath = entry.path
  if (entryPath.charAt() === '.') return false
  if (entry.type === 'tree') return entry.mode === SYMLINK_FILE_MODE ? 'treeOnly' : true
  return entryPath.charAt(entryPath.length - 1) !== '~'
}

function entryToFile (entry) {
  return git.readBlob(entry).then(({ blob: contents }) => {
    contents = Buffer.from(contents.buffer)
    const stat = Object.assign(new fs.Stats(), { mode: entry.mode, mtime: undefined, size: contents.byteLength })
    return new File({ path: entry.path, contents, stat })
  })
}

function loadComponentDescriptor (files, ref, version) {
  const descriptorFileIdx = files.findIndex((file) => file.path === COMPONENT_DESC_FILENAME)
  if (descriptorFileIdx < 0) throw new Error(`${COMPONENT_DESC_FILENAME} not found`)
  const descriptorFile = files[descriptorFileIdx]
  files.splice(descriptorFileIdx, 1)
  let data
  try {
    data = yaml.load(descriptorFile.contents.toString())
  } catch (err) {
    throw Object.assign(err, { message: `${COMPONENT_DESC_FILENAME} has invalid syntax; ${err.message}` })
  }
  if (data.name == null) throw new Error(`${COMPONENT_DESC_FILENAME} is missing a name`)
  const name = (data.name = String(data.name))
  if (name === '.' || name === '..' || ~name.indexOf('/')) {
    throw new Error(`name in ${COMPONENT_DESC_FILENAME} cannot have path segments: ${name}`)
  }
  if ('version' in data) version = data.version
  if (!version) {
    if (version === undefined) throw new Error(`${COMPONENT_DESC_FILENAME} is missing a version`)
    version = ''
  } else if (version === true) {
    version = ref.shortname.replace(PATH_SEPARATOR_RX, '-')
  } else if (version.constructor === Object) {
    const refname = ref.shortname
    let matched
    if (refname in version) {
      matched = version[refname]
    } else if (
      !Object.entries(version).some(([pattern, replacement]) => {
        const result = refname.replace(makePicomatchRx(pattern, PICOMATCH_VERSION_OPTS), '\0' + replacement)
        if (result === refname) return false
        matched = result.substr(1)
        return true
      })
    ) {
      matched = refname
    }
    if (matched === '.' || matched === '..') {
      throw new Error(`version in ${COMPONENT_DESC_FILENAME} cannot have path segments: ${matched}`)
    }
    version = matched.replace(PATH_SEPARATOR_RX, '-')
  } else if ((version = String(version)) === '.' || version === '..' || ~version.indexOf('/')) {
    throw new Error(`version in ${COMPONENT_DESC_FILENAME} cannot have path segments: ${version}`)
  }
  data.version = version
  return camelCaseKeys(data, { deep: true, stopPaths: ['asciidoc'] })
}

function computeOrigin (url, authStatus, gitdir, ref, startPath, worktreePath = undefined, editUrl = true) {
  const { shortname: refname, oid: refhash, type: reftype } = ref
  const origin = { type: 'git', url, gitdir, refname, [reftype]: refname, startPath }
  if (authStatus) origin.private = authStatus
  if (worktreePath === undefined) {
    origin.refhash = refhash
  } else {
    if (worktreePath) {
      origin.fileUriPattern =
        (posixify ? 'file:///' + posixify(worktreePath) : 'file://' + worktreePath) + path.join('/', startPath, '%s')
    } else {
      origin.refhash = refhash
    }
    origin.worktree = worktreePath
    if (url.startsWith('file://')) url = undefined
  }
  if (url) origin.webUrl = url.replace(GIT_SUFFIX_RX, '')
  if (editUrl === true) {
    let match
    if (url && (match = url.match(HOSTED_GIT_REPO_RX))) {
      const host = match[1]
      let action
      let category = ''
      if (host === 'pagure.io') {
        action = 'blob'
        category = 'f'
      } else if (host === 'bitbucket.org') {
        action = 'src'
      } else {
        action = reftype === 'branch' ? 'edit' : 'blob'
      }
      origin.editUrlPattern = 'https://' + path.join(match[1], match[2], action, refname, category, startPath, '%s')
    }
  } else if (editUrl) {
    const vars = {
      path: () => (startPath ? path.join(startPath, '%s') : '%s'),
      refhash: () => refhash,
      refname: () => refname,
      web_url: () => origin.webUrl || '',
    }
    origin.editUrlPattern = editUrl.replace(EDIT_URL_TEMPLATE_VAR_RX, (_, name) => vars[name]())
  }
  return origin
}

function assignFileProperties (file, origin) {
  if (!file.src) file.src = {}
  Object.assign(file.src, { path: file.path, basename: file.basename, stem: file.stem, extname: file.extname, origin })
  if (origin.fileUriPattern) {
    const fileUri = origin.fileUriPattern.replace('%s', file.src.path)
    file.src.fileUri = ~fileUri.indexOf(' ') ? fileUri.replace(SPACE_RX, '%20') : fileUri
  }
  if (origin.editUrlPattern) {
    const editUrl = origin.editUrlPattern.replace('%s', file.src.path)
    file.src.editUrl = ~editUrl.indexOf(' ') ? editUrl.replace(SPACE_RX, '%20') : editUrl
  }
  return file
}

function buildFetchOptions (repo, progress, displayUrl, credentialsFromUrl, gitPlugins, fetchTags, operation) {
  const { credentialManager, http, urlRouter } = gitPlugins
  const onAuth = resolveCredentials.bind(credentialManager, new Map().set(undefined, credentialsFromUrl))
  const onAuthFailure = onAuth
  const onAuthSuccess = (url) => credentialManager.approved({ url })
  const opts = Object.assign({ corsProxy: false, depth: 1, http, onAuth, onAuthFailure, onAuthSuccess }, repo)
  if (urlRouter) opts.url = urlRouter.ensureGitSuffix(opts.url)
  if (progress) opts.onProgress = createProgressListener(progress, displayUrl, operation)
  if (operation === 'fetch') {
    opts.prune = true
    if (fetchTags) opts.tags = opts.pruneTags = true
  } else if (!fetchTags) {
    opts.noTags = true
  }
  return opts
}

function createProgress (urls, term) {
  if (term.isTTY && term.columns > 59) {
    let maxUrlLength = 0
    for (const url of urls) {
      if (~url.indexOf(':') && GIT_URI_DETECTOR_RX.test(url)) {
        const urlLength = extractCredentials(url).displayUrl.length
        if (urlLength > maxUrlLength) maxUrlLength = urlLength
      }
    }
    const progress = new MultiProgress(term)
    // NOTE remove the width of the operation, then partition the difference between the url and bar
    progress.maxLabelWidth = Math.min(Math.ceil((term.columns - GIT_OPERATION_LABEL_LENGTH) / 2), maxUrlLength)
    return progress
  }
}

function createProgressListener (progress, progressLabel, operation) {
  const progressBar = progress.newBar(formatProgressBar(progressLabel, progress.maxLabelWidth, operation), {
    complete: '#',
    incomplete: '-',
    renderThrottle: 25,
    total: 100,
  })
  const ticks = progressBar.stream.columns - progressBar.fmt.replace(':bar', '').length
  // NOTE leave room for indeterminate progress at end of bar; this isn't strictly needed for a bare clone
  progressBar.scaleFactor = Math.max(0, (ticks - 1) / ticks)
  progressBar.tick(0)
  return Object.assign(onGitProgress.bind(progressBar), { finish: onGitComplete.bind(progressBar) })
}

function formatProgressBar (label, maxLabelWidth, operation) {
  const paddingSize = maxLabelWidth - label.length
  let padding = ''
  if (paddingSize < 0) {
    label = '...' + label.substr(-paddingSize + 3)
  } else if (paddingSize) {
    padding = ' '.repeat(paddingSize)
  }
  // NOTE assume operation has a fixed length
  return `[${operation}] ${label}${padding} [:bar]`
}

function onGitProgress ({ phase, loaded, total }) {
  const phaseIdx = GIT_PROGRESS_PHASES.indexOf(phase)
  if (~phaseIdx) {
    const scaleFactor = this.scaleFactor
    let ratio = ((loaded / total) * scaleFactor) / GIT_PROGRESS_PHASES.length
    if (phaseIdx) ratio += (phaseIdx * scaleFactor) / GIT_PROGRESS_PHASES.length
    // NOTE: updates are automatically throttled based on renderThrottle option
    this.update(ratio > scaleFactor ? scaleFactor : ratio)
  }
}

function onGitComplete (err) {
  if (err) {
    // TODO: could use progressBar.interrupt() to replace bar with message instead
    this.chars.incomplete = '?'
    this.update(0)
    // NOTE: force progress bar to update regardless of throttle setting
    this.render(undefined, true)
  } else {
    this.update(1)
  }
}

function resolveCredentials (credentialsFromUrlHolder, url, auth) {
  const credentialsFromUrl = credentialsFromUrlHolder.get()
  if ('Authorization' in auth.headers) {
    if (!credentialsFromUrl) return this.rejected({ url, auth })
    credentialsFromUrlHolder.clear()
  } else if (credentialsFromUrl) {
    return credentialsFromUrl
  } else {
    auth = undefined
  }
  return this.fill({ url }).then((credentials) =>
    credentials
      ? { username: credentials.token || credentials.username, password: credentials.token ? '' : credentials.password }
      : this.rejected({ url, auth })
  )
}

/**
 * Generates a safe, unique folder name for a git URL.
 *
 * The purpose of this function is generate a safe, unique folder name for the cloned
 * repository that gets stored in the cache directory.
 *
 * The generated folder name follows the pattern: <basename>-<sha1>-<version>.git
 *
 * @param {String} url - The repository URL to convert.
 * @returns {String} The generated folder name.
 */
function generateCloneFolderName (url) {
  let normalizedUrl = url.toLowerCase()
  if (posixify) normalizedUrl = posixify(normalizedUrl)
  normalizedUrl = normalizedUrl.replace(GIT_SUFFIX_RX, '')
  const basename = normalizedUrl.split(ANY_SEPARATOR_RX).pop()
  const hash = createHash('sha1')
  hash.update(normalizedUrl)
  return basename + '-' + hash.digest('hex') + '.git'
}

/**
 * Resolve the HTTP URL of the specified remote for the given repository, removing embedded auth if present.
 *
 * @param {Repository} repo - The repository on which to operate.
 * @param {String} remoteName - The name of the remote to resolve.
 * @returns {String} The URL of the specified remote, if defined, or the file URI to the local repository.
 */
function resolveRemoteUrl (repo, remoteName) {
  return git.getConfig(Object.assign({ path: 'remote.' + remoteName + '.url' }, repo)).then((url) => {
    if (url) {
      if (url.startsWith('https://') || url.startsWith('http://')) {
        return ~url.indexOf('@') ? url.replace(URL_AUTH_CLEANER_RX, '$1') : url
      } else if (url.startsWith('git@')) {
        return 'https://' + url.substr(4).replace(':', '/')
      } else if (url.startsWith('ssh://')) {
        return 'https://' + url.substr(url.indexOf('@') + 1 || 6).replace(URL_PORT_CLEANER_RX, '$1')
      }
    }
    return posixify ? 'file:///' + posixify(repo.dir) : 'file://' + repo.dir
  })
}

/**
 * Checks whether the specified URL matches a directory on the local filesystem.
 *
 * @param {String} url - The URL to check.
 * @return {Boolean} A flag indicating whether the URL matches a directory on the local filesystem.
 */
function isDirectory (url) {
  return fsp
    .stat(url)
    .then((stat) => stat.isDirectory())
    .catch(invariably.false)
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

function tagsSpecified (sources, defaultTags) {
  return ~sources.findIndex((source) => {
    const tags = source.tags || defaultTags || []
    return Array.isArray(tags) ? tags.length : true
  })
}

function loadGitPlugins (gitConfig, networkConfig, startDir) {
  const plugins = new Map((git.cores || git.default.cores || new Map()).get(GIT_CORE))
  for (const [name, request] of Object.entries(gitConfig.plugins || {})) {
    if (request) plugins.set(name, userRequire(request, { dot: startDir, paths: [startDir, __dirname] }))
  }
  let credentialManager, urlRouter
  if ((credentialManager = plugins.get('credentialManager'))) {
    if (typeof credentialManager.configure === 'function') {
      credentialManager.configure({ config: gitConfig.credentials, startDir })
    }
    if (typeof credentialManager.status !== 'function') Object.assign(credentialManager, { status () {} })
  } else {
    credentialManager = new GitCredentialManagerStore().configure({ config: gitConfig.credentials, startDir })
  }
  if (gitConfig.ensureGitSuffix) urlRouter = { ensureGitSuffix: (url) => (url.endsWith('.git') ? url : url + '.git') }
  const http = plugins.get('http') || createHttpPlugin(networkConfig, 'git/isomorphic-git@' + git.version())
  return { credentialManager, http, urlRouter }
}

/**
 * Expands the content cache directory path and ensures it exists.
 *
 * @param {String} preferredCacheDir - The preferred cache directory. If the value is undefined,
 *   the user's cache folder is used.
 * @param {String} startDir - The directory to use in place of a leading '.' segment.
 *
 * @returns {Promise<String>} A promise that resolves to the absolute content cache directory.
 */
function ensureCacheDir (preferredCacheDir, startDir) {
  // QUESTION should fallback directory be relative to cwd, playbook dir, or tmpdir?
  const baseCacheDir =
    preferredCacheDir == null
      ? getCacheDir('antora' + (process.env.NODE_ENV === 'test' ? '-test' : '')) || ospath.resolve('.antora/cache')
      : expandPath(preferredCacheDir, { dot: startDir })
  const cacheDir = ospath.join(baseCacheDir, CONTENT_CACHE_FOLDER)
  return fsp
    .mkdir(cacheDir, { recursive: true })
    .then(() => cacheDir)
    .catch((err) => {
      throw Object.assign(err, { message: `Failed to create content cache directory: ${cacheDir}; ${err.message}` })
    })
}

function transformGitCloneError (err, displayUrl) {
  let wrappedMsg
  let trimMessage
  if (HTTP_ERROR_CODE_RX.test(err.code)) {
    switch (err.data.statusCode) {
      case 401:
        wrappedMsg = err.rejected
          ? 'Content repository not found or credentials were rejected'
          : 'Content repository not found or requires credentials'
        break
      case 404:
        wrappedMsg = 'Content repository not found'
        break
      default:
        wrappedMsg = err.message
        trimMessage = true
    }
  } else if (err instanceof UrlParseError || err instanceof UnknownTransportError) {
    wrappedMsg = 'Content source uses an unsupported transport protocol'
  } else if (err.code === 'ENOTFOUND') {
    wrappedMsg = `Content repository host could not be resolved: ${err.hostname}`
  } else {
    wrappedMsg = `${err.name}: ${err.message}`
    trimMessage = true
  }
  if (trimMessage) {
    wrappedMsg = ~(wrappedMsg = wrappedMsg.trimRight()).indexOf('. ') ? wrappedMsg : wrappedMsg.replace(/\.$/, '')
  }
  const wrappedErr = new Error(`${wrappedMsg} (url: ${displayUrl})`)
  wrappedErr.stack += `\nCaused by: ${err.stack || 'unknown'}`
  return wrappedErr
}

function coerceToString (value) {
  return value == null ? '' : String(value)
}

function cleanStartPath (value) {
  return value && ~value.indexOf('/') ? value.replace(SUPERFLUOUS_SEPARATORS_RX, '') : value
}

function findWorktrees (repo, patterns) {
  if (!patterns.length) return new Map()
  const linkedOnly = patterns[0] === '.' ? !(patterns = patterns.slice(1)) : true
  let worktreesDir
  return (patterns.length
    ? fsp
      .readdir((worktreesDir = ospath.join(repo.dir, '.git', 'worktrees')))
      .catch(invariably.emptyArray)
      .then((worktreeNames) => matcher(worktreeNames, [...patterns]))
      .then((worktreeNames) =>
        worktreeNames.length
          ? Promise.all(
            worktreeNames.map((worktreeName) => {
              const gitdir = ospath.resolve(worktreesDir, worktreeName)
              // NOTE uses name of worktree as branch name if HEAD is detached
              return git
                .currentBranch(Object.assign({}, repo, { gitdir }))
                .then((branch = worktreeName) =>
                  fsp
                    .readFile(ospath.join(gitdir, 'gitdir'), 'utf8')
                    .then((contents) => ({ branch, dir: ospath.dirname(contents.trimRight()) }))
                )
            })
          ).then((entries) => entries.reduce((accum, it) => accum.set(it.branch, it.dir), new Map()))
          : new Map()
      )
    : Promise.resolve(new Map())
  ).then((worktrees) =>
    linkedOnly
      ? worktrees
      : git.currentBranch(repo).then((branch) => (branch ? worktrees.set(branch, repo.dir) : worktrees))
  )
}

module.exports = aggregateContent
module.exports._computeOrigin = computeOrigin
