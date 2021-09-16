'use strict'

const convertImageRef = require('./../image/convert-image-ref')
const convertPageRef = require('./../xref/convert-page-ref')
const defineHtml5Converter = require('./html5')

/**
 * Creates an HTML5 converter instance with Antora enhancements.
 *
 * @memberof asciidoc-loader
 *
 * @param {File} file - The virtual file whose contents is an AsciiDoc source document.
 * @param {ContentCatalog} contentCatalog - The catalog of all virtual content files in the site.
 * @param {Object} config - AsciiDoc processor configuration options.
 *
 * @returns {Converter} An enhanced instance of Asciidoctor's HTML5 converter.
 */
function createConverter (file, contentCatalog, config) {
  const relativizePageRefs = config.relativizePageRefs !== false
  return defineHtml5Converter().$new('html5', undefined, {
    onImageRef: (resourceSpec) => convertImageRef(resourceSpec, file, contentCatalog),
    onPageRef: (pageSpec, content) => convertPageRef(pageSpec, content, file, contentCatalog, relativizePageRefs),
  })
}

module.exports = createConverter
