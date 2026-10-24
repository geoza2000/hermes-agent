import { type ComponentProps, useEffect, useRef } from 'react'

/** Native playback, explicitly released when a transcript card or owner goes away. */
export function AudioPlayer({ src, ...props }: ComponentProps<'audio'>) {
  const audio = useRef<HTMLAudioElement>(null)
  useEffect(() => {
    const element = audio.current

    return () => {
      if (!element) {
        return
      }

      if (!element.paused) {
        element.pause()
      }

      element.removeAttribute('src')
    }
  }, [src])

  return <audio {...props} className="w-full min-w-0" controls key={src} preload="metadata" ref={audio} src={src} />
}
