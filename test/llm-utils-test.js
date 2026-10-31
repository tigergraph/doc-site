'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')
const dir = fs.existsSync(path.join(root, 'libs')) ? 'libs' : 'lib'
const { htmlToMdUrl, stripTags, createLinkResolver } = require(path.join(root, dir, 'llm-utils.js'))

const SITE = 'https://www.tigergraph.com/docs'
const PAGES = [
  '/savanna/main/overview/',
  '/savanna/main/graph-development/design-schema/',
  '/savanna/main/get-started/connect-agent-mcp',
  '/gsql-ref/4.3/ddl-and-loading/defining-a-graph-schema',
  '/gsql-ref/4.2/ddl-and-loading/defining-a-graph-schema',
  '/gsql-ref/4.3/appendix/',
  '/gui/4.3/graphstudio/design-schema/',
]
const ALIASES = [
  { from: '/gsql-ref/current', to: '/gsql-ref/4.3', splat: true },
  { from: '/savanna/old/overview/', to: '/savanna/main/overview/' },
]

const urlCases = [
  ['/savanna/main/overview/index.html', '/savanna/main/overview/index.md'],
  ['/savanna/main/overview/', '/savanna/main/overview/index.md'],
  ['/savanna/main/overview/pricing', '/savanna/main/overview/pricing.md'],
  ['/overview/index.html#section', '/overview/index.md#section'],
  ['/overview/?foo=bar', '/overview/index.md?foo=bar'],
  ['/overview/index.md', '/overview/index.md'],
  [undefined, undefined],
]

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

for (const [input, expected] of urlCases) {
  check('htmlToMdUrl ' + JSON.stringify(input), htmlToMdUrl(input), expected)
}
check('stripTags', stripTags('<h1>TigerGraph <em>Savanna</em></h1>'), 'TigerGraph Savanna')

const resolver = createLinkResolver({ siteUrl: SITE, pages: PAGES, aliases: ALIASES })
const fromOverview = '/savanna/main/overview/'

const rewriteCases = [
  [
    'relative index page',
    '[Design a schema](../graph-development/design-schema/)',
    '[Design a schema](https://www.tigergraph.com/docs/savanna/main/graph-development/design-schema/index.md)',
  ],
  [
    'preserves link title',
    '[Design a schema](../graph-development/design-schema/ "Schema")',
    '[Design a schema](https://www.tigergraph.com/docs/savanna/main/graph-development/design-schema/index.md "Schema")',
  ],
  [
    'anchor and encoded query',
    '[Design a schema](../graph-development/design-schema/?foo=a%20b#section)',
    '[Design a schema](https://www.tigergraph.com/docs/savanna/main/graph-development/design-schema/index.md?foo=a%20b#section)',
  ],
  [
    'cross-page anchor',
    '[Next](../graph-development/design-schema/#_next_steps)',
    '[Next](https://www.tigergraph.com/docs/savanna/main/graph-development/design-schema/index.md#_next_steps)',
  ],
  [
    'stem page',
    '[Connect](../get-started/connect-agent-mcp)',
    '[Connect](https://www.tigergraph.com/docs/savanna/main/get-started/connect-agent-mcp.md)',
  ],
  [
    'same-page anchor',
    '[Auth](#authentication)',
    '[Auth](https://www.tigergraph.com/docs/savanna/main/overview/index.md#authentication)',
  ],
  [
    'external site',
    '[TigerGraph Savanna](https://tgcloud.io)',
    '[TigerGraph Savanna](https://tgcloud.io)',
  ],
  [
    'same host outside /docs',
    '[Pricing](https://www.tigergraph.com/pricing)',
    '[Pricing](https://www.tigergraph.com/pricing)',
  ],
  [
    'apex host outside /docs',
    '[Blog](https://tigergraph.com/blog/hello)',
    '[Blog](https://tigergraph.com/blog/hello)',
  ],
  [
    'mailto',
    '[Email](mailto:docs@tigergraph.com)',
    '[Email](mailto:docs@tigergraph.com)',
  ],
  [
    'protocol-relative external',
    '[CDN](//cdn.example.com/app.js)',
    '[CDN](//cdn.example.com/app.js)',
  ],
  [
    'root-relative outside the docs tree',
    '[Pricing](/pricing)',
    '[Pricing](/pricing)',
  ],
  [
    'missing page falls back to HTML',
    '[Missing](../missing-page)',
    '[Missing](https://www.tigergraph.com/docs/savanna/main/missing-page)',
  ],
  [
    'does not invent design-schema.md',
    '[Design a schema](../graph-development/design-schema/)',
    '[Design a schema](https://www.tigergraph.com/docs/savanna/main/graph-development/design-schema/index.md)',
  ],
  [
    'cross-component absolute link',
    '[Schema](https://www.tigergraph.com/docs/gsql-ref/4.3/ddl-and-loading/defining-a-graph-schema/#_with_primary_id_as_attribute)',
    '[Schema](https://www.tigergraph.com/docs/gsql-ref/4.3/ddl-and-loading/defining-a-graph-schema.md#_with_primary_id_as_attribute)',
  ],
  [
    'cross-version link stays on that version',
    '[Schema](https://www.tigergraph.com/docs/gsql-ref/4.2/ddl-and-loading/defining-a-graph-schema)',
    '[Schema](https://www.tigergraph.com/docs/gsql-ref/4.2/ddl-and-loading/defining-a-graph-schema.md)',
  ],
  [
    'other component index page',
    '[GUI](https://www.tigergraph.com/docs/gui/4.3/graphstudio/design-schema/)',
    '[GUI](https://www.tigergraph.com/docs/gui/4.3/graphstudio/design-schema/index.md)',
  ],
  [
    'legacy docs host',
    '[Schema](https://docs.tigergraph.com/savanna/main/graph-development/design-schema/)',
    '[Schema](https://www.tigergraph.com/docs/savanna/main/graph-development/design-schema/index.md)',
  ],
  [
    'apex host under /docs',
    '[Connect](https://tigergraph.com/docs/savanna/main/get-started/connect-agent-mcp)',
    '[Connect](https://www.tigergraph.com/docs/savanna/main/get-started/connect-agent-mcp.md)',
  ],
  [
    'root-relative site path',
    '[Overview](/savanna/main/overview/)',
    '[Overview](https://www.tigergraph.com/docs/savanna/main/overview/index.md)',
  ],
  [
    'domain-root path includes /docs',
    '[Overview](/docs/savanna/main/overview/#top)',
    '[Overview](https://www.tigergraph.com/docs/savanna/main/overview/index.md#top)',
  ],
  [
    'html url of a published stem page',
    '[Connect](/savanna/main/get-started/connect-agent-mcp.html)',
    '[Connect](https://www.tigergraph.com/docs/savanna/main/get-started/connect-agent-mcp.md)',
  ],
  [
    'current version alias',
    '[Schema](/gsql-ref/current/ddl-and-loading/defining-a-graph-schema)',
    '[Schema](https://www.tigergraph.com/docs/gsql-ref/4.3/ddl-and-loading/defining-a-graph-schema.md)',
  ],
  [
    'exact page alias',
    '[Overview](/savanna/old/overview/)',
    '[Overview](https://www.tigergraph.com/docs/savanna/main/overview/index.md)',
  ],
  [
    'encoded image filename',
    '![GSQL Workflow](_images/image%20(9).png)',
    '![GSQL Workflow](https://www.tigergraph.com/docs/gsql-ref/4.3/appendix/_images/image%20(9).png)',
  ],
  [
    'pdf download',
    '[Guide](guide.pdf)',
    '[Guide](https://www.tigergraph.com/docs/gsql-ref/4.3/appendix/guide.pdf)',
  ],
  [
    'zip download keeps the query',
    '[Export](export.zip?x=1)',
    '[Export](https://www.tigergraph.com/docs/gsql-ref/4.3/appendix/export.zip?x=1)',
  ],
  [
    'csv download',
    '[Rows](rows.csv#table)',
    '[Rows](https://www.tigergraph.com/docs/gsql-ref/4.3/appendix/rows.csv#table)',
  ],
  [
    'image under a version alias',
    '![Diagram](/gsql-ref/current/appendix/_images/flow.png)',
    '![Diagram](https://www.tigergraph.com/docs/gsql-ref/4.3/appendix/_images/flow.png)',
  ],
  [
    'html image src',
    '<img src="../_images/design-schema.png" alt="design schema">',
    '<img src="https://www.tigergraph.com/docs/savanna/main/_images/design-schema.png" alt="design schema">',
  ],
]

for (const [name, input, expected] of rewriteCases) {
  const pageUrl = name === 'encoded image filename' || name === 'pdf download' || name === 'zip download keeps the query' || name === 'csv download'
    ? '/gsql-ref/4.3/appendix/'
    : fromOverview
  check(name, resolver.rewrite(input, pageUrl), expected)
}

const mixed = [
  'See [Design a schema](../graph-development/design-schema/) and [TigerGraph Savanna](https://tgcloud.io).',
  '',
  '```',
  '[Design a schema](../graph-development/design-schema/)',
  '```',
  '',
  'Use `../graph-development/design-schema/` in examples.',
].join('\n')
const mixedExpected = [
  'See [Design a schema](https://www.tigergraph.com/docs/savanna/main/graph-development/design-schema/index.md) and [TigerGraph Savanna](https://tgcloud.io).',
  '',
  '```',
  '[Design a schema](../graph-development/design-schema/)',
  '```',
  '',
  'Use `../graph-development/design-schema/` in examples.',
].join('\n')
check('prose, fences, and inline code', resolver.rewrite(mixed, fromOverview), mixedExpected)
check('idempotent', resolver.rewrite(resolver.rewrite(mixed, fromOverview), fromOverview), mixedExpected)

const urls = resolver.urlsFor('/savanna/main/overview/')
check('canonical_url', urls.canonicalUrl, 'https://www.tigergraph.com/docs/savanna/main/overview/')
check('markdown_url', urls.markdownUrl, 'https://www.tigergraph.com/docs/savanna/main/overview/index.md')

const stemUrls = resolver.urlsFor('/savanna/main/get-started/connect-agent-mcp')
check('stem canonical_url', stemUrls.canonicalUrl, 'https://www.tigergraph.com/docs/savanna/main/get-started/connect-agent-mcp')
check('stem markdown_url', stemUrls.markdownUrl, 'https://www.tigergraph.com/docs/savanna/main/get-started/connect-agent-mcp.md')

const missingUrls = resolver.urlsFor('/savanna/main/missing-page')
check('missing canonical_url', missingUrls.canonicalUrl, 'https://www.tigergraph.com/docs/savanna/main/missing-page')
check('missing markdown_url omitted', missingUrls.markdownUrl, undefined)

const local = createLinkResolver({ pages: PAGES, aliases: ALIASES })
check(
  'no site.url uses a root-relative markdown path',
  local.rewrite('[Design a schema](../graph-development/design-schema/)', fromOverview),
  '[Design a schema](/savanna/main/graph-development/design-schema/index.md)'
)
check('no site.url omits canonical_url', local.urlsFor(fromOverview).canonicalUrl, undefined)
check('no site.url omits markdown_url', local.urlsFor(fromOverview).markdownUrl, undefined)
check(
  'no site.url leaves external urls alone',
  local.rewrite('[TigerGraph Savanna](https://tgcloud.io)', fromOverview),
  '[TigerGraph Savanna](https://tgcloud.io)'
)

if (failed) {
  console.error(failed + ' failed')
  process.exit(1)
}
console.log(urlCases.length + 1 + rewriteCases.length + 12 + ' passed')
