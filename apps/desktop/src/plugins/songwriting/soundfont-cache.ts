import type { createSoundFontApi, SoundFontStatus } from './api'

/** The instrument bank, fetched from the gateway once and then kept in this window's IndexedDB.
 *  Every load is checked against the pinned SHA-256, cached or not. */

const DB = 'hermes-songwriting'
const STORE = 'soundfonts'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function cached(sha256: string): Promise<ArrayBuffer | null> {
  try {
    const db = await open()

    return await new Promise(resolve => {
      const request = db.transaction(STORE).objectStore(STORE).get(sha256)
      request.onsuccess = () => resolve(request.result instanceof ArrayBuffer ? request.result : null)
      request.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

async function remember(sha256: string, buffer: ArrayBuffer) {
  try {
    const db = await open()
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(buffer, sha256)
  } catch {
    // A missing cache only means the next launch fetches from the gateway again.
  }
}

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer)

  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function loadSoundFont(
  api: ReturnType<typeof createSoundFontApi>,
  status: SoundFontStatus,
  onProgress: (fraction: number) => void
): Promise<ArrayBuffer> {
  const hit = await cached(status.sha256)

  if (hit && (await sha256Hex(hit)) === status.sha256) {
    onProgress(1)

    return hit
  }

  const bytes = new Uint8Array(status.size)
  let done = 0

  // A few chunks in flight keeps local IPC busy without holding the whole bank as base64 at once.
  const queue = Array.from({ length: status.chunks }, (_, index) => index)

  const worker = async () => {
    for (let index = queue.shift(); index !== undefined; index = queue.shift()) {
      const chunk = await api.chunk(index)
      bytes.set(chunk, index * status.chunkSize)
      onProgress(++done / status.chunks)
    }
  }

  await Promise.all([worker(), worker(), worker()])

  if ((await sha256Hex(bytes.buffer)) !== status.sha256) {
    throw new Error('The instrument bank failed verification; try again')
  }

  await remember(status.sha256, bytes.buffer)

  return bytes.buffer
}
