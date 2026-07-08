import {
    getLocalityCodeFromParcelId,
    getLocalityLabelFromCode,
    getParcelNumberFromIdentifier
} from './localityCatalog'
import type { PiekoszowParcel } from './piekoszowParcels'

const ULDK_URL = 'https://uldk.gugik.gov.pl/'
const ULDK_PARCEL_FIELDS = 'id,voivodeship,county,commune,region,parcel,geom_wkt,geom_extent'

const parcelByIdCache = new Map<string, Promise<PiekoszowParcel | null>>()
const parcelByPointCache = new Map<string, Promise<PiekoszowParcel | null>>()

function sanitizeAdministrativeLabel(value?: string | null) {
    const normalized = `${value || ''}`.trim()
    if (!normalized) return undefined

    const comparable = normalized
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()

    if (/^\d+(?:[./-]\d+)*$/.test(normalized)) return undefined
    if (/^obr(?:\.|eb|ęb)?\s*\d+(?:[./-]\d+)*$/.test(comparable)) return undefined
    if (/^unknown::/.test(comparable)) return undefined
    return normalized
}

function parseDelimitedResponse(raw: string): string[] | null {
    const normalized = `${raw || ''}`.replace(/^\uFEFF/, '').trim()
    if (!normalized) return null

    const lines = normalized
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

    if (lines[0] !== '0' || !lines[1]) return null
    return lines[1].split('|')
}

function parseExtent(extent: string): { south: number; west: number; north: number; east: number } | null {
    const values = `${extent || ''}`.split(',').map((value) => Number(value.trim()))
    if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) return null

    const [west, south, east, north] = values
    return { south, west, north, east }
}

function calculateRingArea(ring: [number, number][]) {
    if (ring.length < 4) return 0

    let area = 0
    for (let index = 0; index < ring.length - 1; index += 1) {
        const [x1, y1] = ring[index]
        const [x2, y2] = ring[index + 1]
        area += (x1 * y2) - (x2 * y1)
    }

    return area / 2
}

function parseRingCoordinates(raw: string): [number, number][] {
    return raw
        .split(',')
        .map((point) => {
            const coords = point.trim().split(/\s+/).map((value) => Number(value))
            if (coords.length < 2 || coords.some((value) => !Number.isFinite(value))) return null
            return [coords[0], coords[1]] as [number, number]
        })
        .filter((point): point is [number, number] => Boolean(point))
}

function parseWktRings(wkt: string): [number, number][][] {
    const normalized = `${wkt || ''}`.trim()
    if (!normalized) return []

    const geometryText = normalized.includes(';') ? normalized.slice(normalized.indexOf(';') + 1).trim() : normalized
    const upper = geometryText.toUpperCase()
    const targetDepth = upper.startsWith('MULTIPOLYGON') ? 3 : upper.startsWith('POLYGON') ? 2 : 0
    if (targetDepth === 0) return []

    const bodyStart = geometryText.indexOf('(')
    if (bodyStart < 0) return []

    const body = geometryText.slice(bodyStart)
    const rings: [number, number][][] = []
    let depth = 0
    let segmentStart = -1

    for (let index = 0; index < body.length; index += 1) {
        const char = body[index]
        if (char === '(') {
            depth += 1
            if (depth === targetDepth) {
                segmentStart = index + 1
            }
            continue
        }

        if (char !== ')') continue

        if (depth === targetDepth && segmentStart >= 0) {
            const ring = parseRingCoordinates(body.slice(segmentStart, index))
            if (ring.length >= 4) rings.push(ring)
            segmentStart = -1
        }

        depth -= 1
    }

    return rings
}

function choosePrimaryRing(rings: [number, number][][]) {
    if (rings.length === 0) return [] as [number, number][]
    return [...rings].sort((left, right) => Math.abs(calculateRingArea(right)) - Math.abs(calculateRingArea(left)))[0]
}

async function fetchUldkText(params: Record<string, string>) {
    const url = new URL(ULDK_URL)
    Object.entries(params).forEach(([key, value]) => {
        url.searchParams.set(key, value)
    })

    const response = await fetch(url.toString(), {
        signal: AbortSignal.timeout(15_000)
    })
    if (!response.ok) {
        throw new Error(`ULDK HTTP ${response.status}`)
    }

    return response.text()
}

function buildParcelFromResponse(fields: string[] | null): PiekoszowParcel | null {
    if (!fields || fields.length < 8) return null

    const [id, voivodeship, county, commune, region, parcelRaw, geomWkt, geomExtent] = fields
    const normalizedId = `${id || ''}`.trim()
    if (!normalizedId) return null

    const coords = choosePrimaryRing(parseWktRings(geomWkt))
    const parsedExtent = parseExtent(geomExtent)

    let south = parsedExtent?.south ?? Number.POSITIVE_INFINITY
    let west = parsedExtent?.west ?? Number.POSITIVE_INFINITY
    let north = parsedExtent?.north ?? Number.NEGATIVE_INFINITY
    let east = parsedExtent?.east ?? Number.NEGATIVE_INFINITY

    if (!parsedExtent && coords.length > 0) {
        coords.forEach(([lng, lat]) => {
            south = Math.min(south, lat)
            west = Math.min(west, lng)
            north = Math.max(north, lat)
            east = Math.max(east, lng)
        })
    }

    if (![south, west, north, east].every(Number.isFinite)) return null

    const parcelNumber = `${parcelRaw || getParcelNumberFromIdentifier(normalizedId) || ''}`.trim() || getParcelNumberFromIdentifier(normalizedId)
    const localityCode = getLocalityCodeFromParcelId(normalizedId) || undefined
    const municipality = `${commune || ''}`.trim() || undefined
    const precinct = sanitizeAdministrativeLabel(`${region || ''}`.trim())
    const localityFromCode = sanitizeAdministrativeLabel(getLocalityLabelFromCode(localityCode) || undefined)
    const municipalityLabel = sanitizeAdministrativeLabel(municipality)

    return {
        id: normalizedId,
        label: parcelNumber || normalizedId,
        shortLabel: parcelNumber || getParcelNumberFromIdentifier(normalizedId),
        parcelNumber: parcelNumber || getParcelNumberFromIdentifier(normalizedId),
        localityCode,
        localityLabel: precinct || localityFromCode || municipalityLabel || undefined,
        municipality,
        precinct,
        county: `${county || ''}`.trim() || undefined,
        voivodeship: `${voivodeship || ''}`.trim() || undefined,
        centerLat: (south + north) / 2,
        centerLng: (west + east) / 2,
        south,
        west,
        north,
        east,
        coords,
        source: 'live'
    }
}

function buildPointCacheKey(lat: number, lng: number) {
    return `${lat.toFixed(6)}|${lng.toFixed(6)}`
}

export async function fetchUldkParcelGeometryById(parcelId: string): Promise<PiekoszowParcel | null> {
    const normalizedId = `${parcelId || ''}`.trim()
    if (!normalizedId) return null

    const cached = parcelByIdCache.get(normalizedId)
    if (cached) return cached

    const request = fetchUldkText({
        request: 'GetParcelById',
        id: normalizedId,
        result: ULDK_PARCEL_FIELDS,
        srid: '4326'
    })
        .then(parseDelimitedResponse)
        .then(buildParcelFromResponse)
        .catch(() => null)

    parcelByIdCache.set(normalizedId, request)
    return request
}

export async function fetchUldkParcelByCoordinates(lat: number, lng: number): Promise<PiekoszowParcel | null> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null

    const cacheKey = buildPointCacheKey(lat, lng)
    const cached = parcelByPointCache.get(cacheKey)
    if (cached) return cached

    // ULDK expects X,Y in the query string, so for EPSG:4326 this is lng,lat.
    const request = fetchUldkText({
        request: 'GetParcelByXY',
        xy: `${lng},${lat},4326`,
        result: ULDK_PARCEL_FIELDS,
        srid: '4326'
    })
        .then(parseDelimitedResponse)
        .then(buildParcelFromResponse)
        .catch(() => null)

    parcelByPointCache.set(cacheKey, request)
    return request
}
