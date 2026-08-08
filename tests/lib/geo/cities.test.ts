import { expect, test } from 'vitest'
import { CITIES, DEFAULT_CITY_SLUG, cityBySlug } from '@/lib/geo/cities'

test('every city has a unique slug', () => {
  const slugs = CITIES.map((city) => city.slug)
  expect(new Set(slugs).size).toBe(slugs.length)
})

test('every city centroid is inside the Philippines bounding box', () => {
  for (const city of CITIES) {
    expect(city.lat, `${city.slug} lat`).toBeGreaterThan(4)
    expect(city.lat, `${city.slug} lat`).toBeLessThan(21)
    expect(city.lng, `${city.slug} lng`).toBeGreaterThan(116)
    expect(city.lng, `${city.slug} lng`).toBeLessThan(127)
  }
})

test('only wide-area entries carry a radius override', () => {
  for (const city of CITIES) {
    if (city.slug === 'philippines') expect(city.radiusMeters).toBe(1_500_000)
    else expect(city.radiusMeters).toBeUndefined()
  }
})

test('the default city is a real city in the table', () => {
  const city = cityBySlug(DEFAULT_CITY_SLUG)
  expect(city.slug).toBe('tacloban')
  expect(city.radiusMeters).toBeUndefined()
})

test('the table covers the major cities players will name', () => {
  const slugs = new Set(CITIES.map((city) => city.slug))
  for (const expected of ['quezon-city', 'manila', 'cebu-city', 'davao-city', 'tacloban', 'philippines']) {
    expect(slugs, `missing ${expected}`).toContain(expected)
  }
})
