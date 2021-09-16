'use strict'

const Opal = global.Opal
const { $Antora } = require('../constants')
const $logger = Symbol('logger')
const $imageRefCallback = Symbol('imageRefCallback')
const $pageRefCallback = Symbol('pageRefCallback')
const converterFor = Opal.Asciidoctor.Converter.$for.bind(Opal.Asciidoctor.Converter)

let classDef

const defineHtml5Converter = () => {
  const superclass = converterFor('html5')
  if (classDef) {
    if (classDef.$superclass() !== superclass) {
      Object.setPrototypeOf(classDef.$$prototype, (classDef.$$super = superclass).$$prototype)
    }
    return classDef
  }

  classDef = Opal.klass(Opal.Antora || Opal.module(null, 'Antora', $Antora), superclass, 'Html5Converter')

  Opal.defn(classDef, '$initialize', function initialize (backend, opts, callbacks) {
    Opal.send(this, Opal.find_super_dispatcher(this, 'initialize', initialize), [backend, opts])
    this[$pageRefCallback] = callbacks.onPageRef
    this[$imageRefCallback] = callbacks.onImageRef
  })

  Opal.defn(classDef, '$convert_inline_anchor', function convertInlineAnchor (node) {
    if (node.getType() === 'xref') {
      let callback
      let refSpec =
        node.getAttribute('path', undefined, false) ||
        // NOTE detect and convert self reference into a page reference
        (node.target === '#' &&
          node.getText() == null &&
          node.getAttribute('refid', undefined, false) == null &&
          node.getDocument().getAttribute('page-relative-src-path'))
      if (refSpec && (callback = this[$pageRefCallback])) {
        const attrs = node.getAttributes()
        const fragment = attrs.fragment
        if (fragment) refSpec += '#' + fragment
        const { content, target, internal, unresolved } = callback(refSpec, node.getText())
        let type
        if (internal) {
          type = 'xref'
          attrs.path = undefined
          attrs.fragment = attrs.refid = fragment
        } else {
          type = 'link'
          if (unresolved) {
            const logger = this[$logger] || (this[$logger] = this.$logger())
            let msg = 'target of xref not found: ' + refSpec
            const loc = node.getParent().getSourceLocation()
            if (loc) msg = this.$message_with_context(msg, Opal.hash2(['source_location'], { source_location: loc }))
            logger.error(msg)
            attrs.role = `page unresolved${attrs.role ? ' ' + attrs.role : ''}`
          } else {
            attrs.role = `page${attrs.role ? ' ' + attrs.role : ''}`
          }
        }
        const attributes = Opal.hash2(Object.keys(attrs), attrs)
        const options = Opal.hash2(['type', 'target', 'attributes'], { type, target, attributes })
        node = Opal.Asciidoctor.Inline.$new(node.getParent(), 'anchor', content, options)
      }
    }
    return Opal.send(this, Opal.find_super_dispatcher(this, 'convert_inline_anchor', convertInlineAnchor), [node])
  })

  Opal.defn(classDef, '$convert_image', function convertImage (node) {
    return Opal.send(this, Opal.find_super_dispatcher(this, 'convert_image', convertImage), [
      transformImageNode(this, node, node.getAttribute('target')),
    ])
  })

  Opal.defn(classDef, '$convert_inline_image', function convertInlineImage (node) {
    return Opal.send(this, Opal.find_super_dispatcher(this, 'convert_inline_image', convertInlineImage), [
      transformImageNode(this, node, node.getTarget()),
    ])
  })

  return classDef
}

function transformImageNode (converter, node, imageTarget) {
  if (matchesResourceSpec(imageTarget)) {
    const imageRefCallback = converter[$imageRefCallback]
    if (imageRefCallback) {
      const alt = node.getAttribute('alt', undefined, false)
      if (node.isAttribute('default-alt', alt, false)) node.setAttribute('alt', alt.split(/[@:]/).pop())
      Opal.defs(node, '$image_uri', (imageSpec) => imageRefCallback(imageSpec) || imageSpec)
    }
  }
  if (node.hasAttribute('xref')) {
    const refSpec = node.getAttribute('xref', '', false)
    if (refSpec.charAt() === '#') {
      node.setAttribute('link', refSpec)
    } else if (refSpec.endsWith('.adoc') || ~refSpec.indexOf('.adoc#')) {
      const pageRefCallback = converter[$pageRefCallback]
      if (pageRefCallback) {
        const { target, unresolved } = pageRefCallback(refSpec, '[image]')
        const role = node.getAttribute('role', undefined, false)
        node.setAttribute('role', `link-page${unresolved ? ' link-unresolved' : ''}${role ? ' ' + role : ''}`)
        node.setAttribute('link', target)
      }
    } else {
      node.setAttribute('link', '#' + refSpec)
    }
  }
  return node
}

function matchesResourceSpec (target) {
  return !(~target.indexOf(':') && (~target.indexOf('://') || (target.startsWith('data:') && ~target.indexOf(','))))
}

module.exports = defineHtml5Converter
