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
 * Markdown is derived from the resolved AsciiDoc→HTML body (includes, attributes,
 * conditionals, and xrefs already applied) — never from raw `.adoc` source.
 */

const { NodeHtmlMarkdown } = require('node-html-markdown')
const { stripTags, htmlToMdUrl } = require('./llm-utils')

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

function buildFrontmatter (page) {
  const attrs = (page.asciidoc && page.asciidoc.attributes) || {}
  const lines = ['---']
  lines.push(`title: ${JSON.stringify(stripTags(page.title) || page.src.stem)}`)
  if (attrs.description) lines.push(`description: ${JSON.stringify(String(attrs.description))}`)
  if (page.src && page.src.component) lines.push(`component: ${JSON.stringify(page.src.component)}`)
  if (page.src && page.src.version) lines.push(`version: ${JSON.stringify(page.src.version)}`)
  if (page.src && page.src.module) lines.push(`module: ${JSON.stringify(page.src.module)}`)
  if (page.pub && page.pub.url) lines.push(`html_url: ${JSON.stringify(page.pub.url)}`)
  lines.push('---', '')
  return lines.join('\n')
}

function prepareHtml (html) {
  // Drop Antora heading permalink anchors so headings stay clean in Markdown.
  return String(html || '').replace(/<a\b[^>]*\bclass="[^"]*\banchor\b[^"]*"[^>]*>\s*<\/a>/gi, '')
}

function markdownify (page) {
  const title = stripTags(page.title) || (page.src && page.src.stem) || 'Untitled'
  const html = prepareHtml(page.contents ? page.contents.toString() : '')
  let markdown = nhm.translate(html)
  markdown = rewriteInternalLinks(markdown)

  const htmlUrl = page.pub && page.pub.url
  const header = [
    buildFrontmatter(page),
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

module.exports.register = function () {
  const pending = new Map()

  // Capture resolved document HTML before the UI layout wraps it.
  this.on('documentsConverted', ({ contentCatalog }) => {
    for (const page of contentCatalog.getPages(isPublishablePage)) {
      const outPath = page.out.path.replace(/\.html$/, '.md')
      const pubUrl = htmlToMdUrl(page.pub.url)
      pending.set(outPath, {
        contents: Buffer.from(markdownify(page)),
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
