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

// Netlify lowercases every path, so declared URLs must not keep source casing.
const mixedOld = 'https://docs.tigergraph.com/tigergraph-server/4.2/API/README'
const mixedNew = 'https://www.tigergraph.com/docs/tigergraph-server/4.2/api/readme'
const mixedHtml = [
  `<link rel="canonical" href="${mixedOld}">`,
  `<meta property="og:url" content="${mixedOld}">`,
  `<script type="application/ld+json">{"headline":"REST API","url":"${mixedOld}","logo":"https://www.tigergraph.com/wp-content/uploads/2021/09/TigerGraph-Logo.svg"}</script>`,
  `<a href="../API/README#_Section">API</a>`,
].join('\n')
const loweredHtml = rewriteSiteFile('index.html', mixedHtml)
check('html canonical path is lowercase', loweredHtml.includes(`<link rel="canonical" href="${mixedNew}">`), true)
check('html og:url path is lowercase', loweredHtml.includes(`content="${mixedNew}"`), true)
check('json-ld url path is lowercase', loweredHtml.includes(`"url":"${mixedNew}"`), true)
check('json-ld text and non-docs urls keep their case', loweredHtml.includes('"headline":"REST API"') && loweredHtml.includes('TigerGraph-Logo.svg'), true)
check('html body links are not touched', loweredHtml.includes('<a href="../API/README#_Section">'), true)
check('sitemap path is lowercase', rewriteSiteFile('sitemap-tigergraph-server.xml', `<url><loc>${mixedOld}</loc></url>`), `<url><loc>${mixedNew}</loc></url>`)
check('fragment keeps its case', rewriteSiteFile('sitemap.xml', `<loc>${mixedOld}#_Check_Status</loc>`), `<loc>${mixedNew}#_Check_Status</loc>`)
check('markdown urls keep their case', rewriteSiteFile('index.md', `[API](${mixedOld})`), '[API](https://www.tigergraph.com/docs/tigergraph-server/4.2/API/README)')

if (failed) {
  console.error(failed + ' failed')
  process.exit(1)
}
console.log('17 passed')
