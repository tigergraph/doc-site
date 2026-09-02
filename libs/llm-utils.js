'use strict'

/**
 * Shared helpers for LLM-oriented Antora extensions.
 */

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

module.exports = { stripTags, htmlToMdUrl }
