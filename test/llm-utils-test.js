'use strict'

const assert = require('assert')
const { htmlToMdUrl, stripTags } = require('../libs/llm-utils.js')

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
for (const [input, expected] of urlCases) {
  const actual = htmlToMdUrl(input)
  try {
    assert.strictEqual(actual, expected)
  } catch (err) {
    failed++
    console.error('FAIL htmlToMdUrl', JSON.stringify(input), '=>', JSON.stringify(actual), 'expected', JSON.stringify(expected))
  }
}

try {
  assert.strictEqual(stripTags('<h1>TigerGraph <em>Savanna</em></h1>'), 'TigerGraph Savanna')
} catch (err) {
  failed++
  console.error('FAIL stripTags', err.message)
}

if (failed) {
  console.error(failed + ' failed')
  process.exit(1)
}
console.log(urlCases.length + 1 + ' passed')
