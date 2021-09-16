'use strict'

const EventEmitter = require('events')
const userRequire = require('@antora/user-require-helper')

class HaltPipelineSignal extends Error {}

class Pipeline extends EventEmitter {
  constructor (playbook, module_) {
    super()
    if (!('path' in (this.module = module_))) module_.path = require('path').dirname(module_.filename)
    _registerExtensions.bind(this)(playbook, module_, _initVars.bind(this)(playbook))
  }

  halt () {
    throw new HaltPipelineSignal()
  }

  async notify (vars, eventName) {
    if (this.listenerCount(eventName)) {
      for (const listener of this.rawListeners(eventName)) {
        const outcome = listener.call(this, Object.assign({}, vars))
        if (outcome instanceof Promise) await outcome
      }
    }
  }

  require (request) {
    return this.module.require(request)
  }

  updateVars (vars, updates) {
    try {
      Object.assign(vars, updates)
    } catch (err) {
      if (err instanceof TypeError) {
        err.message = err.message.replace(/ assign to read.only property '(.+)' .*/, " update read-only var '$1'")
      }
      throw err
    }
  }

  static isHaltSignal (err) {
    return err instanceof HaltPipelineSignal
  }
}

function _initVars (playbook) {
  const vars = Object.setPrototypeOf(
    { playbook },
    {
      lock (name) {
        return Object.defineProperty(this, name, { configurable: false, writable: false })[name]
      },
      remove (name) {
        const currentValue = this[name]
        delete this[name]
        return currentValue
      },
    }
  )
  Object.defineProperty(this, 'vars', {
    configurable: true,
    get: () => {
      delete this.vars
      return vars
    },
  })
  this.updateVars = this.updateVars.bind(this, vars)
  return vars
}

function _registerExtensions (playbook, module_, vars) {
  const extensions = (playbook.pipeline || {}).extensions
  if (extensions.length) {
    const requireContext = { dot: playbook.dir, paths: [playbook.dir || '', module_.path] }
    extensions.forEach((ext) => {
      const { enabled = true, id, require: request, ...config } = ext.constructor === String ? { require: ext } : ext
      if (enabled) {
        const { register } = userRequire(request, requireContext)
        if (typeof register === 'function') {
          register.length === 1 ? register(this) : register(this, Object.assign({ config }, vars))
        }
      }
    })
  }
  this.notify = this.eventNames().length ? this.notify.bind(this, vars) : async () => undefined
}

module.exports = Pipeline
