import vm from "node:vm"
import z from "zod"

export namespace WorkflowRuntime {
  export const Meta = z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    whenToUse: z.string().optional(),
    model: z.string().optional(),
    phases: z
      .array(z.object({ title: z.string(), detail: z.string().optional(), model: z.string().optional() }))
      .optional(),
  })
  export type Meta = z.infer<typeof Meta>

  /**
   * Find the balanced object literal that starts at startIndex in source.
   * Returns the literal string (including braces) or null if not found.
   *
   * The scanner is string/comment-aware: it skips characters inside
   * single-quoted, double-quoted, and template-literal strings (respecting
   * backslash escapes), and inside line comments (//) and block comments.
   * Only structural brace characters count toward the depth.
   */
  function extractBalancedObject(source: string, startIndex: number): string | null {
    let depth = 0
    let i = startIndex
    const start = startIndex
    while (i < source.length) {
      const ch = source[i]

      // Skip // line comments
      if (ch === "/" && source[i + 1] === "/") {
        i += 2
        while (i < source.length && source[i] !== "\n") i++
        continue
      }

      // Skip /* … */ block comments
      if (ch === "/" && source[i + 1] === "*") {
        i += 2
        while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++
        i += 2 // consume closing */
        continue
      }

      // Skip single-quoted, double-quoted, and template-literal strings
      if (ch === "'" || ch === '"' || ch === "`") {
        const quote = ch
        i++
        while (i < source.length) {
          if (source[i] === "\\") {
            i += 2 // skip escaped character
            continue
          }
          if (source[i] === quote) {
            i++ // consume closing quote
            break
          }
          i++
        }
        continue
      }

      // Count structural braces
      if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) return source.slice(start, i + 1)
      }
      i++
    }
    return null
  }

  /**
   * Locate the `export const meta = {…}` declaration in `source` and return
   * the raw object literal text (the part after the `=`).
   */
  function findMetaLiteral(source: string): string {
    const prefixMatch = source.match(/export\s+const\s+meta\s*=\s*/)
    if (!prefixMatch || prefixMatch.index === undefined) {
      throw new Error("workflow script must start with `export const meta = { … }`")
    }
    const objStart = prefixMatch.index + prefixMatch[0].length
    if (source[objStart] !== "{") {
      throw new Error("workflow script must start with `export const meta = { … }`")
    }
    const literal = extractBalancedObject(source, objStart)
    if (!literal) {
      throw new Error("workflow meta object literal is not properly closed")
    }
    return literal
  }

  /**
   * Strip the `export const meta = {…}` declaration from `source` and return
   * the remaining body.
   */
  function stripMetaDeclaration(source: string): string {
    const prefixMatch = source.match(/export\s+const\s+meta\s*=\s*/)
    if (!prefixMatch || prefixMatch.index === undefined) return source

    const objStart = prefixMatch[0].length + (prefixMatch.index ?? 0)
    const literal = extractBalancedObject(source, objStart)
    if (!literal) return source

    const endIdx = objStart + literal.length
    // Skip optional trailing semicolon and newline(s)
    let i = endIdx
    while (i < source.length && (source[i] === ";" || source[i] === "\n" || source[i] === "\r")) i++

    return source.slice(0, prefixMatch.index) + source.slice(i)
  }

  // Pull `export const meta = {…}` out of the source and evaluate just that literal
  // in an isolated context (no globals), then validate it.
  export function parseMeta(source: string): Meta {
    const literal = findMetaLiteral(source)
    let raw: unknown
    try {
      raw = vm.runInNewContext("(" + literal + ")", Object.create(null), { timeout: 1000 })
    } catch (e) {
      throw new Error("workflow meta is not a valid object literal: " + (e as Error).message)
    }
    return Meta.parse(raw)
  }

  const GUARD_RANDOM = () => {
    throw new Error("Math.random() is not allowed in workflows (non-deterministic; breaks resume)")
  }

  function safeGlobals(injected: Record<string, unknown>): Record<string, unknown> {
    const mathProxy = new Proxy(Math, {
      get(target, prop) {
        if (prop === "random") return GUARD_RANDOM
        return (target as any)[prop]
      },
    })
    const DateGuard = function (this: unknown, ...args: unknown[]) {
      if (args.length === 0) throw new Error("new Date() with no args is not allowed in workflows (non-deterministic)")
      // @ts-expect-error spread into Date
      return new Date(...args)
    } as unknown as DateConstructor
    DateGuard.now = () => {
      throw new Error("Date.now() is not allowed in workflows (non-deterministic; breaks resume)")
    }
    // Forward deterministic Date statics to the real Date
    DateGuard.parse = Date.parse.bind(Date)
    DateGuard.UTC = Date.UTC.bind(Date)
    // Injected hooks (agent/log/args) come FIRST so that the determinism
    // guards below always win — callers cannot shadow Date or Math.
    return {
      ...injected,
      JSON,
      Math: mathProxy,
      Date: DateGuard,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Promise,
      Map,
      Set,
      RegExp,
      Error,
      Symbol,
      isNaN,
      isFinite,
      parseInt,
      parseFloat,
      structuredClone,
      console: { log: (...a: unknown[]) => void a },
    }
  }

  // Strip the meta declaration, wrap the rest as an async function body, and run it
  // in a fresh vm context with only the safe globals visible.
  // vm.createContext isolates the script from host globals (require, process, fetch, …).
  // Note: long-running/async scripts are bounded by the caller's abort signal (to be wired in the run lifecycle).
  export async function evaluate(source: string, injected: Record<string, unknown>): Promise<any> {
    const body = stripMetaDeclaration(source)
    const context = vm.createContext(safeGlobals(injected))
    const wrapped = `(async () => {\n${body}\n})()`
    const script = new vm.Script(wrapped, { filename: "workflow.js" })
    return await script.runInContext(context)
  }
}
