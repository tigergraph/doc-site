'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')
const dir = fs.existsSync(path.join(root, 'libs')) ? 'libs' : 'lib'
const { createLinkResolver } = require(path.join(root, dir, 'llm-utils.js'))
const { markdownify } = require(path.join(root, dir, 'markdown-for-llm.js'))

const SITE = 'https://www.tigergraph.com/docs'
const pages = [
  '/savanna/main/overview/',
  '/savanna/main/graph-development/design-schema/',
]
const resolver = createLinkResolver({ siteUrl: SITE, pages })

function page (overrides) {
  return Object.assign({
    title: 'TigerGraph Savanna',
    src: { stem: 'index', component: 'savanna', version: 'main', module: 'overview', family: 'page' },
    pub: { url: '/savanna/main/overview/' },
    asciidoc: { attributes: { description: 'Cloud-native graph database' } },
    contents: Buffer.from(
      '<p>See <a href="../graph-development/design-schema/">Design a schema</a> and <a href="https://tgcloud.io">TigerGraph Savanna</a>.</p>' +
      '<p><img src="_images/image%20(9).png" alt="GSQL Workflow"></p>' +
      '<pre><code>curl https://example.com/a.html</code></pre>'
    ),
  }, overrides)
}

let failed = 0
function check (name, actual, expected) {
  try {
    assert.strictEqual(actual, expected)
  } catch (err) {
    failed++
    console.error('FAIL', name)
    console.error('  actual  ', JSON.stringify(actual))
    console.error('  expected', JSON.stringify(expected))
  }
}

const markdown = markdownify(page(), resolver)
const required = [
  'title: "TigerGraph Savanna"',
  'description: "Cloud-native graph database"',
  'component: "savanna"',
  'version: "main"',
  'module: "overview"',
  'html_url: "/savanna/main/overview/"',
  'canonical_url: "https://www.tigergraph.com/docs/savanna/main/overview/"',
  'markdown_url: "https://www.tigergraph.com/docs/savanna/main/overview/index.md"',
  '[View as HTML](https://www.tigergraph.com/docs/savanna/main/overview/)',
  '[Design a schema](https://www.tigergraph.com/docs/savanna/main/graph-development/design-schema/index.md)',
  '[TigerGraph Savanna](https://tgcloud.io)',
  '![GSQL Workflow](https://www.tigergraph.com/docs/savanna/main/overview/_images/image%20(9).png)',
  'curl https://example.com/a.html',
  '# TigerGraph Savanna',
]
for (const snippet of required) {
  check('includes ' + snippet, markdown.includes(snippet), true)
}
check('does not emit design-schema.md', markdown.includes('design-schema.md'), false)
check('does not leave the relative docs link', markdown.includes('](../graph-development/design-schema/)'), false)
check('keeps the original sentence', markdown.includes('See [Design a schema]'), true)

const localResolver = createLinkResolver({ pages })
const local = markdownify(page(), localResolver)
check('local build omits canonical_url', local.includes('canonical_url:'), false)
check('local build omits markdown_url', local.includes('markdown_url:'), false)
check('local build keeps html_url', local.includes('html_url: "/savanna/main/overview/"'), true)
check(
  'local build still rewrites to the published markdown path',
  local.includes('](/savanna/main/graph-development/design-schema/index.md)'),
  true
)

const legacy = markdownify(page({
  pub: { url: '/savanna/main/get-started/connect-agent-mcp.html' },
  contents: Buffer.from('<p><a href="other.html">Other</a></p>'),
}))
check('without a resolver, .html links still become .md', legacy.includes('](other.md)'), true)
check('without a resolver, absolute frontmatter is omitted', legacy.includes('canonical_url:'), false)

if (failed) {
  console.error(failed + ' failed')
  process.exit(1)
}
console.log(required.length + 8 + ' passed')
