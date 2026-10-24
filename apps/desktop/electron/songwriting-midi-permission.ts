interface MidiRequester {
  type: string
  url: string
}
interface MidiRequestDetails {
  isMainFrame?: boolean
  requestingUrl?: string
}

/** Both Electron hooks must prove a top-level app renderer, not just its origin. */
export function isSongwritingMidiPermission(
  permission: string,
  requester: MidiRequester | null,
  details: MidiRequestDetails | undefined,
  rendererUrl: string
): boolean {
  if (permission !== 'midi' || requester?.type !== 'window' || details?.isMainFrame !== true) {
    return false
  }

  try {
    const expected = new URL(rendererUrl)

    const matches = (value: string) => {
      const url = new URL(value)

      return url.protocol === expected.protocol && url.host === expected.host && url.pathname === expected.pathname
    }

    return matches(requester.url) && matches(details.requestingUrl ?? '')
  } catch {
    return false
  }
}
