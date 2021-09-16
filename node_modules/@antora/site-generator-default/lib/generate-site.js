'use strict'

const Pipeline = require('./pipeline')
const SiteCatalog = require('./site-catalog')

const aggregateContent = require('@antora/content-aggregator')
const buildNavigation = require('@antora/navigation-builder')
const buildPlaybook = require('@antora/playbook-builder')
const classifyContent = require('@antora/content-classifier')
const convertDocuments = require('@antora/document-converter')
const createPageComposer = require('@antora/page-composer')
const loadUi = require('@antora/ui-loader')
const mapSite = require('@antora/site-mapper')
const produceRedirects = require('@antora/redirect-producer')
const publishSite = require('@antora/site-publisher')
const { resolveAsciiDocConfig } = require('@antora/asciidoc-loader')

async function generateSite (args, env) {
  let playbook = buildPlaybook(args, env)
  try {
    const pipeline = new Pipeline(playbook, module)
    const vars = pipeline.vars
    await pipeline.notify('playbookBuilt')
    playbook = vars.lock('playbook')
    vars.asciidocConfig = resolveAsciiDocConfig(playbook)
    vars.siteCatalog = new SiteCatalog()
    await pipeline.notify('beforeProcess')
    const asciidocConfig = vars.lock('asciidocConfig')
    await Promise.all([
      aggregateContent(playbook).then((contentAggregate) =>
        pipeline.notify('contentAggregated', Object.assign(vars, { contentAggregate })).then(() => {
          vars.contentCatalog = classifyContent(playbook, vars.remove('contentAggregate'), asciidocConfig)
        })
      ),
      loadUi(playbook).then((uiCatalog) => pipeline.notify('uiLoaded', Object.assign(vars, { uiCatalog }))),
    ])
    await pipeline.notify('contentClassified')
    const contentCatalog = vars.lock('contentCatalog')
    const uiCatalog = vars.lock('uiCatalog')
    convertDocuments(contentCatalog, asciidocConfig)
    await pipeline.notify('documentsConverted')
    vars.navigationCatalog = buildNavigation(contentCatalog, asciidocConfig)
    await pipeline.notify('navigationBuilt')
    ;(() => {
      const navigationCatalog = vars.remove('navigationCatalog')
      const composePage = createPageComposer(playbook, contentCatalog, uiCatalog, playbook.env)
      contentCatalog.getPages((page) => page.out && composePage(page, contentCatalog, navigationCatalog))
      if (playbook.site.url) vars.siteCatalog.addFile(composePage(create404Page()))
    })()
    await pipeline.notify('pagesComposed')
    vars.siteCatalog.addFiles(produceRedirects(playbook, contentCatalog))
    await pipeline.notify('redirectsProduced')
    if (playbook.site.url) {
      const publishablePages = contentCatalog.getPages((page) => page.out)
      vars.siteCatalog.addFiles(mapSite(playbook, publishablePages))
      await pipeline.notify('siteMapped')
    }
    await pipeline.notify('beforePublish')
    return publishSite(playbook, [contentCatalog, uiCatalog, vars.lock('siteCatalog')]).then((publications) => {
      if (!playbook.runtime.quiet && process.stdout.isTTY) {
        process.stdout.write('Site generation complete!\n')
        publications.forEach(
          ({ fileUri }) => fileUri && process.stdout.write(`View the site by visiting ${fileUri} in a browser.\n`)
        )
      }
      return pipeline
        .notify('sitePublished', Object.assign(vars, { publications }))
        .then(() => vars.remove('publications'))
    })
  } catch (err) {
    if (!Pipeline.isHaltSignal(err)) throw err
  }
}

function create404Page () {
  return {
    title: 'Page Not Found',
    mediaType: 'text/html',
    src: { stem: '404' },
    out: { path: '404.html' },
    pub: { url: '/404.html', rootPath: '' },
  }
}

module.exports = generateSite
