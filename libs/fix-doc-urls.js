const fs = require('fs')
const path = require('path')

const siteDir = path.resolve('build/site')
const oldOrigin = 'https://docs.tigergraph.com'
const newOrigin = 'https://www.tigergraph.com/docs'

function rewriteOrigins (content) {
  return String(content).split(oldOrigin).join(newOrigin)
}

// Netlify serves every path in lowercase and 301s mixed-case requests
// (e.g. /API/, /README), so the URLs we declare must be lowercase too.
// Query strings and fragments are left as they are.
const docsUrlPath = /https:\/\/www\.tigergraph\.com\/docs[^\s"'<>?#]*/g

function lowercaseDocsPaths (content) {
  return String(content).replace(docsUrlPath, url => url.toLowerCase())
}

function rewriteDeclaredUrls (content) {
  return lowercaseDocsPaths(rewriteOrigins(content))
}

// HTML stays limited to the tags Antora fills from the Netlify URL.
// Markdown is rewritten in full because Copy page ships that file to the user.
function rewriteSiteFile (name, content) {
  if (/^sitemap.*\.xml$/i.test(name)) {
    return rewriteDeclaredUrls(content)
  }
  if (/\.md$/i.test(name)) {
    return rewriteOrigins(content)
  }
  if (/\.html$/i.test(name)) {
    let next = content.replace(
      /<link\b[^>]*\brel=["']canonical["'][^>]*>/gi,
      tag => rewriteDeclaredUrls(tag)
    )
    next = next.replace(
      /<meta\b[^>]*\bproperty=["']og:url["'][^>]*>/gi,
      tag => rewriteDeclaredUrls(tag)
    )
    next = next.replace(
      /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi,
      tag => rewriteDeclaredUrls(tag)
    )
    return next
  }
  return content
}

function walk (dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      walk(file)
      continue
    }

    if (!/\.(html|xml|md)$/i.test(entry.name)) continue

    const original = fs.readFileSync(file, 'utf8')
    const content = rewriteSiteFile(entry.name, original)

    if (content !== original) {
      fs.writeFileSync(file, content)
      console.log(`Corrected: ${path.relative(siteDir, file)}`)
    }
  }
}

if (require.main === module) {
  if (!fs.existsSync(siteDir)) {
    throw new Error(`Generated site directory not found: ${siteDir}`)
  }
  walk(siteDir)
}

module.exports = { rewriteSiteFile, oldOrigin, newOrigin }
