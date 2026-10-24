import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { AudioPlayer } from './audio-player'

it('replaces a playing source without clearing the new source and releases both elements', () => {
  const view = render(<AudioPlayer aria-label="Source preview" src="blob:take-a" />)
  const first = screen.getByLabelText('Source preview') as HTMLAudioElement
  Object.defineProperty(first, 'paused', { value: false })
  const pauseFirst = vi.spyOn(first, 'pause').mockImplementation(() => undefined)

  view.rerender(<AudioPlayer aria-label="Source preview" src="blob:take-b" />)
  const second = screen.getByLabelText('Source preview') as HTMLAudioElement
  expect(second.getAttribute('src')).toBe('blob:take-b')
  expect(pauseFirst).toHaveBeenCalledTimes(1)
  expect(first.getAttribute('src')).toBeNull()

  Object.defineProperty(second, 'paused', { value: false })
  const pauseSecond = vi.spyOn(second, 'pause').mockImplementation(() => undefined)
  view.unmount()
  expect(pauseSecond).toHaveBeenCalledTimes(1)
  expect(second.getAttribute('src')).toBeNull()
})
