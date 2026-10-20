/**
 * App-level runtime polyfills for older in-app browsers / WebViews.
 *
 * Keep this file tiny and import it before React/App modules in main.tsx.
 */

const root: Window & typeof globalThis =
  typeof window !== 'undefined'
    ? window
    : (Function('return this')() as Window & typeof globalThis)

if (typeof root.globalThis === 'undefined') {
  Object.defineProperty(root, 'globalThis', {
    value: root,
    configurable: true,
    writable: true,
  })
}

if (typeof Object.hasOwn !== 'function') {
  Object.defineProperty(Object, 'hasOwn', {
    value: (obj: object, prop: PropertyKey) =>
      Object.prototype.hasOwnProperty.call(obj, prop),
    configurable: true,
    writable: true,
  })
}

if (typeof Object.fromEntries !== 'function') {
  Object.defineProperty(Object, 'fromEntries', {
    value: (entries: Iterable<readonly [PropertyKey, unknown]>) => {
      const obj: Record<PropertyKey, unknown> = {}
      for (const [key, value] of entries) {
        obj[key] = value
      }
      return obj
    },
    configurable: true,
    writable: true,
  })
}

if (typeof Array.prototype.flat !== 'function') {
  Object.defineProperty(Array.prototype, 'flat', {
    value: function flat(this: unknown[], depth = 1) {
      const maxDepth = Number(depth) || 0
      const out: unknown[] = []

      const append = (items: unknown[], currentDepth: number) => {
        items.forEach((item) => {
          if (Array.isArray(item) && currentDepth < maxDepth) {
            append(item, currentDepth + 1)
          } else {
            out.push(item)
          }
        })
      }

      append(this, 0)
      return out
    },
    configurable: true,
    writable: true,
  })
}

if (typeof Array.prototype.flatMap !== 'function') {
  Object.defineProperty(Array.prototype, 'flatMap', {
    value: function flatMap(
      this: unknown[],
      callback: (value: unknown, index: number, array: unknown[]) => unknown,
      thisArg?: unknown,
    ) {
      return this.map((value, index, array) => callback.call(thisArg, value, index, array)).flat()
    },
    configurable: true,
    writable: true,
  })
}

if (typeof String.prototype.matchAll !== 'function') {
  Object.defineProperty(String.prototype, 'matchAll', {
    value: function matchAll(this: string, regexp: RegExp | string) {
      const str = String(this)
      const re = regexp instanceof RegExp
        ? new RegExp(regexp.source, regexp.flags)
        : new RegExp(String(regexp), 'g')

      if (!re.global) {
        throw new TypeError('String.prototype.matchAll requires a global RegExp')
      }

      const matches: RegExpMatchArray[] = []
      let match: RegExpExecArray | null
      while ((match = re.exec(str)) !== null) {
        matches.push(match)
        if (match[0] === '') re.lastIndex += 1
      }
      return matches[Symbol.iterator]()
    },
    configurable: true,
    writable: true,
  })
}

if (typeof Promise !== 'undefined' && typeof Promise.prototype.finally !== 'function') {
  Object.defineProperty(Promise.prototype, 'finally', {
    value: function promiseFinally<T>(
      this: Promise<T>,
      onFinally?: (() => unknown) | null,
    ) {
      const runFinally = () => (typeof onFinally === 'function' ? onFinally() : onFinally)
      return this.then(
        (value) => Promise.resolve(runFinally()).then(() => value),
        (reason) => Promise.resolve(runFinally()).then(() => { throw reason }),
      )
    },
    configurable: true,
    writable: true,
  })
}

if (typeof Promise !== 'undefined' && typeof Promise.allSettled !== 'function') {
  Object.defineProperty(Promise, 'allSettled', {
    value: function allSettled(values: Iterable<unknown>) {
      return Promise.all(
        Array.from(values, (value) =>
          Promise.resolve(value).then(
            (result) => ({ status: 'fulfilled', value: result }),
            (reason) => ({ status: 'rejected', reason }),
          ),
        ),
      )
    },
    configurable: true,
    writable: true,
  })
}

if (typeof root.ResizeObserver === 'undefined') {
  class SimpleResizeObserver {
    private callback: ResizeObserverCallback
    private elements = new Map<Element, { width: number; height: number }>()
    private rafId: number | null = null

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
    }

    observe = (target: Element) => {
      const rect = target.getBoundingClientRect()
      this.elements.set(target, { width: rect.width, height: rect.height })
      this.schedule()
    }

    unobserve = (target: Element) => {
      this.elements.delete(target)
      if (this.elements.size === 0) this.cancel()
    }

    disconnect = () => {
      this.elements.clear()
      this.cancel()
    }

    private schedule() {
      if (this.rafId !== null || this.elements.size === 0) return
      this.rafId = root.requestAnimationFrame(() => {
        this.rafId = null
        this.check()
        this.schedule()
      })
    }

    private cancel() {
      if (this.rafId === null) return
      root.cancelAnimationFrame(this.rafId)
      this.rafId = null
    }

    private check() {
      const entries: ResizeObserverEntry[] = []
      this.elements.forEach((prev, target) => {
        const rect = target.getBoundingClientRect()
        if (rect.width === prev.width && rect.height === prev.height) return
        this.elements.set(target, { width: rect.width, height: rect.height })
        entries.push({
          target,
          contentRect: rect,
        } as ResizeObserverEntry)
      })

      if (entries.length > 0) {
        this.callback(entries, this as unknown as ResizeObserver)
      }
    }
  }

  Object.defineProperty(root, 'ResizeObserver', {
    value: SimpleResizeObserver,
    configurable: true,
    writable: true,
  })
}
