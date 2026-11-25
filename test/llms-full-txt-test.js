'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')
const dir = fs.existsSync(path.join(root, 'libs')) ? 'libs' : 'lib'
const { createLinkResolver, pageKey } = require(path.join(root, dir, 'llm-utils.js'))
const { buildLlmsFullTxt, publishedSiteUrl } = require(path.join(root, dir, 'llms-txt.js'))

const SITE = 'https://www.tigergraph.com/docs'
const pageList = [
  '/home/',
  '/tigergraph-server/4.3/',
  '/gsql-ref/4.3/intro/',
  '/gsql-ref/4.2/intro/',
  '/savanna/main/overview/',
  '/savanna/main/overview/release-notes',
  '/cloud/main/start/overview',
]
const resolver = createLinkResolver({
  siteUrl: SITE,
  pages: pageList,
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
    { items: [{ content: 'Get started', url: '/tigergraph-server/4.3/' }] },
  ],
  'gsql-ref@4.3': [
    {
      items: [
        {
          content: 'GSQL',
          items: [
            { content: 'Introduction', url: '/gsql-ref/current/intro/' },
          ],
        },
      ],
    },
  ],
  'gsql-ref@4.2': [
    { items: [{ content: 'Unlisted 4.2 page', url: '/gsql-ref/4.2/other/' }] },
  ],
  'savanna@main': [
    {
      items: [
        {
          content: 'Overview',
          url: '/savanna/main/overview/',
          items: [
            { content: 'Release notes', url: '/savanna/main/overview/release-notes' },
          ],
        },
      ],
    },
  ],
  'cloud@main': [
    { items: [{ content: 'Cloud Classic', url: '/cloud/main/start/overview' }] },
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

const overviewTwin = [
  '---',
  'title: "Introduction"',
  'html_url: "/savanna/main/overview/"',
  '---',
  '[View as HTML](https://www.tigergraph.com/docs/savanna/main/overview/)',
  '',
  '# Introduction',
  '',
  'Savanna is the managed service.',
  '',
  '## Workgroups',
  '',
  'A workgroup holds workspaces.',
  '',
  '```',
  '# not a heading',
  '```',
  '',
].join('\n')

const pages = new Map([
  [pageKey('/savanna/main/overview/'), overviewTwin],
  [pageKey('/savanna/main/overview/release-notes'), '# Release notes\n\nWhat changed.\n'],
  [pageKey('/gsql-ref/4.3/intro/'), '# Introduction\n\nGSQL defines the schema.\n'],
  [pageKey('/gsql-ref/4.2/intro/'), '# Start\n\nThis is the 4.2 start page.\n'],
])

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

const text = buildLlmsFullTxt({ playbook, contentCatalog, navigationCatalog, resolver, pages })

check('starts with the site title', text.startsWith('# TigerGraph Documentation\n'), true)
check('keeps the summary', text.includes('> TigerGraph builds an enterprise graph database'), true)
check('keeps the download list', text.includes('- [Enterprise Edition](https://dl.tigergraph.com/?tab=enterprise)'), true)
check('omits Cloud Classic', text.includes('Cloud Classic') || text.includes('/cloud/'), false)
check('does not load the 4.2 navigation', sawOldVersion, false)
check('does not copy an unlisted 4.2 page', text.includes('Unlisted 4.2 page'), false)

const serverAt = text.indexOf('- [Get started](https://www.tigergraph.com/docs/tigergraph-server/4.3/index.md)')
const gsqlAt = text.indexOf('GSQL defines the schema.')
const savannaAt = text.indexOf('Savanna is the managed service.')
const earlierAt = text.indexOf('This is the 4.2 start page.')
check('server stays a link when the page has no Markdown', serverAt > 0, true)
check('current gsql body follows the server link', serverAt < gsqlAt, true)
check('earlier gsql version stays inside the gsql section', gsqlAt < earlierAt, true)
check('savanna follows the gsql section', earlierAt < savannaAt, true)

check('uses the nav label for the savanna page', text.includes('### Overview'), true)
check('drops the twin title', /^# Introduction$/m.test(text), false)
check('drops front matter', text.includes('html_url:'), false)
check('drops the HTML pointer', text.includes('[View as HTML]'), false)
check(
  'source is the markdown twin',
  text.includes('Source: https://www.tigergraph.com/docs/savanna/main/overview/index.md'),
  true
)
check('shifts a section heading under the page', text.includes('#### Workgroups'), true)
check('leaves a fenced heading alone', text.includes('# not a heading'), true)
check('nests a child page under its parent', text.includes('#### Release notes'), true)
check('inlines the child page', text.includes('What changed.'), true)
check(
  'follows a version alias to the current page',
  text.includes('Source: https://www.tigergraph.com/docs/gsql-ref/4.3/intro/index.md'),
  true
)
check(
  'inlines the earlier version start page',
  text.includes('### GSQL Language Reference 4.2'),
  true
)
check(
  'earlier version source uses the public markdown url',
  text.includes('Source: https://www.tigergraph.com/docs/gsql-ref/4.2/intro/index.md'),
  true
)

const legacyPlaybook = {
  site: { title: 'Docs', url: 'https://docs.tigergraph.com' },
  asciidoc: playbook.asciidoc,
}
const legacyResolver = createLinkResolver({
  siteUrl: publishedSiteUrl(legacyPlaybook),
  pages: pageList,
  aliases: [{ from: '/gsql-ref/current', to: '/gsql-ref/4.3', splat: true }],
})
const legacyText = buildLlmsFullTxt({
  playbook: legacyPlaybook,
  contentCatalog,
  navigationCatalog,
  resolver: legacyResolver,
  pages,
})
check('legacy build uses the public docs host', legacyText.includes(SITE + '/savanna/main/overview/index.md'), true)
check('legacy build omits the old docs host', legacyText.includes('docs.tigergraph.com'), false)

// The published file is assembled from the pages this build converted.
const markdownForLlm = require(path.join(root, dir, 'markdown-for-llm.js'))
const llmsTxt = require(path.join(root, dir, 'llms-txt.js'))
const handlers = {}
const context = {
  on (name, fn) {
    (handlers[name] = handlers[name] || []).push(fn)
  },
}
markdownForLlm.register.call(context)
llmsTxt.register.call(context)

const savannaPage = {
  title: 'Introduction',
  mediaType: 'text/html',
  out: { path: 'savanna/main/overview/index.html' },
  pub: { url: '/savanna/main/overview/' },
  src: { stem: 'index', component: 'savanna', version: 'main', module: 'overview', family: 'page' },
  contents: Buffer.from('<p>Dynamic savanna sentence.</p><h2>Workgroups</h2><p>A workgroup holds workspaces.</p>'),
}
const liveCatalog = {
  getPages (filter) {
    return [savannaPage].filter((page) => !filter || filter(page))
  },
  findBy () {
    return []
  },
  getComponents: contentCatalog.getComponents,
}
const liveNav = {
  getNavigation (name) {
    if (name === 'savanna') return nav['savanna@main']
    if (name === 'cloud') return nav['cloud@main']
    return []
  },
}
const siteFiles = []
function emit (name, arg) {
  for (const fn of handlers[name] || []) fn(arg)
}
emit('documentsConverted', { contentCatalog: liveCatalog, playbook })
emit('navigationBuilt', { playbook, contentCatalog: liveCatalog, navigationCatalog: liveNav })
emit('beforePublish', { siteCatalog: { addFile (file) { siteFiles.push(file) } } })

const fullFile = siteFiles.find((file) => file.path === 'llms-full.txt')
const indexFile = siteFiles.find((file) => file.path === 'llms.txt')
const fullLive = fullFile ? fullFile.contents.toString() : ''
const indexLive = indexFile ? indexFile.contents.toString() : ''
check('publishes llms-full.txt', !!fullFile && fullFile.pub.url === '/llms-full.txt', true)
check('publishes llms.txt beside it', !!indexFile && indexFile.pub.url === '/llms.txt', true)
check('inlines the page converted in this build', fullLive.includes('Dynamic savanna sentence.'), true)
check('index stays a link list', indexLive.includes('- [Overview](' + SITE + '/savanna/main/overview/index.md)'), true)
check('index does not inline the page', indexLive.includes('Dynamic savanna sentence.'), false)
check('live file still omits Cloud Classic', fullLive.includes('Cloud Classic'), false)

if (failed) {
  console.error(failed + ' failed')
  console.error(text)
  process.exit(1)
}
console.log('llms-full.txt tests passed')
