import { describe, it, expect } from 'vitest'
import {
  MIN_RANK_GAP,
  RANK_STEP,
  compareByRank,
  needsRebalance,
  planDrop,
  rankBetween,
  rebalanceRanks,
} from './rank'

describe('rankBetween', () => {
  it('takes the midpoint of two neighbours', () => {
    expect(rankBetween(10, 4)).toBe(7)
  })
  it('goes above the top card / below the bottom card', () => {
    expect(rankBetween(null, 4)).toBe(4 + RANK_STEP)
    expect(rankBetween(10, null)).toBe(10 - RANK_STEP)
  })
  it('uses the clock for an empty column', () => {
    expect(rankBetween(null, null, 1234)).toBe(1234)
  })
})

describe('needsRebalance', () => {
  it('is false at the ends of a column and for a healthy gap', () => {
    expect(needsRebalance(null, 5)).toBe(false)
    expect(needsRebalance(5, null)).toBe(false)
    expect(needsRebalance(10, 5)).toBe(false)
  })
  it('is true when neighbours are too close to halve again', () => {
    expect(needsRebalance(5 + MIN_RANK_GAP / 2, 5)).toBe(true)
    expect(needsRebalance(5, 5)).toBe(true)
  })
  it('a run of midpoints eventually asks for a rebalance', () => {
    let above = 1_790_000_000
    const below = above - 1
    let steps = 0
    while (!needsRebalance(above, below) && steps < 100) {
      above = rankBetween(above, below)
      steps += 1
    }
    expect(steps).toBeGreaterThan(5)
    expect(steps).toBeLessThan(100)
  })
})

describe('rebalanceRanks', () => {
  it('spreads ranks evenly inside the range they already span', () => {
    const out = rebalanceRanks([10, 9.99999, 9.99998, 0])
    expect(out[0]).toBe(10)
    expect(out[1]).toBeCloseTo(20 / 3, 9)
    expect(out[2]).toBeCloseTo(10 / 3, 9)
    expect(out[3]).toBeCloseTo(0, 9)
  })
  it('keeps the order strictly descending, so cards outside the range keep their place', () => {
    const out = rebalanceRanks([100, 100, 100, 50])
    expect(out[0]).toBe(100)
    expect(out[3]).toBeCloseTo(50, 9)
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeLessThan(out[i - 1])
  })
  it('spreads a column of identical ranks by one step', () => {
    expect(rebalanceRanks([5, 5, 5])).toEqual([5, 4, 3])
  })
  it('handles empty and single columns', () => {
    expect(rebalanceRanks([])).toEqual([])
    expect(rebalanceRanks([7])).toEqual([7])
  })
})

describe('planDrop', () => {
  const ranks = [30, 20, 10]
  it('drops between two cards', () => {
    expect(planDrop(ranks, 1)).toEqual({ rank: 25, rebalance: false })
    expect(planDrop(ranks, 2)).toEqual({ rank: 15, rebalance: false })
  })
  it('drops at the top and the bottom', () => {
    expect(planDrop(ranks, 0).rank).toBe(31)
    expect(planDrop(ranks, 3).rank).toBe(9)
  })
  it('clamps an out-of-range index', () => {
    expect(planDrop(ranks, 99).rank).toBe(9)
    expect(planDrop(ranks, -4).rank).toBe(31)
  })
  it('an empty column takes the given clock', () => {
    expect(planDrop([], 0, 555)).toEqual({ rank: 555, rebalance: false })
  })
  it('flags neighbours that are too close', () => {
    expect(planDrop([5.00001, 5], 1).rebalance).toBe(true)
  })
})

describe('compareByRank', () => {
  const row = (id: string, board_rank: number | undefined, created_at = '2026-01-01') => ({
    id,
    board_rank,
    created_at,
  })
  it('puts the highest rank first', () => {
    const rows = [row('a', 1), row('b', 3), row('c', 2)]
    expect(rows.sort(compareByRank).map((r) => r.id)).toEqual(['b', 'c', 'a'])
  })
  it('breaks ties by newest then id', () => {
    const rows = [row('a', 1, '2026-01-01'), row('b', 1, '2026-02-01'), row('c', 1, '2026-02-01')]
    expect(rows.sort(compareByRank).map((r) => r.id)).toEqual(['b', 'c', 'a'])
  })
})
