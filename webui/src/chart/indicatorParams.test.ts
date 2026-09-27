import { describe, expect, it } from 'vitest'
import { INDICATORS } from '../test/utils'
import {
  activeOverrides,
  editableParams,
  effectiveParams,
  paramSummary,
  parseParam,
  seedParamDraft,
} from './indicatorParams'

describe('parseParam', () => {
  const int = { kind: 'int' as const, low: 2, high: 100 }
  const float = { kind: 'float' as const, low: 0.5, high: 4 }

  it('reads an int within its range', () => {
    expect(parseParam(' 21 ', 14, int)).toEqual({ ok: true, value: 21 })
    expect(parseParam('2.5', 14, int)).toEqual({ ok: false, error: 'integer' })
    expect(parseParam('101', 14, int)).toEqual({ ok: false, error: 'range' })
    expect(parseParam('', 14, int)).toEqual({ ok: false, error: 'required' })
    expect(parseParam('abc', 14, int)).toEqual({ ok: false, error: 'number' })
  })

  it('treats a float default that JSON turned into a whole number as a float', () => {
    // Python's `2.0` arrives as `2`; the spec, not the value, says float.
    expect(parseParam('2.5', 2, float)).toEqual({ ok: true, value: 2.5 })
    expect(parseParam('Infinity', 2, float)).toEqual({ ok: false, error: 'number' })
  })

  it('maps booleans and categorical choices back to the declared value', () => {
    expect(parseParam('false', true, undefined)).toEqual({ ok: true, value: false })
    const choices = { kind: 'categorical' as const, choices: ['sma', 'ema'] }
    expect(parseParam('ema', 'sma', choices)).toEqual({ ok: true, value: 'ema' })
    expect(parseParam('wma', 'sma', choices)).toEqual({ ok: false, error: 'choice' })
  })
})

describe('the helpers the picker reads', () => {
  // `lots` is left out of `space`; `source` is in it, but a `None` default
  // has no input that could hold it.
  const ma = {
    ...INDICATORS[0],
    params: { fast: 5, slow: 20, source: null, lots: 1 },
    space: { ...INDICATORS[0].space, source: { kind: 'int' as const, low: 1, high: 3 } },
  }

  it('offers only params in `space` that an input can hold', () => {
    expect(editableParams(ma)).toEqual(['fast', 'slow'])
    expect(editableParams({ ...ma, space: {} })).toEqual([])
  })

  it('leaves params outside `space` out of the draft and the values a run sends', () => {
    expect(seedParamDraft(ma, { fast: 8, lots: 3 })).toEqual({ fast: '8', slow: '20' })
    expect(effectiveParams(ma, { fast: '8', slow: '20', lots: '3' })).toEqual({
      ok: true,
      params: { fast: 8, slow: 20 },
      errors: {},
    })
  })

  it('keeps only overrides the class still declares', () => {
    expect(activeOverrides(ma, { fast: 8, window: 9, lots: 3 })).toEqual({ fast: 8 })
    expect(activeOverrides(ma, 'garbage')).toEqual({})
    expect(activeOverrides(ma, [1, 2])).toEqual({})
  })

  it('summarises the effective values in declared order', () => {
    expect(paramSummary(ma, { slow: 30 })).toBe('5, 30')
  })
})
