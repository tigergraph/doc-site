const fs = require('fs')
const path = require('path')

const siteDir = path.resolve('build/site')
const oldOrigin = 'https://docs.tigergraph.com'
const newOrigin = 'https://www.tigergraph.com/docs'

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      walk(file)
      continue
    }

    if (!/\.(html|xml)$/i.test(entry.name)) continue

    let content = fs.readFileSync(file, 'utf8')
    const original = content

    if (/^sitemap.*\.xml$/i.test(entry.name)) {
      content = content.split(oldOrigin).join(newOrigin)
    } else if (/\.html$/i.test(entry.name)) {
      content = content.replace(
        /<link\b[^>]*\brel=["']canonical["'][^>]*>/gi,
        tag => tag.split(oldOrigin).join(newOrigin)
      )

      content = content.replace(
        /<meta\b[^>]*\bproperty=["']og:url["'][^>]*>/gi,
        tag => tag.split(oldOrigin).join(newOrigin)
      )

      content = content.replace(
        /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi,
        tag => tag.split(oldOrigin).join(newOrigin)
      )
    }

    if (content !== original) {
      fs.writeFileSync(file, content)
      console.log(`Corrected: ${path.relative(siteDir, file)}`)
    }
  }
}

if (!fs.existsSync(siteDir)) {
  throw new Error(`Generated site directory not found: ${siteDir}`)
}

walk(siteDir)
