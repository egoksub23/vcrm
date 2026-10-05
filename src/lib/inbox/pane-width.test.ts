import { describe, expect, it } from 'vitest'

import { clampPaneWidth, draggedPaneWidth, steppedPaneWidth } from './pane-width'

describe('clampPaneWidth', () => {
  it('stays between the minimum and the room there is', () => {
    expect(clampPaneWidth(100, 240, 600)).toBe(240)
    expect(clampPaneWidth(900, 240, 600)).toBe(600)
    expect(clampPaneWidth(400, 240, 600)).toBe(400)
  })

  it('keeps the minimum when the screen has less room than that', () => {
    expect(clampPaneWidth(400, 240, 100)).toBe(240)
  })
})

describe('draggedPaneWidth', () => {
  it('widens a panel before the divider when dragged right', () => {
    expect(draggedPaneWidth(400, 500, 560, 1, 280, 900)).toBe(460)
  })

  it('widens a panel after the divider when dragged left', () => {
    expect(draggedPaneWidth(280, 800, 740, -1, 240, 900)).toBe(340)
    expect(draggedPaneWidth(280, 800, 860, -1, 240, 900)).toBe(240)
  })

  it('never passes the limits however far the pointer goes', () => {
    expect(draggedPaneWidth(400, 500, 5000, 1, 280, 700)).toBe(700)
    expect(draggedPaneWidth(400, 500, -5000, 1, 280, 700)).toBe(280)
  })
})

describe('steppedPaneWidth', () => {
  it('moves the divider the way the arrow points', () => {
    expect(steppedPaneWidth(400, 'ArrowRight', 1, 280, 900)).toBe(416)
    expect(steppedPaneWidth(400, 'ArrowLeft', 1, 280, 900)).toBe(384)
    expect(steppedPaneWidth(300, 'ArrowLeft', -1, 240, 900)).toBe(316)
  })
})
