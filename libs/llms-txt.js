'use strict'

/**
 * Antora extension: generate /llms.txt from the site navigation model.
 *
 * Not registered in antora-playbook.yml. The live site-wide index is
 * tigergraph.com/docs/llms.txt. Enable ./libs/llms-txt.js in that playbook
 * later, when this should feed the full docs set.
 *
 * Inspired by Couchbase's llms-txt.js, but adapted for this dual HTML+Markdown
 * site: navigation links point at the generated `.md` twins rather than HTML,
 * and we walk Antora's navigationCatalog directly (no separate nav-data JSON).
 *
 * Spec: https://llmstxt.org/
 */

const { htmlToMdUrl, stripTags } = require('./llm-utils')

function absoluteUrl (siteUrl, path) {
  if (!path) return path
  if (/^https?:\/\//i.test(path)) return htmlToMdUrl(path)
  const base = (siteUrl || '').replace(/\/$/, '')
  const rel = path.startsWith('/') ? path : `/${path}`
  return htmlToMdUrl(base ? `${base}${rel}` : rel)
}

function navLabel (item) {
  return stripTags(item.content) || stripTags(item.title) || 'Untitled'
}

function renderNavItems (items, siteUrl, lines, depth) {
  if (!items || !items.length) return

  for (const item of items) {
    const label = navLabel(item)
    const indent = '  '.repeat(depth)
    const hasChildren = item.items && item.items.length

    if (item.url && item.urlType !== 'fragment') {
      lines.push(`${indent}- [${label}](${absoluteUrl(siteUrl, item.url)})`)
      if (hasChildren) renderNavItems(item.items, siteUrl, lines, depth + 1)
      continue
    }

    // Section heading without its own page
    if (depth === 0 && hasChildren) {
      lines.push('')
      lines.push(`### ${label}`)
      lines.push('')
      renderNavItems(item.items, siteUrl, lines, 0)
      continue
    }

    if (label) lines.push(`${indent}- ${label}`)
    if (hasChildren) renderNavItems(item.items, siteUrl, lines, depth + 1)
  }
}

function buildLlmsTxt (playbook, contentCatalog, navigationCatalog) {
  const siteTitle = (playbook.site && playbook.site.title) || 'TigerGraph Documentation'
  const siteUrl = (playbook.site && playbook.site.url) || ''
  const lines = []

  lines.push(`# ${siteTitle}`)
  lines.push('')
  lines.push(
    '> TigerGraph developer documentation for Savanna (cloud-native graph database) and Cloud Classic. ' +
      'Prefer the Markdown (`.md`) links below when loading pages into an LLM or coding agent.'
  )
  lines.push('')
  lines.push(`- [HTML site](${siteUrl || '/'})`)
  lines.push('')

  const components = contentCatalog.getComponents().slice().sort((a, b) => {
    // Prefer Savanna first, then alphabetical
    if (a.name === 'savanna') return -1
    if (b.name === 'savanna') return 1
    return a.name.localeCompare(b.name)
  })

  for (const component of components) {
    // Latest / only version for each component (both currently use version "main")
    const version = component.latest || component.versions[0]
    if (!version) continue

    const navTrees = navigationCatalog.getNavigation(component.name, version.version) || []
    if (!navTrees.length) continue

    const versionLabel =
      version.displayVersion && version.displayVersion !== 'default'
        ? ` (${version.displayVersion})`
        : version.version && version.version !== 'main'
          ? ` (${version.version})`
          : ''

    lines.push(`## ${version.title}${versionLabel}`)
    lines.push('')

    for (const tree of navTrees) {
      renderNavItems(tree.items || [tree], siteUrl, lines, 0)
    }

    lines.push('')
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}

module.exports.register = function () {
  let snapshot

  this.on('navigationBuilt', ({ playbook, contentCatalog, navigationCatalog }) => {
    snapshot = { playbook, contentCatalog, navigationCatalog }
  })

  this.on('beforePublish', ({ siteCatalog }) => {
    if (!snapshot) return

    const contents = Buffer.from(
      buildLlmsTxt(snapshot.playbook, snapshot.contentCatalog, snapshot.navigationCatalog)
    )

    siteCatalog.addFile({
      contents,
      mediaType: 'text/plain',
      out: { path: 'llms.txt' },
      path: 'llms.txt',
      pub: { url: '/llms.txt' },
      src: { stem: 'llms' },
    })
  })
}
