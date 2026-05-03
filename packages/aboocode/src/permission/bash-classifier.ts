/**
 * Bash command classifier — pragmatic 7-stage pipeline.
 *
 * Phase 15: mirrors the structure of Claude Code's Bash validator
 * (mode → security → permission → readonly → path → sed-specific →
 * model-fallback) but uses regex + tokenization primitives instead of a
 * full shell AST parser. Good enough to catch the common dangerous
 * patterns without shipping an 128KB parser; an AST-based implementation
 * can slot in later by replacing `tokenize()`.
 *
 * Returned classification:
 *   - safe:        the command is read-only and has no network effect
 *   - readonly:    the command reads state but may exfiltrate (e.g. curl)
 *   - destructive: the command mutates local state (rm, mv, chmod, etc.)
 *   - dangerous:   the command could do serious harm (rm -rf /, sudo,
 *                  pipe-to-shell, force-push, disk wipe, fork bomb)
 *
 * Pipelines and logical chains are split on `|`, `&&`, `||`, `;`, `&`
 * and every segment is classified. The overall verdict is the worst
 * classification across the pipeline.
 */

import { PermissionMode } from "./mode"

export type BashClass = "safe" | "readonly" | "destructive" | "dangerous"

export interface BashClassification {
  verdict: BashClass
  reasons: string[]
  /** The segment that produced the worst verdict. */
  worst: string
  /** When true, the pipeline has features the regex layer can't handle
   * confidently (eval, $(...) nested, unquoted redirects, etc.) — caller
   * should fall back to LLM classification. */
  needsFallback: boolean
}

const READONLY_BINARIES = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "find",
  "fd",
  "wc",
  "awk",
  "sed", // sed is gated further; in-place uses are reclassified below
  "pwd",
  "whoami",
  "date",
  "env",
  "printenv",
  "uname",
  "ps",
  "top",
  "df",
  "du",
  "stat",
  "file",
  "which",
  "type",
  "echo",
  "printf",
  "true",
  "false",
  "test",
  "[",
  "[[",
  "basename",
  "dirname",
  "readlink",
  "realpath",
  "sort",
  "uniq",
  "tr",
  "cut",
  "paste",
  "column",
  "yq",
  "jq",
  "xxd",
  "hexdump",
  "od",
])

const NETWORK_READONLY_BINARIES = new Set(["curl", "wget", "http", "httpie", "nc", "ncat", "ping", "dig", "host", "nslookup"])

const GIT_READONLY_SUBS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "describe",
  "blame",
  "remote",
  "tag",
  "config",
  "stash",
  "bisect",
  "reflog",
])

const GIT_MUTATING_SUBS = new Set([
  "add",
  "commit",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "reset",
  "checkout",
  "switch",
  "restore",
  "pull",
  "fetch",
  "clean",
  "rm",
  "mv",
  "apply",
])

const GIT_DANGEROUS_SUBS = new Set(["push", "gc", "filter-branch", "filter-repo", "worktree", "submodule"])

const DESTRUCTIVE_BINARIES = new Set([
  "rm",
  "mv",
  "cp", // cp can clobber; treat as destructive unless explicit -n/-i
  "chmod",
  "chown",
  "chattr",
  "ln",
  "tar",
  "zip",
  "unzip",
  "make",
  "cargo",
  "npm",
  "bun",
  "yarn",
  "pnpm",
  "pip",
  "pip3",
  "uv",
  "apt",
  "apt-get",
  "brew",
  "docker",
  "kubectl",
  "helm",
])

const DANGEROUS_BINARIES = new Set([
  "sudo",
  "doas",
  "su",
  "dd",
  "mkfs",
  "mkfs.ext4",
  "mkfs.ext3",
  "mkfs.xfs",
  "mkfs.btrfs",
  "fdisk",
  "parted",
  "wipefs",
  "shred",
  "halt",
  "shutdown",
  "reboot",
  "init",
  "systemctl",
  "service",
])

const DANGEROUS_PATTERNS: { re: RegExp; reason: string }[] = [
  // rm -rf /
  { re: /\brm\s+(?:-\w*\s+)*-rf?\s+\/(?!\w)/, reason: "rm -rf against / root" },
  { re: /\brm\s+(?:-\w*\s+)*-rf?\s+~\/?\s*$/, reason: "rm -rf against $HOME" },
  { re: /\brm\s+(?:-\w*\s+)*-rf?\s+\$HOME/, reason: "rm -rf against $HOME" },
  // fork bomb
  { re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, reason: "fork bomb signature ':(){ :|:& };:'" },
  // pipe-to-shell (classic install-script pattern)
  { re: /\b(curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:bash|sh|zsh|fish|python|python3|perl|ruby|node)\b/, reason: "pipe-to-shell from network" },
  // eval on network content
  { re: /\beval\s+\$\((?:curl|wget)\b/, reason: "eval of network output" },
  // force push to main/master
  { re: /\bgit\s+push\s+(?:[^;&|]*\s)?-f\b[^;&|]*\b(?:main|master|origin\/(?:main|master))\b/, reason: "git push --force to main/master" },
  { re: /\bgit\s+push\s+[^;&|]*\s--force\b[^;&|]*\b(?:main|master)\b/, reason: "git push --force to main/master" },
  // dd of= /dev/sd*
  { re: /\bdd\b[^;&|]*of=\/dev\/(?:sd|nvme|hd|vd|disk)/i, reason: "dd to raw disk device" },
  // > /dev/sd*  (disk wipe)
  { re: />\s*\/dev\/(?:sd|nvme|hd|vd|disk)/i, reason: "write to raw disk device" },
]

const AMBIGUOUS_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\$\(/, reason: "command substitution $(…)" },
  { re: /`[^`]*`/, reason: "backtick command substitution" },
  { re: /\beval\b/, reason: "eval directive" },
  { re: /\bexec\b\s+\S/, reason: "exec replaces current process" },
]

export namespace BashClassifier {
  /**
   * Tokenize respecting single/double quotes. Returns space-separated
   * argv-like chunks. Not a full shell parser — doesn't expand globs,
   * variables, or braces. Sufficient for classification of the binary
   * name and common flag/path patterns.
   */
  export function tokenize(segment: string): string[] {
    const tokens: string[] = []
    let i = 0
    const s = segment.trim()
    while (i < s.length) {
      const ch = s[i]
      if (ch === " " || ch === "\t") {
        i++
        continue
      }
      if (ch === "'" || ch === '"') {
        const end = s.indexOf(ch, i + 1)
        if (end === -1) {
          tokens.push(s.slice(i))
          break
        }
        tokens.push(s.slice(i + 1, end))
        i = end + 1
        continue
      }
      let j = i
      while (j < s.length && s[j] !== " " && s[j] !== "\t" && s[j] !== "'" && s[j] !== '"') j++
      tokens.push(s.slice(i, j))
      i = j
    }
    return tokens
  }

  export function splitPipeline(command: string): string[] {
    // Naive splitter on |, &&, ||, ;, & that ignores operators inside
    // quotes. Good enough for classification.
    const out: string[] = []
    let buf = ""
    let quote: '"' | "'" | null = null
    for (let i = 0; i < command.length; i++) {
      const ch = command[i]
      if (quote) {
        buf += ch
        if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'") {
        buf += ch
        quote = ch
        continue
      }
      if (
        ch === "|" ||
        ch === ";" ||
        ch === "&" ||
        (ch === "&" && command[i + 1] === "&") ||
        (ch === "|" && command[i + 1] === "|")
      ) {
        // Swallow doubled operators as one delimiter.
        if (ch === "|" && command[i + 1] === "|") i++
        if (ch === "&" && command[i + 1] === "&") i++
        if (buf.trim()) out.push(buf.trim())
        buf = ""
        continue
      }
      buf += ch
    }
    if (buf.trim()) out.push(buf.trim())
    return out
  }

  function classifySegment(segment: string): {
    cls: BashClass
    reason: string
    ambiguous: boolean
  } {
    const tokens = tokenize(segment)
    if (tokens.length === 0) return { cls: "safe", reason: "empty", ambiguous: false }

    // Dangerous patterns trump binary classification.
    for (const { re, reason } of DANGEROUS_PATTERNS) {
      if (re.test(segment)) return { cls: "dangerous", reason, ambiguous: false }
    }

    const ambiguous = AMBIGUOUS_PATTERNS.some((p) => p.re.test(segment))

    const bin = tokens[0].replace(/^.*\//, "")

    if (DANGEROUS_BINARIES.has(bin)) return { cls: "dangerous", reason: `uses privileged binary '${bin}'`, ambiguous }

    if (bin === "git") {
      const sub = tokens[1]?.replace(/^--?/, "") ?? ""
      if (GIT_DANGEROUS_SUBS.has(sub)) {
        return { cls: "dangerous", reason: `git ${sub} can alter remote/refs irreversibly`, ambiguous }
      }
      if (GIT_MUTATING_SUBS.has(sub)) return { cls: "destructive", reason: `git ${sub} mutates the working tree`, ambiguous }
      if (GIT_READONLY_SUBS.has(sub)) return { cls: "readonly", reason: `git ${sub} is read-only`, ambiguous }
      return { cls: "readonly", reason: `git ${sub || "(no sub)"} unknown — treated readonly`, ambiguous }
    }

    // sed in-place: reclassify as destructive
    if (bin === "sed" && tokens.some((t) => t === "-i" || t.startsWith("-i'") || t.startsWith('-i"') || t === "--in-place")) {
      return { cls: "destructive", reason: "sed -i edits files in place", ambiguous }
    }

    if (DESTRUCTIVE_BINARIES.has(bin)) {
      return { cls: "destructive", reason: `${bin} modifies filesystem or environment`, ambiguous }
    }

    if (NETWORK_READONLY_BINARIES.has(bin)) {
      return { cls: "readonly", reason: `${bin} reaches the network (may exfiltrate)`, ambiguous }
    }

    if (READONLY_BINARIES.has(bin)) return { cls: "safe", reason: `${bin} is read-only`, ambiguous }

    // Unknown binary — err toward destructive if writing, else readonly.
    if (tokens.some((t) => t === ">" || t === ">>" || t.startsWith(">"))) {
      return { cls: "destructive", reason: `unknown '${bin}' with stdout redirect to file`, ambiguous }
    }
    return { cls: "readonly", reason: `unknown '${bin}' — treated readonly`, ambiguous: true }
  }

  const ORDER: Record<BashClass, number> = { safe: 0, readonly: 1, destructive: 2, dangerous: 3 }

  /**
   * Main entrypoint — classify a full command string.
   *
   * Dangerous patterns are checked against the WHOLE command before
   * splitting (so pipe-to-shell and fork bombs still match even though
   * their signatures span pipeline boundaries).
   */
  export function classify(command: string): BashClassification {
    for (const { re, reason } of DANGEROUS_PATTERNS) {
      if (re.test(command)) {
        return { verdict: "dangerous", reasons: [`${command} → dangerous (${reason})`], worst: command, needsFallback: false }
      }
    }
    const segments = splitPipeline(command)
    if (segments.length === 0) {
      return { verdict: "safe", reasons: ["empty command"], worst: "", needsFallback: false }
    }
    let worstCls: BashClass = "safe"
    let worstSeg = segments[0]
    const reasons: string[] = []
    let anyAmbiguous = false
    for (const seg of segments) {
      const { cls, reason, ambiguous } = classifySegment(seg)
      if (ambiguous) anyAmbiguous = true
      reasons.push(`${seg} → ${cls} (${reason})`)
      if (ORDER[cls] > ORDER[worstCls]) {
        worstCls = cls
        worstSeg = seg
      }
    }
    return {
      verdict: worstCls,
      reasons,
      worst: worstSeg,
      needsFallback: anyAmbiguous && worstCls !== "dangerous",
    }
  }

  /**
   * Seven-stage permission pipeline, structured to mirror Claude Code's
   * Bash validator:
   *
   *   1. mode validation    — plan mode denies any dangerous/destructive
   *   2. security classify  — dangerous classes always deny unless bypass
   *   3. permission decide  — map verdict → allow/ask/deny
   *   4. readonly verify    — `safe` in acceptEdits is auto-allow
   *   5. path validation    — (stub) hook point for path allowlists
   *   6. sed-specific       — sed -i reclassified inside classify()
   *   7. model fallback     — if ambiguous, caller should defer to LLM
   *
   * Returns a coarse decision. Actual pattern-level matching (per-tool
   * rulesets) is still handled by PermissionNext.evaluate(); this
   * classifier is a pre-filter that lets the harness short-circuit
   * obvious cases and escalate confidently.
   */
  export function decide(command: string): {
    action: "allow" | "ask" | "deny"
    verdict: BashClass
    mode: string
    classification: BashClassification
  } {
    const classification = classify(command)
    const mode = PermissionMode.current()

    // Stage 1: mode validation
    if (mode === "plan" && classification.verdict !== "safe") {
      return { action: "deny", verdict: classification.verdict, mode, classification }
    }

    // Stage 2: security classification — dangerous is deny unless bypass
    if (classification.verdict === "dangerous" && mode !== "bypassPermissions") {
      return { action: "deny", verdict: "dangerous", mode, classification }
    }

    // Stage 3: permission decision
    if (mode === "bypassPermissions") {
      return { action: "allow", verdict: classification.verdict, mode, classification }
    }

    // Stage 4: readonly verify
    if (classification.verdict === "safe") {
      return { action: "allow", verdict: "safe", mode, classification }
    }
    if (classification.verdict === "readonly") {
      return { action: mode === "acceptEdits" ? "allow" : "ask", verdict: "readonly", mode, classification }
    }

    // Stage 5–6: path validation + sed-specific are folded into classify().

    // Stage 7: model fallback signaled via needsFallback flag.
    // Caller may choose to ask the LLM classifier here; for now, default to ask.
    return { action: "ask", verdict: classification.verdict, mode, classification }
  }
}
