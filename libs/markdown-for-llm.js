'use strict'

/**
 * Antora extension: emit an LLM-friendly Markdown twin for every documentation page.
 *
 * Unlike Couchbase's markdown-for-llm.js (which replaces HTML pages in a separate
 * markdown-only playbook), this extension keeps the normal HTML site and publishes
 * parallel `.md` files at the same path with a `.md` extension, e.g.:
 *
 *   /savanna/main/get-started/connect-agent-mcp.html
 *   /savanna/main/get-started/connect-agent-mcp.md
 *
 * Production uses drop-style HTML URLs, so directory pages map to index.md:
 *
 *   /overview/  →  /overview/index.md
 *   /savanna/main/overview/pricing  →  /savanna/main/overview/pricing.md
 *
 * Links inside the Markdown are resolved with playbook site.url and the pages
 * this build publishes. A published page becomes an absolute .md URL. A docs
 * URL with no generated Markdown file stays an absolute HTML URL. Hosts outside
 * the documentation site are left unchanged.
 *
 * Markdown is derived from the resolved AsciiDoc→HTML body (includes, attributes,
 * conditionals, and xrefs already applied), never from raw `.adoc` source.
 */

const { NodeHtmlMarkdown } = require('node-html-markdown')
const { stripTags, htmlToMdUrl, createLinkResolver } = require('./llm-utils')

const textReplace = [
  [/[“”]/g, '"'],
  [/[‘’]/g, "'"],
]

let nhm

const customTranslators = {
  DIV: ({}) => ({
    surroundingNewlines: 2,
    postprocess ({ content, node }) {
      if (!node.classList || !node.classList.contains('admonitionblock')) return content

      const type = (
        Array.from(node.classList).find((v) => v !== 'admonitionblock') || 'NOTE'
      ).toUpperCase()

      const bodyCell = node.querySelector('td.content') || node.querySelector('td:nth-child(2)')
      const bodyHtml = bodyCell ? bodyCell.innerHTML : content
      const body = nhm.translate(bodyHtml).replace(/^/gm, '> ')
      return `> [!${type}]\n${body}`
    },
  }),
  TABLE: ({}) => ({
    surroundingNewlines: 2,
    postprocess ({ content, node }) {
      // Prefer a readable Markdown table when the HTML table is simple enough;
      // otherwise fall back to the default text extraction from node-html-markdown.
      const rows = Array.from(node.querySelectorAll('tr'))
      if (!rows.length) return content

      const cells = rows.map((row) =>
        Array.from(row.querySelectorAll('th, td')).map((cell) =>
          nhm.translate(cell.innerHTML).replace(/\n+/g, ' ').trim().replace(/\|/g, '\\|')
        )
      )
      const width = Math.max(...cells.map((r) => r.length))
      if (!width) return content

      const padded = cells.map((r) => {
        while (r.length < width) r.push('')
        return r
      })
      const header = padded[0]
      const sep = header.map(() => '---')
      const body = padded.slice(1)
      return [
        `| ${header.join(' | ')} |`,
        `| ${sep.join(' | ')} |`,
        ...body.map((r) => `| ${r.join(' | ')} |`),
      ].join('\n')
    },
  }),
}

nhm = new NodeHtmlMarkdown({ textReplace, useInlineLinks: true }, customTranslators)

function rewriteInternalLinks (markdown) {
  // Convert in-site HTML links to their Markdown twins.
  return markdown
    .replace(/\]\(([^)\s]+)\.html(#[^)\s]*)?\)/g, ']($1.md$2)')
    .replace(/\]\(([^)\s]+)\.html\)/g, ']($1.md)')
}

function buildFrontmatter (page, urls) {
  const attrs = (page.asciidoc && page.asciidoc.attributes) || {}
  const lines = ['---']
  lines.push(`title: ${JSON.stringify(stripTags(page.title) || page.src.stem)}`)
  if (attrs.description) lines.push(`description: ${JSON.stringify(String(attrs.description))}`)
  if (page.src && page.src.component) lines.push(`component: ${JSON.stringify(page.src.component)}`)
  if (page.src && page.src.version) lines.push(`version: ${JSON.stringify(page.src.version)}`)
  if (page.src && page.src.module) lines.push(`module: ${JSON.stringify(page.src.module)}`)
  if (page.pub && page.pub.url) lines.push(`html_url: ${JSON.stringify(page.pub.url)}`)
  if (urls && urls.canonicalUrl) lines.push(`canonical_url: ${JSON.stringify(urls.canonicalUrl)}`)
  if (urls && urls.markdownUrl) lines.push(`markdown_url: ${JSON.stringify(urls.markdownUrl)}`)
  lines.push('---', '')
  return lines.join('\n')
}

function prepareHtml (html) {
  // Drop Antora heading permalink anchors so headings stay clean in Markdown.
  return String(html || '').replace(/<a\b[^>]*\bclass="[^"]*\banchor\b[^"]*"[^>]*>\s*<\/a>/gi, '')
}

function markdownify (page, resolver) {
  const title = stripTags(page.title) || (page.src && page.src.stem) || 'Untitled'
  const html = prepareHtml(page.contents ? page.contents.toString() : '')
  let markdown = nhm.translate(html)
  const pageUrl = page.pub && page.pub.url
  if (resolver) markdown = resolver.rewrite(markdown, pageUrl)
  else markdown = rewriteInternalLinks(markdown)

  const urls = resolver && pageUrl ? resolver.urlsFor(pageUrl) : {}
  const htmlUrl = (urls && urls.canonicalUrl) || pageUrl
  const header = [
    buildFrontmatter(page, urls),
    `[View as HTML](${htmlUrl})`,
    '',
    `# ${title}`,
    '',
    markdown.trim(),
    '',
  ]
  return header.join('\n')
}

function isPublishablePage (page) {
  return (
    page &&
    page.out &&
    page.pub &&
    page.mediaType === 'text/html' &&
    page.src &&
    page.src.family === 'page'
  )
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

module.exports.register = function () {
  const pending = new Map()

  // Capture resolved document HTML before the UI layout wraps it.
  this.on('documentsConverted', ({ contentCatalog, playbook }) => {
    const siteUrl = playbook && playbook.site && playbook.site.url
    const pages = contentCatalog.getPages(isPublishablePage)
    const resolver = createLinkResolver({
      siteUrl,
      pages: pages.map((page) => page.pub && page.pub.url).filter(Boolean),
      aliases: aliasEntries(contentCatalog),
    })
    for (const page of pages) {
      const outPath = page.out.path.replace(/\.html$/, '.md')
      const pubUrl = htmlToMdUrl(page.pub.url)
      pending.set(outPath, {
        contents: Buffer.from(markdownify(page, resolver)),
        outPath,
        pubUrl,
      })
    }
  })

  this.on('beforePublish', ({ siteCatalog }) => {
    for (const file of pending.values()) {
      siteCatalog.addFile({
        contents: file.contents,
        mediaType: 'text/markdown',
        out: { path: file.outPath },
        path: file.outPath,
        pub: { url: file.pubUrl },
        src: { stem: file.outPath.replace(/\.md$/, '') },
      })
    }
  })
}

module.exports.markdownify = markdownify
