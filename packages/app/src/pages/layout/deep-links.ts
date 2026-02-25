export const deepLinkEvent = "aboocode:deep-link"

export const parseDeepLink = (input: string) => {
  if (!input.startsWith("aboocode://")) return
  if (typeof URL.canParse === "function" && !URL.canParse(input)) return
  const url = (() => {
    try {
      return new URL(input)
    } catch {
      return undefined
    }
  })()
  if (!url) return
  if (url.hostname !== "open-project") return
  const directory = url.searchParams.get("directory")
  if (!directory) return
  return directory
}

export const collectOpenProjectDeepLinks = (urls: string[]) =>
  urls.map(parseDeepLink).filter((directory): directory is string => !!directory)

type AboocodeWindow = Window & {
  __ABOOCODE__?: {
    deepLinks?: string[]
  }
}

export const drainPendingDeepLinks = (target: AboocodeWindow) => {
  const pending = target.__ABOOCODE__?.deepLinks ?? []
  if (pending.length === 0) return []
  if (target.__ABOOCODE__) target.__ABOOCODE__.deepLinks = []
  return pending
}
