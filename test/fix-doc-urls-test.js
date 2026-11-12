'use strict'

const assert = require('assert')
const path = require('path')
const { rewriteSiteFile } = require(path.join(__dirname, '..', 'libs', 'fix-doc-urls.js'))

const oldPage = 'https://docs.tigergraph.com/savanna/main/overview/'
const newPage = 'https://www.tigergraph.com/docs/savanna/main/overview/'
const oldMd = 'https://docs.tigergraph.com/savanna/main/overview/index.md'
const newMd = 'https://www.tigergraph.com/docs/savanna/main/overview/index.md'

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

const markdown = [
  '---',
  `canonical_url: "${oldPage}"`,
  `markdown_url: "${oldMd}"`,
  '---',
  '',
  `[View as HTML](${oldPage})`,
  '',
  `See [Overview](${oldMd}) and the materials at docs.tigergraph.com.`,
  '',
].join('\n')

const rewritten = rewriteSiteFile('index.md', markdown)
check('markdown canonical uses the public docs host', rewritten.includes(`canonical_url: "${newPage}"`), true)
check('markdown_url uses the public docs host', rewritten.includes(`markdown_url: "${newMd}"`), true)
check('markdown link uses the public docs host', rewritten.includes(`[Overview](${newMd})`), true)
check('bare hostname in prose stays', rewritten.includes('materials at docs.tigergraph.com.'), true)
check('markdown drops the old absolute host', rewritten.includes('https://docs.tigergraph.com'), false)

const html = [
  `<link rel="canonical" href="${oldPage}">`,
  `<meta property="og:url" content="${oldPage}">`,
  `<a href="${oldPage}">Overview</a>`,
].join('\n')
const rewrittenHtml = rewriteSiteFile('index.html', html)
check('html canonical uses the public docs host', rewrittenHtml.includes(`href="${newPage}"`), true)
check('html og:url uses the public docs host', rewrittenHtml.includes(`content="${newPage}"`), true)
check('html body link stays on the generated host', rewrittenHtml.includes(`<a href="${oldPage}">`), true)

const sitemap = `<url><loc>${oldPage}</loc></url>`
check('sitemap uses the public docs host', rewriteSiteFile('sitemap.xml', sitemap), `<url><loc>${newPage}</loc></url>`)
check('other sitemap names are unchanged', rewriteSiteFile('other.xml', sitemap), sitemap)

if (failed) {
  console.error(failed + ' failed')
  process.exit(1)
}
console.log('9 passed')
