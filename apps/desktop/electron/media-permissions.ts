import type { Session } from 'electron'

import { isHermesHubClipboardWrite } from './hub-iframe-policy'
import { isMediaCapturePermission } from './media-capture-permission'
import { isSongwritingMidiPermission } from './songwriting-midi-permission'

/** Install both Chromium permission paths together so their MIDI boundary cannot drift. */
export function installMediaPermissions(
  permissionSession: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>,
  rendererUrl: string
) {
  // Clipboard writes retain the exact Skills Hub-origin carve-out; other frames stay denied.
  permissionSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if ((permission as string) === 'clipboard-sanitized-write') {
      callback(isHermesHubClipboardWrite(focusedFrameOrigin(webContents)))

      return
    }

    // Chromium requests every Web MIDI grant as `midiSysex`, `{sysex: false}` included, so the
    // request name cannot separate sysex: the trusted main-frame proof is this hook's whole boundary.
    if (permission === 'midi' || permission === 'midiSysex') {
      callback(
        isSongwritingMidiPermission(
          'midi',
          webContents ? { type: webContents.getType(), url: webContents.getURL() } : null,
          details,
          rendererUrl
        )
      )

      return
    }

    callback(isMediaCapturePermission(permission, details))
  })

  // Windows capture also consults this synchronous hook. Media's missing-metadata
  // fallback is unchanged; MIDI must still prove its main frame and requesting URL.
  permissionSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    if ((permission as string) === 'midi' || (permission as string) === 'midiSysex') {
      return isSongwritingMidiPermission(
        permission,
        webContents ? { type: webContents.getType(), url: webContents.getURL() } : null,
        details,
        rendererUrl
      )
    }

    if ((permission as string) === 'clipboard-sanitized-write') {
      return isHermesHubClipboardWrite(focusedFrameOrigin(webContents))
    }

    return isMediaCapturePermission(permission, undefined)
  })
}

function focusedFrameOrigin(
  webContents: { getURL?: () => string } | null | undefined,
  details?: { requestingUrl?: string }
): string | null {
  try {
    if (details?.requestingUrl) {
      return new URL(details.requestingUrl).origin
    }

    if (webContents?.getURL) {
      return new URL(webContents.getURL()).origin
    }
  } catch {
    // Unparseable URL — report no origin; callers deny.
  }

  return null
}
