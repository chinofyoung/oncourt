import { describe, expect, it } from 'vitest'
import { parseSearchParams } from '@/lib/search/params'
import { manilaToday } from '@/lib/date-manila'
import { DEFAULT_CITY_SLUG, cityBySlug } from '@/lib/geo/cities'

describe('parseSearchParams', () => {
  it('treats an empty hour param as absent, not midnight (0)', () => {
    const result = parseSearchParams({ hour: '' })
    expect(result.hour).toBeUndefined()
    expect(typeof result.hour).toBe('undefined')
    expect(result.filters.hour).toBeUndefined()
  })

  it('treats empty lat/lng as absent and falls back to the default city coords, not (0, 0)', () => {
    const result = parseSearchParams({ lat: '', lng: '' })
    const defaultCity = cityBySlug(DEFAULT_CITY_SLUG)

    expect(result.usingCoords).toBeFalsy()
    expect(result.filters.lat).toBe(defaultCity.lat)
    expect(result.filters.lng).toBe(defaultCity.lng)
  })

  it('treats an empty max param as absent', () => {
    const result = parseSearchParams({ max: '' })
    expect(result.maxPriceCentavos).toBeUndefined()
    expect(result.filters.maxPriceCentavos).toBeUndefined()
  })

  it('falls back to safe defaults for a garbage URL with every param broken at once', () => {
    const result = parseSearchParams({
      date: 'lol',
      hour: '99',
      city: 'nope',
      sort: 'bogus',
      max: '-5',
      amenities: 'drone-delivery',
    })

    expect(result.date).toBe(manilaToday())
    expect(result.hour).toBeUndefined()
    expect(result.citySlug).toBe(DEFAULT_CITY_SLUG)
    expect(result.sort).toBe('distance')
    expect(result.maxPriceCentavos).toBeUndefined()
    expect(result.amenities).toEqual([])
    expect(result.filters.amenities).toBeUndefined()
  })

  it('passes fully-valid input through unchanged', () => {
    const result = parseSearchParams({
      city: 'makati',
      date: '2026-08-15',
      hour: '14',
      sort: 'price',
      amenities: 'parking,cafe',
    })

    const makati = cityBySlug('makati')

    expect(result.citySlug).toBe('makati')
    expect(result.date).toBe('2026-08-15')
    expect(result.hour).toBe(14)
    expect(result.sort).toBe('price')
    expect(result.amenities).toEqual(['parking', 'cafe'])
    expect(result.filters.amenities).toEqual(['parking', 'cafe'])
    expect(result.filters.date).toBe('2026-08-15')
    expect(result.filters.hour).toBe(14)
    expect(result.filters.sort).toBe('price')
    expect(result.usingCoords).toBe(false)
    expect(result.filters.lat).toBe(makati.lat)
    expect(result.filters.lng).toBe(makati.lng)
  })

  it('takes the first value when a param arrives as a string array', () => {
    const result = parseSearchParams({ city: ['makati', 'quezon-city'] })
    expect(result.citySlug).toBe('makati')
  })
})
