/**
 * Output styles registry.
 *
 * Ported from claude-code-leak's src/outputStyles/. The active style is
 * resolved from:
 *   1. ABOOCODE_OUTPUT_STYLE env var
 *   2. config.outputStyle
 *   3. "default"
 *
 * User-defined styles live in ~/.aboocode/output-styles/<id>.md with YAML
 * frontmatter — loaded by loadUserStyles().
 */

import { readFile, readdir } from "fs/promises"
import { join } from "path"
import { Config } from "@/config/config"
import { Global } from "@/global"
import { Log } from "@/util/log"
import { BUNDLED_STYLES, DEFAULT_STYLE, getBundledStyle } from "./bundled"
import type { OutputStyle } from "./types"

const log = Log.create({ service: "format.output-styles" })

export namespace OutputStyles {
  export type Style = OutputStyle
  export const BUNDLED = BUNDLED_STYLES
  export const DEFAULT = DEFAULT_STYLE

  const userStyleCache = new Map<string, OutputStyle>()
  let userStylesLoaded = false

  /**
   * Load user-defined styles from ~/.aboocode/output-styles/. Each file
   * is a markdown document with optional YAML frontmatter.
   */
  async function loadUserStyles(): Promise<void> {
    if (userStylesLoaded) return
    userStylesLoaded = true
    const dir = join(Global.Path.config, "output-styles")
    try {
      const entries = await readdir(dir)
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue
        const id = entry.replace(/\.md$/, "")
        try {
          const raw = await readFile(join(dir, entry), "utf-8")
          const style = parseMarkdownStyle(id, raw)
          if (style) userStyleCache.set(id, style)
        } catch (e) {
          log.warn("failed to load user output style", { file: entry, error: e })
        }
      }
    } catch {
      /* directory missing is fine */
    }
  }

  function parseMarkdownStyle(id: string, raw: string): OutputStyle | null {
    let name = id
    let description = ""
    let body = raw.trim()
    if (body.startsWith("---")) {
      const end = body.indexOf("\n---", 3)
      if (end !== -1) {
        const frontmatter = body.slice(3, end).trim()
        body = body.slice(end + 4).trim()
        for (const line of frontmatter.split("\n")) {
          const idx = line.indexOf(":")
          if (idx === -1) continue
          const key = line.slice(0, idx).trim()
          let val = line.slice(idx + 1).trim()
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1)
          }
          if (key === "name") name = val
          else if (key === "description") description = val
        }
      }
    }
    if (!body) return null
    return { id, name, description, systemPromptAddendum: body }
  }

  /**
   * Resolve the active style for the current session.
   */
  export async function active(): Promise<OutputStyle> {
    await loadUserStyles()
    const envId = process.env.ABOOCODE_OUTPUT_STYLE
    if (envId) {
      const style = userStyleCache.get(envId) ?? getBundledStyle(envId)
      if (style) return style
    }
    try {
      const config = await Config.get()
      const id = (config as { outputStyle?: string }).outputStyle
      if (id) {
        const style = userStyleCache.get(id) ?? getBundledStyle(id)
        if (style) return style
      }
    } catch {
      /* config not loaded yet */
    }
    return DEFAULT_STYLE
  }

  /**
   * Return the active style's prompt addendum, or empty string if there's
   * nothing to append. Safe to call from system prompt builders.
   */
  export async function systemPromptAddendum(): Promise<string> {
    const style = await active()
    return style.systemPromptAddendum.trim()
  }

  /**
   * Return all registered styles (bundled + user). Use for the /output-style
   * picker UI.
   */
  export async function list(): Promise<OutputStyle[]> {
    await loadUserStyles()
    const byId = new Map<string, OutputStyle>()
    for (const style of BUNDLED_STYLES) byId.set(style.id, style)
    for (const [id, style] of userStyleCache.entries()) byId.set(id, style)
    return Array.from(byId.values())
  }
}

export type { OutputStyle } from "./types"
