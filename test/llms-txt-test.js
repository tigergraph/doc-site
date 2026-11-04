'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')
const dir = fs.existsSync(path.join(root, 'libs')) ? 'libs' : 'lib'
const { createLinkResolver } = require(path.join(root, dir, 'llm-utils.js'))
const { buildLlmsTxt } = require(path.join(root, dir, 'llms-txt.js'))

const SITE = 'https://www.tigergraph.com/docs'
const pages = [
  '/home/',
  '/tigergraph-server/4.3/',
  '/gsql-ref/4.3/intro/',
  '/gsql-ref/4.2/intro/',
  '/gsql-ref/4.1/intro/',
  '/gsql-ref/4.3/ddl-and-loading/defining-a-graph-schema',
  '/savanna/main/overview/',
  '/cloud/main/start/overview',
]
const resolver = createLinkResolver({
  siteUrl: SITE,
  pages,
  aliases: [{ from: '/gsql-ref/current', to: '/gsql-ref/4.3', splat: true }],
})

const playbook = {
  site: { title: 'Docs', url: SITE },
  asciidoc: {
    attributes: {
      'page-component-order': '!home, tigergraph-server, gsql-ref, savanna, gui, cloud',
    },
  },
}

const nav = {
  'home@': [
    { items: [{ content: 'Welcome', url: '/home/' }] },
  ],
  'tigergraph-server@4.3': [
    {
      items: [
        { content: 'Get started', url: '/tigergraph-server/4.3/' },
      ],
    },
  ],
  'gsql-ref@4.3': [
    {
      items: [
        {
          content: 'GSQL',
          items: [
            { content: 'Introduction', url: '/gsql-ref/current/intro/' },
            {
              content: 'Defining a graph schema',
              url: '/gsql-ref/4.3/ddl-and-loading/defining-a-graph-schema',
            },
          ],
        },
      ],
    },
  ],
  'gsql-ref@4.2': [
    { items: [{ content: 'Old introduction', url: '/gsql-ref/4.2/intro/' }] },
  ],
  'gsql-ref@4.1': [
    { items: [{ content: 'Older introduction', url: '/gsql-ref/4.1/intro/' }] },
  ],
  'savanna@main': [
    { items: [{ content: 'Overview', url: '/savanna/main/overview/' }] },
  ],
  'cloud@main': [
    {
      items: [
        { content: 'Cloud Classic', url: '/cloud/main/start/overview' },
        { content: 'Status', url: 'https://status.tigergraph.com', urlType: 'external' },
      ],
    },
  ],
}

let sawOldVersion = false
const contentCatalog = {
  getComponents () {
    return [
      {
        name: 'cloud',
        latest: { version: 'main', title: 'TigerGraph Cloud Classic', displayVersion: 'default' },
      },
      {
        name: 'savanna',
        latest: { version: 'main', title: 'TigerGraph Savanna', displayVersion: 'default' },
      },
      {
        name: 'gsql-ref',
        latest: { version: '4.3', title: 'GSQL Language Reference', displayVersion: '4.3' },
        versions: [
          { version: '4.1', title: 'GSQL Language Reference', displayVersion: '4.1', url: '/gsql-ref/4.1/intro/' },
          { version: '4.2', title: 'GSQL Language Reference', displayVersion: '4.2', url: '/gsql-ref/4.2/intro/' },
          { version: '4.3', title: 'GSQL Language Reference', displayVersion: '4.3', url: '/gsql-ref/4.3/intro/' },
        ],
      },
      {
        name: 'tigergraph-server',
        latest: { version: '4.3', title: 'TigerGraph Server', displayVersion: '4.3' },
      },
      {
        name: 'home',
        latest: { version: '', title: 'Home', displayVersion: 'default' },
      },
    ]
  },
}
const navigationCatalog = {
  getNavigation (name, version) {
    if (name === 'gsql-ref' && version === '4.2') sawOldVersion = true
    return nav[name + '@' + version] || []
  },
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

const text = buildLlmsTxt({ playbook, contentCatalog, navigationCatalog, resolver })
const required = [
  '# TigerGraph Documentation',
  '> TigerGraph builds an enterprise graph database and analytics platform for connected data.',
  '## Downloads',
  '- [Enterprise Edition](https://dl.tigergraph.com/?tab=enterprise)',
  '- [Community Edition](https://dl.tigergraph.com/?tab=community)',
  '- [Tools](https://dl.tigergraph.com/?tab=tools)',
  '- [Solution](https://dl.tigergraph.com/?tab=solution)',
  '- [HTML site](https://www.tigergraph.com/docs)',
  '## Home',
  '- [Welcome](https://www.tigergraph.com/docs/home/index.md)',
  '## TigerGraph Server (4.3)',
  '- [Get started](https://www.tigergraph.com/docs/tigergraph-server/4.3/index.md)',
  '## GSQL Language Reference (4.3)',
  '### GSQL',
  '- [Introduction](https://www.tigergraph.com/docs/gsql-ref/4.3/intro/index.md)',
  '- [Defining a graph schema](https://www.tigergraph.com/docs/gsql-ref/4.3/ddl-and-loading/defining-a-graph-schema.md)',
  '## TigerGraph Savanna',
  '- [Overview](https://www.tigergraph.com/docs/savanna/main/overview/index.md)',
]
for (const snippet of required) {
  check('includes ' + snippet, text.includes(snippet), true)
}

const downloadsAt = text.indexOf('## Downloads')
const homeAt = text.indexOf('## Home')
const serverAt = text.indexOf('## TigerGraph Server')
const gsqlAt = text.indexOf('## GSQL Language Reference (4.3)')
const gsql42At = text.indexOf('- [GSQL Language Reference 4.2](https://www.tigergraph.com/docs/gsql-ref/4.2/intro/index.md)')
const gsql41At = text.indexOf('- [GSQL Language Reference 4.1](https://www.tigergraph.com/docs/gsql-ref/4.1/intro/index.md)')
const savannaAt = text.indexOf('## TigerGraph Savanna')
const savannaDesc = text.indexOf('TigerGraph Savanna is the fully managed cloud service')
const savannaLink = text.indexOf('- [Overview](https://www.tigergraph.com/docs/savanna/main/overview/index.md)')
check('downloads before the product list', downloadsAt > 0 && downloadsAt < homeAt, true)
check('home before server', homeAt < serverAt, true)
check('server before gsql', serverAt < gsqlAt, true)
check('current gsql before the 4.2 link', gsqlAt < gsql42At, true)
check('4.2 link before 4.1 link', gsql42At < gsql41At, true)
check('older links before savanna', gsql41At < savannaAt, true)
check('omits Cloud Classic', text.includes('Cloud Classic') || text.includes('/cloud/'), false)
check('savanna description sits under its heading', savannaAt < savannaDesc && savannaDesc < savannaLink, true)
check('does not copy the 4.2 navigation', text.includes('Old introduction'), false)
check('does not copy the 4.1 navigation', text.includes('Older introduction'), false)
check('does not open a section for 4.2', text.includes('## GSQL Language Reference (4.2)'), false)
check('does not load the 4.2 navigation', sawOldVersion, false)
check('does not use the playbook title Docs', text.startsWith('# Docs'), false)
check('leaves the external host alone', text.includes('status.tigergraph.com.md'), false)

if (failed) {
  console.error(failed + ' failed')
  console.error(text)
  process.exit(1)
}
console.log(required.length + 14 + ' passed')
