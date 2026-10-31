'use strict'

/**
 * Shared helpers for LLM-oriented Antora extensions.
 *
 * htmlToMdUrl maps one published HTML URL to the Markdown file written beside it.
 * Directory pages (drop-style ".../page/") become ".../page/index.md", which is
 * the file the public site serves. Stem pages become ".../page.md".
 *
 * createLinkResolver turns links in generated Markdown into absolute URLs on
 * playbook site.url. It uses the pages this build publishes, so a .md URL is
 * emitted only when that file exists. Anything else on the docs site stays an
 * absolute HTML URL. Hosts outside that site are left unchanged.
 */

const LEGACY_DOC_HOSTS = new Set([
  // Live 301: https://docs.tigergraph.com/<path> -> <site.url>/<path>
  'docs.tigergraph.com',
])

const LINK_RX = /(!?\[[^\]\n]*\])\((<[^>\n]+>|[^()\n\s]*(?:\([^()\n\s]*\)[^()\n\s]*)*)(?:\s+("[^"\n]*"))?\)/g

function stripTags (html) {
  return String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function htmlToMdUrl (url) {
  if (typeof url !== 'string') return url
  const match = /^(.*?)([?#].*)?$/.exec(url)
  const path = match[1]
  const rest = match[2] || ''
  if (/\.md$/i.test(path)) return url
  if (/\.html$/i.test(path)) return path.replace(/\.html$/i, '.md') + rest
  if (path.endsWith('/')) return path + 'index.md' + rest
  if (!path) return url
  return path + '.md' + rest
}

function pageKey (sitePath) {
  let path = String(sitePath || '/')
  const cut = path.search(/[?#]/)
  if (cut !== -1) path = path.slice(0, cut)
  try {
    path = decodeURI(path)
  } catch (err) {
    // Keep the raw path when it contains an invalid escape.
  }
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  path = path.replace(/\/index\.(?:html|md)$/i, '')
  path = path.replace(/\.(?:html|md)$/i, '')
  if (!path.startsWith('/')) path = '/' + path
  return path || '/'
}

function trimSlash (path) {
  if (!path || path === '/') return path || '/'
  return path.endsWith('/') ? path.slice(0, -1) : path
}

function isStaticAsset (sitePath) {
  const path = String(sitePath || '').split(/[?#]/)[0]
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return false
  const ext = base.slice(dot).toLowerCase()
  return ext !== '.html' && ext !== '.htm' && ext !== '.md'
}

function normalizeSite (siteUrl) {
  if (!siteUrl) {
    return {
      public: false,
      href: 'http://docs.internal',
      origin: 'http://docs.internal',
      hostname: 'docs.internal',
      apex: null,
      basePath: '',
    }
  }
  const href = String(siteUrl).replace(/\/$/, '')
  const url = new URL(href + '/')
  const basePath = url.pathname.replace(/\/$/, '')
  const hostname = url.hostname
  return {
    public: true,
    href: url.origin + basePath,
    origin: url.origin,
    hostname,
    apex: hostname.startsWith('www.') ? hostname.slice(4) : null,
    basePath,
  }
}

function createLinkResolver ({ siteUrl, pages = [], aliases = [] } = {}) {
  const site = normalizeSite(siteUrl)
  const byKey = new Map()
  const components = new Set()
  const exactAliases = new Map()
  const splats = []

  function toSitePath (pathname) {
    const path = pathname || '/'
    if (site.basePath && (path === site.basePath || path.startsWith(site.basePath + '/'))) {
      const rest = path.slice(site.basePath.length) || '/'
      return rest.startsWith('/') ? rest : '/' + rest
    }
    return path.startsWith('/') ? path : '/' + path
  }

  function joinUrl (sitePath, suffix) {
    let path = sitePath || '/'
    if (!path.startsWith('/')) path = '/' + path
    const base = site.public ? site.href + path : path
    return base + (suffix || '')
  }

  function normalizePath (value) {
    if (!value) return '/'
    if (/^https?:\/\//i.test(value)) {
      try {
        return toSitePath(new URL(value).pathname)
      } catch (err) {
        return '/'
      }
    }
    const pathOnly = String(value).split(/[?#]/)[0]
    if (pathOnly.startsWith('/')) return toSitePath(pathOnly)
    return '/' + pathOnly
  }

  function addComponent (sitePath) {
    const seg = pageKey(sitePath).split('/').filter(Boolean)[0]
    if (seg) components.add(seg)
  }

  function splatTarget (sitePath) {
    const path = sitePath.startsWith('/') ? sitePath : '/' + sitePath
    const trimmed = trimSlash(path)
    for (const rule of splats) {
      if (trimmed === rule.from || trimmed.startsWith(rule.from + '/')) {
        return rule.to + path.slice(rule.from.length)
      }
    }
    return null
  }

  function lookupRecord (sitePath) {
    let path = sitePath
    const seen = new Set()
    for (let hop = 0; hop < 4; hop++) {
      const key = pageKey(path)
      if (byKey.has(key)) return byKey.get(key)
      if (seen.has(key)) return null
      seen.add(key)
      const next = exactAliases.get(key) || splatTarget(path)
      if (!next || pageKey(next) === key) return null
      path = next
    }
    return null
  }

  function rememberPage (htmlUrl) {
    const bare = normalizePath(htmlUrl).split(/[?#]/)[0]
    if (!bare) return
    const key = pageKey(bare)
    if (byKey.has(key)) return
    byKey.set(key, { htmlPath: bare, mdPath: htmlToMdUrl(bare) })
    addComponent(bare)
  }

  function rememberAlias (alias) {
    if (!alias || !alias.from || !alias.to) return
    const from = normalizePath(alias.from).split(/[?#]/)[0]
    const to = normalizePath(alias.to).split(/[?#]/)[0]
    if (!from || !to || from === to) return
    addComponent(from)
    addComponent(to)
    if (alias.splat) splats.push({ from: trimSlash(from), to: trimSlash(to) })
    else exactAliases.set(pageKey(from), to)
  }

  pages.forEach(rememberPage)
  aliases.forEach(rememberAlias)
  splats.sort((a, b) => b.from.length - a.from.length)

  function isDocsUrl (url) {
    if (LEGACY_DOC_HOSTS.has(url.hostname)) return true
    const hostOk = url.hostname === site.hostname || (site.apex && url.hostname === site.apex)
    if (!hostOk) return false
    if (!site.basePath) return true
    return url.pathname === site.basePath || url.pathname.startsWith(site.basePath + '/')
  }

  function absolutePage (pageHtmlUrl) {
    if (!pageHtmlUrl) return site.href + '/'
    if (/^https?:\/\//i.test(pageHtmlUrl)) return pageHtmlUrl
    const path = pageHtmlUrl.startsWith('/') ? pageHtmlUrl : '/' + pageHtmlUrl
    return site.href + path
  }

  function resolve (raw, pageHtmlUrl) {
    if (!raw || raw === '#') return null
    if (/^(?:mailto|tel|javascript|data):/i.test(raw)) return null

    if (raw.startsWith('#') || raw.startsWith('?')) {
      const record = lookupRecord(normalizePath(pageHtmlUrl))
      if (!record) return null
      return joinUrl(record.mdPath, raw)
    }

    let url
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      try {
        url = new URL(raw)
      } catch (err) {
        return null
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      if (!isDocsUrl(url)) return null
    } else if (raw.startsWith('//')) {
      try {
        url = new URL(raw, site.origin + '/')
      } catch (err) {
        return null
      }
      if (!isDocsUrl(url)) return null
    } else if (raw.startsWith('/')) {
      const pathOnly = raw.split(/[?#]/)[0]
      const onBase = !!(site.basePath && (pathOnly === site.basePath || pathOnly.startsWith(site.basePath + '/')))
      const seg = pathOnly.split('/').filter(Boolean)[0]
      if (!onBase && !components.has(seg)) return null
      try {
        url = onBase ? new URL(raw, site.origin + '/') : new URL(site.href + raw)
      } catch (err) {
        return null
      }
    } else {
      try {
        url = new URL(raw, absolutePage(pageHtmlUrl))
      } catch (err) {
        return null
      }
      if (!isDocsUrl(url)) return null
    }

    const sitePath = toSitePath(url.pathname)
    const suffix = url.search + url.hash
    const record = lookupRecord(sitePath)
    if (record) return joinUrl(record.mdPath, suffix)
    if (isStaticAsset(sitePath)) return joinUrl(splatTarget(sitePath) || sitePath, suffix)
    return joinUrl(sitePath, suffix)
  }

  function rewriteSegment (segment, pageHtmlUrl) {
    const linked = segment.replace(LINK_RX, (full, label, dest, title) => {
      const raw = dest.charAt() === '<' && dest.charAt(dest.length - 1) === '>' ? dest.slice(1, -1) : dest
      const next = resolve(raw, pageHtmlUrl)
      if (!next || next === raw) return full
      const formatted = /[\s<>]/.test(next) ? '<' + next + '>' : next
      return label + '(' + formatted + (title ? ' ' + title : '') + ')'
    })
    return linked.replace(/\b(href|src)=("([^"]*)"|'([^']*)')/gi, (full, attr, quoted, dq, sq) => {
      const raw = dq == null ? sq : dq
      const next = resolve(raw, pageHtmlUrl)
      if (!next || next === raw) return full
      const quote = dq == null ? "'" : '"'
      return attr + '=' + quote + next + quote
    })
  }

  return {
    rewrite (markdown, pageHtmlUrl) {
      return rewriteOutsideCode(String(markdown || ''), (segment) => rewriteSegment(segment, pageHtmlUrl))
    },
    urlsFor (pageHtmlUrl) {
      if (!site.public || !pageHtmlUrl) return {}
      const htmlPath = normalizePath(pageHtmlUrl).split(/[?#]/)[0]
      const record = lookupRecord(htmlPath)
      return {
        canonicalUrl: joinUrl(record ? record.htmlPath : htmlPath),
        markdownUrl: record ? joinUrl(record.mdPath) : undefined,
      }
    },
  }
}

function rewriteOutsideCode (markdown, rewriteSegment) {
  let out = ''
  let i = 0
  while (i < markdown.length) {
    if (markdown.startsWith('```', i) || markdown.startsWith('~~~', i)) {
      const fence = markdown.slice(i, i + 3)
      const end = markdown.indexOf(fence, i + 3)
      const close = end === -1 ? markdown.length : end + 3
      out += markdown.slice(i, close)
      i = close
      continue
    }
    if (markdown.startsWith('``', i)) {
      const end = markdown.indexOf('``', i + 2)
      const close = end === -1 ? markdown.length : end + 2
      out += markdown.slice(i, close)
      i = close
      continue
    }
    if (markdown.charAt(i) === '`') {
      const end = markdown.indexOf('`', i + 1)
      const close = end === -1 ? markdown.length : end + 1
      out += markdown.slice(i, close)
      i = close
      continue
    }
    let next = markdown.length
    const fence = markdown.indexOf('```', i)
    const tilde = markdown.indexOf('~~~', i)
    const tick = markdown.indexOf('`', i)
    if (fence !== -1) next = Math.min(next, fence)
    if (tilde !== -1) next = Math.min(next, tilde)
    if (tick !== -1) next = Math.min(next, tick)
    const segment = markdown.slice(i, next)
    out += rewriteSegment(segment)
    i = next
  }
  return out
}

module.exports = { stripTags, htmlToMdUrl, createLinkResolver }
