import { describe, expect, it } from 'vitest'
import { dragHasFiles, droppedImages, imageFilesOf, pastedImages } from './clipboard-images'

const f = (name: string, type: string) => new File(['x'], name, { type })

describe('imageFilesOf', () => {
  it('picks the images and keeps their order', () => {
    const files = [f('a.png', 'image/png'), f('b.pdf', 'application/pdf'), f('c.jpg', 'IMAGE/JPEG')]
    expect(imageFilesOf(files).map((x) => x.name)).toEqual(['a.png', 'c.jpg'])
  })
  it('copes with nothing at all', () => {
    expect(imageFilesOf(null)).toEqual([])
    expect(imageFilesOf(undefined)).toEqual([])
    expect(imageFilesOf([])).toEqual([])
  })
})

describe('pastedImages', () => {
  it('takes a screenshot or "Copy image" (an image and no text)', () => {
    expect(pastedImages([f('image.png', 'image/png')], '')).toHaveLength(1)
    expect(pastedImages([f('image.png', 'image/png')], null)).toHaveLength(1)
    expect(pastedImages([f('image.png', 'image/png')], '   \n')).toHaveLength(1)
  })
  it('leaves a paste that carries text alone: text or cells copied from PowerPoint / Excel come with a picture of themselves', () => {
    expect(pastedImages([f('image.png', 'image/png')], 'Quarterly results\tQ1\tQ2')).toEqual([])
  })
  it('stacks several pictures in order', () => {
    expect(pastedImages([f('1.png', 'image/png'), f('2.png', 'image/png')], '').map((x) => x.name)).toEqual(['1.png', '2.png'])
  })
  it('ignores a paste of other files', () => {
    expect(pastedImages([f('a.pdf', 'application/pdf')], '')).toEqual([])
    expect(pastedImages([], '')).toEqual([])
  })
})

describe('droppedImages / dragHasFiles', () => {
  it('takes dropped image files and ignores the rest', () => {
    expect(droppedImages([f('a.png', 'image/png'), f('b.txt', 'text/plain')]).map((x) => x.name)).toEqual(['a.png'])
    expect(droppedImages(null)).toEqual([])
  })
  it('tells a file drag from a text or link drag', () => {
    expect(dragHasFiles(['text/plain', 'Files'])).toBe(true)
    expect(dragHasFiles(['text/plain', 'text/uri-list'])).toBe(false)
    expect(dragHasFiles(null)).toBe(false)
  })
})
