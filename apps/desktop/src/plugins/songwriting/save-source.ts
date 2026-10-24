import type { createSongwritingApi, SongProject } from './api'
import { audioBody, type PendingSource } from './use-capture'

interface SaveSourceOptions {
  api: ReturnType<typeof createSongwritingApi>
  source: PendingSource
  onReceipt: (source: PendingSource) => void
  missingMessage: string
}

/** A successful write is retained even when its independent verification fails. */
export async function saveAndVerifySource({
  api,
  source,
  onReceipt,
  missingMessage
}: SaveSourceOptions): Promise<SongProject> {
  let receipt = source

  if (!receipt.savedPath) {
    const result =
      source.take.kind === 'midi'
        ? await api.saveMidi(source.take)
        : await api.saveAudio(await audioBody(source.take.blob, source.take.name))

    receipt = { ...source, savedPath: result.capturePath, verified: false }
    onReceipt(receipt)
  }

  const project = await api.project()

  if (!project.captures.some(capture => capture.path === receipt.savedPath)) {
    throw new Error(missingMessage)
  }

  onReceipt({ ...receipt, verified: true })

  return project
}
