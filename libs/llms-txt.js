'use strict'

/**
 * Antora extension: generate /llms.txt from the site navigation model.
 *
 * The doc-site playbook loads this file. The published index is
 * https://www.tigergraph.com/docs/llms.txt. Each product is indexed in full
 * at its current version. Earlier versions are one link each, so they are
 * not left out. Links point at the Markdown twin of each page.
 *
 * Spec: https://llmstxt.org/
 */

const { createLinkResolver, htmlToMdUrl, stripTags } = require('./llm-utils')

const TITLE = 'TigerGraph Documentation'

// Netlify sets URL to the old docs host, and Antora uses that as site.url.
// The index still names the public docs site. This does not change HTML pages.
const PUBLIC_SITE_URL = 'https://www.tigergraph.com/docs'

// Cloud Classic is retiring, so the index does not list it.
const OMITTED_COMPONENTS = new Set(['cloud'])
const SUMMARY =
  '> TigerGraph builds an enterprise graph database and analytics platform for connected data. ' +
  'The database stores entities and the relationships between them, and it is built to answer questions that follow many hops across a large graph. ' +
  'Customers run it as self-managed TigerGraph DB or as Savanna, the fully managed cloud service. ' +
  'Queries use GSQL, with support for openCypher, the pattern-matching part of GQL, and hybrid graph and vector search. ' +
  'The rest of the platform is GraphStudio and Admin Portal for building and operating a database, Insights for no-code dashboards, a Graph Data Science Library of graph algorithms, the pyTigerGraph Python client, a GraphQL service, and ML Workbench.'

const DOWNLOADS = [
  '- [Enterprise Edition](https://dl.tigergraph.com/?tab=enterprise)',
  '- [Community Edition](https://dl.tigergraph.com/?tab=community)',
  '- [Tools](https://dl.tigergraph.com/?tab=tools)',
  '- [Solution](https://dl.tigergraph.com/?tab=solution)',
]

const PRODUCT_DESCRIPTIONS = {
  'tigergraph-server': 'TigerGraph DB is the self-managed database. It runs on Linux, Docker, Kubernetes, and cloud marketplace images. The docs cover installation, clustering and high availability, loading data, security, backup and restore, system management, and the REST endpoints for GSQL and for running queries. The GSQL Web Shell, the browser shell served on port 14240, is a page in this set.',
  'gsql-ref': 'GSQL is the language for defining a schema, loading data, and querying the graph. This reference also covers openCypher in GSQL and hybrid graph and vector search.',
  savanna: 'TigerGraph Savanna is the fully managed cloud service at https://tgcloud.io. Storage and compute scale separately. You create workgroups and workspaces, then design a schema, load data, and query from the browser or from an API. The Savanna REST API at https://api.tgcloud.io is the control plane for those resources. Reading and writing the graph inside a workspace uses the TigerGraph DB data-plane endpoints.',
  gui: 'GraphStudio and Admin Portal are the browser tools for a running database. GraphStudio is where you design the schema, map and load data, write queries, and explore the graph. Admin Portal is where you monitor the system and manage users, security, and operations.',
  insights: 'Insights is the no-code visual graph analyzer. You build dashboards and applications that show graph results to people who do not write GSQL.',
  'graph-ml': 'The Graph Data Science Library is a set of more than 50 GSQL queries that implement standard graph algorithms, including centrality, community detection, similarity, pathfinding, classification, embeddings, and link prediction. The published docs for this library are version 3.10.',
  pytigergraph: 'pyTigerGraph is the Python package for connecting to a TigerGraph database. It wraps the REST API and adds helpers for schema, queries, graph data science, datasets, and visualization.',
  graphql: 'TigerGraph GraphQL Service lets a GraphQL client query and modify graph data. It translates the GSQL schema into a GraphQL schema and supports queries, filtering, sorting, pagination, and mutations. The published docs are version 3.9.',
  'ml-workbench': 'TigerGraph ML Workbench was the platform for training graph machine learning models on data stored in TigerGraph. It is retiring. The Community edition remains available as-is and is no longer maintained. Feature extraction and graph embeddings continue in the pyTigerGraph GDS library.',
}

function publishedSiteUrl (playbook) {
  const configured = (playbook && playbook.site && playbook.site.url) || ''
  if (!configured) return ''
  try {
    if (new URL(configured).hostname === 'docs.tigergraph.com') return PUBLIC_SITE_URL
  } catch (err) {
    return configured
  }
  return configured.replace(/\/$/, '')
}

function absoluteUrl (siteUrl, path) {
  if (!path) return path
  if (/^https?:\/\//i.test(path)) return path
  const base = (siteUrl || '').replace(/\/$/, '')
  const rel = path.startsWith('/') ? path : `/${path}`
  return htmlToMdUrl(base ? `${base}${rel}` : rel)
}

function navLabel (item) {
  return stripTags(item.content) || stripTags(item.title) || 'Untitled'
}

function linkTarget (item, siteUrl, resolver) {
  if (!item.url || item.urlType === 'fragment') return null
  if (resolver && typeof resolver.resolveLink === 'function') {
    const resolved = resolver.resolveLink(item.url, '/')
    if (resolved) return resolved
    if (/^https?:\/\//i.test(item.url)) return item.url
  }
  return absoluteUrl(siteUrl, item.url)
}

function renderNavItems (items, siteUrl, resolver, lines, depth) {
  if (!items || !items.length) return

  for (const item of items) {
    const label = navLabel(item)
    const indent = '  '.repeat(depth)
    const hasChildren = item.items && item.items.length
    const href = linkTarget(item, siteUrl, resolver)

    if (href) {
      lines.push(`${indent}- [${label}](${href})`)
      if (hasChildren) renderNavItems(item.items, siteUrl, resolver, lines, depth + 1)
      continue
    }

    // Section heading without its own page.
    if (depth === 0 && hasChildren) {
      lines.push('')
      lines.push(`### ${label}`)
      lines.push('')
      renderNavItems(item.items, siteUrl, resolver, lines, 0)
      continue
    }

    if (label) lines.push(`${indent}- ${label}`)
    if (hasChildren) renderNavItems(item.items, siteUrl, resolver, lines, depth + 1)
  }
}

function componentOrder (playbook) {
  const attrs = playbook && playbook.asciidoc && playbook.asciidoc.attributes
  const spec = attrs && attrs['page-component-order']
  if (!spec) return []
  return String(spec)
    .split(',')
    .map((name) => name.trim().replace(/^!/, ''))
    .filter(Boolean)
}

function orderedComponents (components, order) {
  const rank = new Map(order.map((name, index) => [name, index]))
  return components.slice().sort((a, b) => {
    const ai = rank.has(a.name) ? rank.get(a.name) : order.length
    const bi = rank.has(b.name) ? rank.get(b.name) : order.length
    if (ai !== bi) return ai - bi
    return a.name.localeCompare(b.name)
  })
}

function latestVersion (component) {
  return component.latest || (component.versions && component.versions[0])
}

function compareVersions (a, b) {
  const parts = (value) => String(value || '').replace(/^v/i, '').split(/[^0-9]+/).filter(Boolean).map(Number)
  const pa = parts(a)
  const pb = parts(b)
  const length = Math.max(pa.length, pb.length)
  for (let i = 0; i < length; i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0)
    if (diff) return diff
  }
  return String(b).localeCompare(String(a))
}

function versionsNewestFirst (component) {
  const latest = latestVersion(component)
  const all = component.versions && component.versions.length ? component.versions.slice() : []
  if (latest && !all.some((version) => version.version === latest.version)) all.push(latest)
  if (!all.length) return latest ? [latest] : []
  const rest = all
    .filter((version) => !latest || version.version !== latest.version)
    .sort((a, b) => compareVersions(a.version, b.version))
  return latest ? [latest, ...rest] : rest
}

function versionName (version) {
  if (version.displayVersion && version.displayVersion !== 'default') return version.displayVersion
  if (version.version && version.version !== 'main') return version.version
  return ''
}

function versionHeading (version) {
  const name = versionName(version)
  return `## ${version.title || 'Documentation'}${name ? ` (${name})` : ''}`
}

function earlierVersionLines (component, versions, siteUrl, resolver) {
  return versions.map((version) => {
    const name = versionName(version)
    const title = version.title || component.title || component.name
    const label = name ? `${title} ${name}` : title
    const raw = version.url || `/${component.name}/${version.version}/`
    const href = (resolver && resolver.resolveLink(raw, '/')) || absoluteUrl(siteUrl, raw)
    return `- [${label}](${href})`
  })
}

function buildLlmsTxt ({ playbook, contentCatalog, navigationCatalog, resolver }) {
  const siteUrl = publishedSiteUrl(playbook)
  const lines = [
    `# ${TITLE}`,
    '',
    SUMMARY,
    '',
    '## Downloads',
    '',
    'TigerGraph software is downloaded from these pages.',
    '',
    ...DOWNLOADS,
    '',
    `- [HTML site](${siteUrl || '/'})`,
    '',
  ]

  const components = orderedComponents(
    contentCatalog.getComponents(),
    componentOrder(playbook)
  )

  for (const component of components) {
    if (OMITTED_COMPONENTS.has(component.name)) continue

    const versions = versionsNewestFirst(component)
    const latest = versions[0]
    if (!latest) continue

    const navTrees = navigationCatalog.getNavigation(component.name, latest.version) || []
    if (!navTrees.length) continue

    lines.push(versionHeading(latest))
    lines.push('')

    const description = PRODUCT_DESCRIPTIONS[component.name]
    if (description) {
      lines.push(description)
      lines.push('')
    }

    for (const tree of navTrees) {
      renderNavItems(tree.items || [tree], siteUrl, resolver, lines, 0)
    }

    const earlier = earlierVersionLines(component, versions.slice(1), siteUrl, resolver)
    if (earlier.length) {
      lines.push('')
      lines.push('Earlier versions:')
      lines.push('')
      lines.push(...earlier)
    }

    lines.push('')
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}

function aliasEntries (contentCatalog) {
  if (!contentCatalog || typeof contentCatalog.findBy !== 'function') return []
  return contentCatalog.findBy({ family: 'alias' }).reduce((accum, file) => {
    const from = file.pub && file.pub.url
    const to = file.rel && file.rel.pub && file.rel.pub.url
    if (!from || !to || from === to) return accum
    accum.push({ from, to, splat: !!(file.pub && file.pub.splat) })
    return accum
  }, [])
}

function pageUrls (contentCatalog) {
  if (!contentCatalog || typeof contentCatalog.getPages !== 'function') return []
  return contentCatalog.getPages((page) => {
    return page && page.pub && page.pub.url && page.src && page.src.family === 'page'
  }).map((page) => page.pub.url)
}

module.exports.register = function () {
  let contents

  this.on('navigationBuilt', ({ playbook, contentCatalog, navigationCatalog }) => {
    const siteUrl = publishedSiteUrl(playbook)
    const resolver = createLinkResolver({
      siteUrl,
      pages: pageUrls(contentCatalog),
      aliases: aliasEntries(contentCatalog),
    })
    contents = buildLlmsTxt({ playbook, contentCatalog, navigationCatalog, resolver })
  })

  this.on('beforePublish', ({ siteCatalog }) => {
    if (!contents) return

    siteCatalog.addFile({
      contents: Buffer.from(contents),
      mediaType: 'text/plain',
      out: { path: 'llms.txt' },
      path: 'llms.txt',
      pub: { url: '/llms.txt' },
      src: { stem: 'llms' },
    })
  })
}

module.exports.buildLlmsTxt = buildLlmsTxt
module.exports.publishedSiteUrl = publishedSiteUrl
