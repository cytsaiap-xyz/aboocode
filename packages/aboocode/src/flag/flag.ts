function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

export namespace Flag {
  export const ABOOCODE_AUTO_SHARE = truthy("ABOOCODE_AUTO_SHARE")
  export const ABOOCODE_GIT_BASH_PATH = process.env["ABOOCODE_GIT_BASH_PATH"]
  export const ABOOCODE_CONFIG = process.env["ABOOCODE_CONFIG"]
  export declare const ABOOCODE_CONFIG_DIR: string | undefined
  export const ABOOCODE_CONFIG_CONTENT = process.env["ABOOCODE_CONFIG_CONTENT"]
  export const ABOOCODE_DISABLE_AUTOUPDATE = truthy("ABOOCODE_DISABLE_AUTOUPDATE")
  export const ABOOCODE_DISABLE_PRUNE = truthy("ABOOCODE_DISABLE_PRUNE")
  export const ABOOCODE_DISABLE_TERMINAL_TITLE = truthy("ABOOCODE_DISABLE_TERMINAL_TITLE")
  export const ABOOCODE_PERMISSION = process.env["ABOOCODE_PERMISSION"]
  export const ABOOCODE_DISABLE_DEFAULT_PLUGINS = truthy("ABOOCODE_DISABLE_DEFAULT_PLUGINS")
  export const ABOOCODE_DISABLE_LSP_DOWNLOAD = truthy("ABOOCODE_DISABLE_LSP_DOWNLOAD")
  export const ABOOCODE_ENABLE_EXPERIMENTAL_MODELS = truthy("ABOOCODE_ENABLE_EXPERIMENTAL_MODELS")
  export const ABOOCODE_DISABLE_AUTOCOMPACT = truthy("ABOOCODE_DISABLE_AUTOCOMPACT")
  export const ABOOCODE_DISABLE_MODELS_FETCH = truthy("ABOOCODE_DISABLE_MODELS_FETCH")
  export const ABOOCODE_DISABLE_CLAUDE_CODE = truthy("ABOOCODE_DISABLE_CLAUDE_CODE")
  export const ABOOCODE_DISABLE_CLAUDE_CODE_PROMPT =
    ABOOCODE_DISABLE_CLAUDE_CODE || truthy("ABOOCODE_DISABLE_CLAUDE_CODE_PROMPT")
  export const ABOOCODE_DISABLE_CLAUDE_CODE_SKILLS =
    ABOOCODE_DISABLE_CLAUDE_CODE || truthy("ABOOCODE_DISABLE_CLAUDE_CODE_SKILLS")
  export const ABOOCODE_DISABLE_EXTERNAL_SKILLS =
    ABOOCODE_DISABLE_CLAUDE_CODE_SKILLS || truthy("ABOOCODE_DISABLE_EXTERNAL_SKILLS")
  export declare const ABOOCODE_DISABLE_PROJECT_CONFIG: boolean
  export const ABOOCODE_FAKE_VCS = process.env["ABOOCODE_FAKE_VCS"]
  export declare const ABOOCODE_CLIENT: string
  export const ABOOCODE_SERVER_PASSWORD = process.env["ABOOCODE_SERVER_PASSWORD"]
  export const ABOOCODE_SERVER_USERNAME = process.env["ABOOCODE_SERVER_USERNAME"]
  export const ABOOCODE_ENABLE_QUESTION_TOOL = truthy("ABOOCODE_ENABLE_QUESTION_TOOL")

  // Experimental
  export const ABOOCODE_EXPERIMENTAL = truthy("ABOOCODE_EXPERIMENTAL")
  export const ABOOCODE_EXPERIMENTAL_FILEWATCHER = truthy("ABOOCODE_EXPERIMENTAL_FILEWATCHER")
  export const ABOOCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = truthy("ABOOCODE_EXPERIMENTAL_DISABLE_FILEWATCHER")
  export const ABOOCODE_EXPERIMENTAL_ICON_DISCOVERY =
    ABOOCODE_EXPERIMENTAL || truthy("ABOOCODE_EXPERIMENTAL_ICON_DISCOVERY")

  const copy = process.env["ABOOCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
  export const ABOOCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT =
    copy === undefined ? process.platform === "win32" : truthy("ABOOCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
  export const ABOOCODE_ENABLE_EXA =
    truthy("ABOOCODE_ENABLE_EXA") || ABOOCODE_EXPERIMENTAL || truthy("ABOOCODE_EXPERIMENTAL_EXA")
  export const ABOOCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = number("ABOOCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS")
  export const ABOOCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX = number("ABOOCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX")
  export const ABOOCODE_EXPERIMENTAL_OXFMT = ABOOCODE_EXPERIMENTAL || truthy("ABOOCODE_EXPERIMENTAL_OXFMT")
  export const ABOOCODE_EXPERIMENTAL_LSP_TY = truthy("ABOOCODE_EXPERIMENTAL_LSP_TY")
  export const ABOOCODE_EXPERIMENTAL_LSP_TOOL = ABOOCODE_EXPERIMENTAL || truthy("ABOOCODE_EXPERIMENTAL_LSP_TOOL")
  export const ABOOCODE_DISABLE_FILETIME_CHECK = truthy("ABOOCODE_DISABLE_FILETIME_CHECK")
  export const ABOOCODE_EXPERIMENTAL_PLAN_MODE = ABOOCODE_EXPERIMENTAL || truthy("ABOOCODE_EXPERIMENTAL_PLAN_MODE")
  export const ABOOCODE_EXPERIMENTAL_MARKDOWN = truthy("ABOOCODE_EXPERIMENTAL_MARKDOWN")
  export const ABOOCODE_MODELS_URL = process.env["ABOOCODE_MODELS_URL"]
  export const ABOOCODE_MODELS_PATH = process.env["ABOOCODE_MODELS_PATH"]

  function number(key: string) {
    const value = process.env[key]
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
}

// Dynamic getter for ABOOCODE_DISABLE_PROJECT_CONFIG
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "ABOOCODE_DISABLE_PROJECT_CONFIG", {
  get() {
    return truthy("ABOOCODE_DISABLE_PROJECT_CONFIG")
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for ABOOCODE_CONFIG_DIR
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "ABOOCODE_CONFIG_DIR", {
  get() {
    return process.env["ABOOCODE_CONFIG_DIR"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for ABOOCODE_CLIENT
// This must be evaluated at access time, not module load time,
// because some commands override the client at runtime
Object.defineProperty(Flag, "ABOOCODE_CLIENT", {
  get() {
    return process.env["ABOOCODE_CLIENT"] ?? "cli"
  },
  enumerable: true,
  configurable: false,
})
