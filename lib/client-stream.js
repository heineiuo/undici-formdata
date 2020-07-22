'use strict'

const { finished } = require('stream')
const Request = require('./request')
const {
  InvalidArgumentError,
  InvalidReturnValueError,
  ClientDestroyedError,
  ClientClosedError,
  NotSupportedError
} = require('./errors')
const util = require('./util')
const {
  kDestroyed,
  kEnqueue,
  kClosed
} = require('./symbols')

class StreamRequest extends Request {
  constructor (client, opts, factory, callback) {
    super(opts, client)

    this.factory = factory
    this.callback = callback
    this.res = null
  }

  _onHeaders (statusCode, headers, resume) {
    if (statusCode < 200) {
      // TODO: Informational response.
      return
    }

    const { factory, opaque } = this

    if (!factory) {
      return
    }
    this.factory = null

    let res
    try {
      res = factory({
        statusCode,
        headers,
        opaque
      })
    } catch (err) {
      this.onError(err)
      return
    }

    const { callback } = this

    if (!callback) {
      // Aborted inside factory.
      return
    }

    if (!res) {
      this.callback = null
      callback(null, null)
      return
    }

    if (
      typeof res.write !== 'function' ||
      typeof res.end !== 'function' ||
      typeof res.on !== 'function'
    ) {
      this.callback = null
      callback(new InvalidReturnValueError('expected Writable'), null)
      return
    }

    res.on('drain', resume)
    // TODO: Avoid finished. It registers an unecessary amount of listeners.
    finished(res, { readable: false }, (err) => {
      resume()

      if (err) {
        this.onError(err)
        return
      }

      const { callback, res } = this

      if (res) {
        this.res = null
        if (!res.readable) {
          util.destroy(res, err)
        }
      }

      if (callback) {
        this.callback = null
        callback(null, null)
      }
    })

    if (typeof res.destroy === 'function') {
      res.destroy = this.runInAsyncScope.bind(this, res.destroy, res)
    }

    this.res = res
  }

  _onBody (chunk, offset, length) {
    return this.res
      ? this.res.write(chunk.slice(offset, offset + length))
      : null
  }

  _onComplete (trailers) {
    if (this.res) {
      this.res.end()
    }
  }

  _onError (err) {
    const { res, callback } = this

    this.factory = null

    if (callback) {
      this.callback = null
      process.nextTick(callback, err, null)
    }

    if (res) {
      this.res = null
      util.destroy(res, err)
    }
  }
}

module.exports = function stream (client, opts, factory, callback) {
  if (callback === undefined) {
    return new Promise((resolve, reject) => {
      stream(client, opts, factory, (err, data) => {
        return err ? reject(err) : resolve(data)
      })
    })
  }

  if (typeof callback !== 'function') {
    throw new InvalidArgumentError('invalid callback')
  }

  try {
    if (!opts || typeof opts !== 'object') {
      throw new InvalidArgumentError('invalid opts')
    }

    if (typeof factory !== 'function') {
      throw new InvalidArgumentError('invalid factory')
    }

    if (typeof callback !== 'function') {
      throw new InvalidArgumentError('invalid callback')
    }

    if (opts.method === 'CONNECT') {
      throw new NotSupportedError('CONNECT method is not supported')
    }

    if (client[kDestroyed]) {
      throw new ClientDestroyedError()
    }

    if (client[kClosed]) {
      throw new ClientClosedError()
    }

    client[kEnqueue](new StreamRequest(client, opts, factory, callback))
  } catch (err) {
    process.nextTick(callback, err, null)
  }
}