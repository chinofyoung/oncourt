import { describe, expect, it } from 'vitest'
import { parseSearchParams } from '@/lib/search/params'
import { manilaToday } from '@/lib/date-manila'
import { CITY_SEARCH_RADIUS_METERS, DEFAULT_CITY_SLUG, cityBySlug } from '@/lib/geo/cities'

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
      city: 'tacloban',
      date: '2026-08-15',
      hour: '14',
      sort: 'price',
      amenities: 'parking,cafe',
    })

    const tacloban = cityBySlug('tacloban')

    expect(result.citySlug).toBe('tacloban')
    expect(result.date).toBe('2026-08-15')
    expect(result.hour).toBe(14)
    expect(result.sort).toBe('price')
    expect(result.amenities).toEqual(['parking', 'cafe'])
    expect(result.filters.amenities).toEqual(['parking', 'cafe'])
    expect(result.filters.date).toBe('2026-08-15')
    expect(result.filters.hour).toBe(14)
    expect(result.filters.sort).toBe('price')
    expect(result.usingCoords).toBe(false)
    expect(result.filters.lat).toBe(tacloban.lat)
    expect(result.filters.lng).toBe(tacloban.lng)
  })

  it('takes the first value when a param arrives as a string array', () => {
    const result = parseSearchParams({ city: ['philippines', 'tacloban'] })
    expect(result.citySlug).toBe('philippines')
  })

  describe('city table', () => {
    it('lands on tacloban with no city param at all', () => {
      const result = parseSearchParams({})
      const tacloban = cityBySlug('tacloban')

      expect(DEFAULT_CITY_SLUG).toBe('tacloban')
      expect(result.citySlug).toBe('tacloban')
      expect(result.filters.lat).toBe(tacloban.lat)
      expect(result.filters.lng).toBe(tacloban.lng)
    })

    it('falls back to tacloban for a slug that is no longer in the table', () => {
      // An old bookmark carrying a slug this table no longer has must land on
      // the default, not 500 or (0, 0). `makati` used to be the example here —
      // it was a dead slug after the Metro Manila table was replaced, and
      // became a real one again when the table grew to 15 cities for the
      // player home-city field. `intramuros` is a district, never a slug in
      // this table, so it cannot come back the same way.
      const result = parseSearchParams({ city: 'intramuros' })
      expect(result.citySlug).toBe('tacloban')
      expect(result.filters.radiusMeters).toBe(CITY_SEARCH_RADIUS_METERS)
    })

    it('gives a real city the shared 12 km radius', () => {
      const result = parseSearchParams({ city: 'tacloban' })
      expect(result.filters.radiusMeters).toBe(CITY_SEARCH_RADIUS_METERS)
      expect(CITY_SEARCH_RADIUS_METERS).toBe(12_000)
    })

    /**
     * The radius is keyed off the city entry, not off "is this the default
     * slug" — the default is now a real 12 km city and the wide entry is the
     * non-default one, so the old slug test would have them exactly backwards.
     */
    it('gives philippines the nationwide 1,500 km radius', () => {
      const result = parseSearchParams({ city: 'philippines' })
      const philippines = cityBySlug('philippines')

      expect(result.citySlug).toBe('philippines')
      expect(result.filters.radiusMeters).toBe(1_500_000)
      expect(philippines.radiusMeters).toBe(1_500_000)
      expect(result.filters.lat).toBe(philippines.lat)
      expect(result.filters.lng).toBe(philippines.lng)
    })

    it('uses the 15 km coords radius regardless of the city entry', () => {
      const result = parseSearchParams({ city: 'philippines', lat: '11.24', lng: '125.0' })
      expect(result.usingCoords).toBe(true)
      expect(result.filters.radiusMeters).toBe(15_000)
    })
  })

  describe('until', () => {
    it('accepts an integer end hour strictly after the start', () => {
      const result = parseSearchParams({ hour: '14', until: '17' })
      expect(result.hour).toBe(14)
      expect(result.until).toBe(17)
      expect(result.filters.until).toBe(17)
    })

    it('accepts 24 as the end of a span that runs to midnight', () => {
      const result = parseSearchParams({ hour: '23', until: '24' })
      expect(result.until).toBe(24)
    })

    it('drops an end hour before the start', () => {
      const result = parseSearchParams({ hour: '14', until: '9' })
      expect(result.hour).toBe(14)
      expect(result.until).toBeUndefined()
      expect(result.filters.until).toBeUndefined()
    })

    it('drops an end hour equal to the start (a zero-width span)', () => {
      const result = parseSearchParams({ hour: '14', until: '14' })
      expect(result.until).toBeUndefined()
    })

    it('drops an end hour when there is no start hour', () => {
      const result = parseSearchParams({ until: '17' })
      expect(result.hour).toBeUndefined()
      expect(result.until).toBeUndefined()
      expect(result.filters.until).toBeUndefined()
    })

    it('drops an end hour when the start hour is present but invalid', () => {
      const result = parseSearchParams({ hour: '99', until: '17' })
      expect(result.hour).toBeUndefined()
      expect(result.until).toBeUndefined()
    })

    it('treats an empty until param as absent, not midnight (0)', () => {
      const result = parseSearchParams({ hour: '14', until: '' })
      expect(result.hour).toBe(14)
      expect(result.until).toBeUndefined()
    })

    it('drops a non-integer end hour', () => {
      expect(parseSearchParams({ hour: '14', until: '16.5' }).until).toBeUndefined()
      expect(parseSearchParams({ hour: '14', until: 'noon' }).until).toBeUndefined()
    })

    it('drops 0, which is below the 1..24 range and never after a start', () => {
      expect(parseSearchParams({ hour: '0', until: '0' }).until).toBeUndefined()
      expect(parseSearchParams({ hour: '14', until: '0' }).until).toBeUndefined()
    })

    it('drops 25, which is above the 1..24 range', () => {
      expect(parseSearchParams({ hour: '14', until: '25' }).until).toBeUndefined()
    })

    it('leaves until undefined when the param is absent, preserving single-hour behavior', () => {
      const result = parseSearchParams({ hour: '14' })
      expect(result.hour).toBe(14)
      expect(result.until).toBeUndefined()
      expect(result.filters.until).toBeUndefined()
    })
  })
})
