export namespace SessionLimits {
  /**
   * Default cap on loop steps per user prompt when the agent config does not
   * set `steps`. Generous enough that legitimate long tasks never hit it —
   * its only job is to bound runaway loops the doom-loop detector misses.
   */
  export const DEFAULT_MAX_STEPS = 400

  export function resolveMaxSteps(steps?: number) {
    return steps ?? DEFAULT_MAX_STEPS
  }
}
