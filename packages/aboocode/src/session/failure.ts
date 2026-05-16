import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"

export namespace Failure {
  const log = Log.create({ service: "session.failure" })

  export type Category =
    | "tool_input_error"
    | "permission_denied"
    | "hook_blocked"
    | "shell_runtime_error"
    | "model_api_error"
    | "prompt_too_long"
    | "output_too_long"
    | "auth_error"
    | "mcp_connect_error"
    | "task_killed"
    | "resume_load_error"
    | "session_storage_error"
    | "unknown"

  export type RecoveryLevel = "light" | "medium" | "heavy"
  export type SuggestedAction = "retry" | "adjust" | "compact" | "escalate" | "abort" | "continue"

  export interface FailureRecord {
    category: Category
    message: string
    recoverable: boolean
    recoveryLevel: RecoveryLevel
    suggestedAction: SuggestedAction
    context: Record<string, unknown>
  }

  /**
   * Classify an error into a typed failure record.
   */
  export function classify(error: unknown): FailureRecord {
    // Handle MessageV2 error objects
    if (error && typeof error === "object" && "name" in error) {
      const named = error as { name: string; message?: string; data?: any }

      if (named.name === "ContextOverflowError" || MessageV2.ContextOverflowError.isInstance(error as any)) {
        return {
          category: "prompt_too_long",
          message: named.message ?? "Context window exceeded",
          recoverable: true,
          recoveryLevel: "medium",
          suggestedAction: "compact",
          context: { error },
        }
      }

      if (named.name === "OutputLengthError" || MessageV2.OutputLengthError.isInstance(error as any)) {
        return {
          category: "output_too_long",
          message: named.message ?? "Output length exceeded",
          recoverable: true,
          recoveryLevel: "light",
          suggestedAction: "continue",
          context: { error },
        }
      }

      if (named.name === "AuthError" || MessageV2.AuthError.isInstance(error as any)) {
        return {
          category: "auth_error",
          message: named.message ?? "Authentication error",
          recoverable: false,
          recoveryLevel: "heavy",
          suggestedAction: "escalate",
          context: { error },
        }
      }

      if (named.name === "APIError" || named.name === "AI_APICallError") {
        return {
          category: "model_api_error",
          message: named.message ?? "API error",
          recoverable: true,
          recoveryLevel: "medium",
          suggestedAction: "retry",
          context: { error },
        }
      }

      // Provider stream schema mismatches (e.g. NVIDIA/vLLM omitting
      // tool_calls[].index in OpenAI-compatible deltas) surface as
      // AI_TypeValidationError. These are transient provider quirks, not
      // a hard model failure — retry once before escalating.
      if (named.name === "AI_TypeValidationError") {
        return {
          category: "model_api_error",
          message: named.message ?? "Provider returned a chunk that failed schema validation",
          recoverable: true,
          recoveryLevel: "medium",
          suggestedAction: "retry",
          context: { error },
        }
      }

      if (named.name === "AbortedError") {
        return {
          category: "task_killed",
          message: "Task was aborted",
          recoverable: false,
          recoveryLevel: "light",
          suggestedAction: "abort",
          context: {},
        }
      }
    }

    // Handle standard Error instances
    if (error instanceof Error) {
      const msg = error.message.toLowerCase()

      if (msg.includes("permission") || msg.includes("denied") || msg.includes("not allowed")) {
        return {
          category: "permission_denied",
          message: error.message,
          recoverable: true,
          recoveryLevel: "light",
          suggestedAction: "adjust",
          context: { error: error.message },
        }
      }

      if (msg.includes("hook") || msg.includes("blocked")) {
        return {
          category: "hook_blocked",
          message: error.message,
          recoverable: true,
          recoveryLevel: "light",
          suggestedAction: "adjust",
          context: { error: error.message },
        }
      }

      if (msg.includes("mcp") || msg.includes("connection")) {
        return {
          category: "mcp_connect_error",
          message: error.message,
          recoverable: true,
          recoveryLevel: "medium",
          suggestedAction: "retry",
          context: { error: error.message },
        }
      }

      // Match storage failures by error code/path keywords, not by
      // free-text substring — schema-error payloads frequently mention
      // "storage" inside JSON dumps and would otherwise false-match.
      const errCode = (error as any).code as string | undefined
      const looksLikeStorage =
        errCode === "ENOENT" ||
        errCode === "EACCES" ||
        errCode === "EPERM" ||
        /\b(SQLITE|SqliteError|SQLITE_)/i.test(error.message) ||
        /\b(no such file or directory|disk full|out of space|read-only file system)\b/i.test(error.message)
      if (looksLikeStorage) {
        return {
          category: "session_storage_error",
          message: error.message,
          recoverable: false,
          recoveryLevel: "heavy",
          suggestedAction: "escalate",
          context: { error: error.message },
        }
      }
    }

    return {
      category: "unknown",
      message: error instanceof Error ? error.message : String(error),
      recoverable: false,
      recoveryLevel: "heavy",
      suggestedAction: "escalate",
      context: { error: String(error) },
    }
  }

  /**
   * Determine recovery action based on failure record.
   */
  export function recover(failure: FailureRecord): {
    action: "retry" | "compact" | "continue_with_message" | "stop"
    message?: string
    delay?: number
  } {
    log.info("recovering from failure", {
      category: failure.category,
      level: failure.recoveryLevel,
      action: failure.suggestedAction,
    })

    switch (failure.category) {
      case "tool_input_error":
      case "permission_denied":
      case "hook_blocked":
      case "shell_runtime_error":
        // Light recovery: return error to model as context
        return {
          action: "continue_with_message",
          message: failure.message,
        }

      case "prompt_too_long":
        // Medium recovery: trigger compaction
        return { action: "compact" }

      case "output_too_long":
        // Light recovery: inject continue message
        return {
          action: "continue_with_message",
          message: "Output limit hit. Continue exactly where you left off.",
        }

      case "model_api_error":
      case "mcp_connect_error":
        // Medium recovery: retry with backoff
        return {
          action: "retry",
          delay: 2000,
        }

      case "auth_error":
      case "task_killed":
      case "resume_load_error":
      case "session_storage_error":
      case "unknown":
        // Heavy recovery: stop and escalate
        return { action: "stop" }

      default:
        return { action: "stop" }
    }
  }
}
