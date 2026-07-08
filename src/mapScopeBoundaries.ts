import { cleanDisplayText } from './textNormalization'

export type BoundaryRing = [number, number][]
export type BoundaryPolygon = BoundaryRing[]

export type MapScopeBoundary = {
    code: string
    query: string
    displayName: string
    polygons: BoundaryPolygon[]
    bounds: {
        south: number
        west: number
        north: number
        east: number
    }
}

export type LocalityScopeBoundary = {
    code: string
    label: string
    south: number
    west: number
    north: number
    east: number
    centerLat: number
    centerLng: number
    count: number
    localityCodes: string[]
    precincts: string[]
    polygons: BoundaryPolygon[]
}

export type MunicipalityScopeBoundary = {
    code: string
    label: string
    south: number
    west: number
    north: number
    east: number
    centerLat: number
    centerLng: number
    count: number
    localityCodes: string[]
    precincts: string[]
    countyLabels: string[]
    polygons: BoundaryPolygon[]
}

let cachedCountyBoundariesPromise: Promise<Record<string, MapScopeBoundary>> | null = null
let cachedLocalityBoundariesPromise: Promise<Record<string, LocalityScopeBoundary>> | null = null
let cachedMunicipalityBoundariesPromise: Promise<Record<string, MunicipalityScopeBoundary>> | null = null

async function fetchBoundaryFile<T>(path: string, label: string): Promise<Record<string, T>> {
    const response = await fetch(path)
    if (!response.ok) {
        throw new Error(`${label} HTTP ${response.status}`)
    }
    return response.json() as Promise<Record<string, T>>
}

function normalizeBoundaryPolygonShape(polygon: BoundaryPolygon | BoundaryRing): BoundaryPolygon {
    if (!Array.isArray(polygon) || polygon.length === 0) return []
    const first = polygon[0] as unknown
    if (Array.isArray(first) && typeof first[0] === 'number') {
        return [polygon as BoundaryRing]
    }
    return polygon as BoundaryPolygon
}

function pointInRing(lat: number, lng: number, ring: BoundaryRing) {
    if (ring.length < 3) return false

    let inside = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]
        const [xj, yj] = ring[j]
        const intersects =
            yi > lat !== yj > lat &&
            lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi

        if (intersects) inside = !inside
    }

    return inside
}

export function boundaryPolygonContainsPoint(polygons: BoundaryPolygon[] | null | undefined, lat: number, lng: number) {
    if (!polygons || polygons.length === 0) return false

    return polygons.some((rawPolygon) => {
        const polygon = normalizeBoundaryPolygonShape(rawPolygon as BoundaryPolygon | BoundaryRing)
        if (polygon.length === 0) return false
        const [outerRing, ...holes] = polygon
        if (!pointInRing(lat, lng, outerRing)) return false
        return !holes.some((holeRing) => pointInRing(lat, lng, holeRing))
    })
}

export async function fetchCountyScopeBoundaries(): Promise<Record<string, MapScopeBoundary>> {
    if (!cachedCountyBoundariesPromise) {
        cachedCountyBoundariesPromise = Promise.all([
            fetchBoundaryFile<MapScopeBoundary>('/map_scope_boundaries/counties.json', 'County boundaries'),
            fetchBoundaryFile<MapScopeBoundary>('/map_scope_boundaries/regions.json', 'Region boundaries').catch(() => ({} as Record<string, MapScopeBoundary>))
        ])
            .then(([counties, regions]) => {
                const merged = { ...regions, ...counties }
                Object.values(merged).forEach((scope) => {
                    scope.displayName = cleanDisplayText(scope.displayName || scope.query || scope.code)
                    scope.query = cleanDisplayText(scope.query || scope.displayName || scope.code)
                    scope.polygons = (scope.polygons || []).map((polygon) =>
                        normalizeBoundaryPolygonShape(polygon as BoundaryPolygon | BoundaryRing)
                    )
                })
                return merged
            })
            .catch((error) => {
                cachedCountyBoundariesPromise = null
                throw error
            })
    }

    return cachedCountyBoundariesPromise
}

export async function fetchLocalityScopeBoundaries(): Promise<Record<string, LocalityScopeBoundary>> {
    if (!cachedLocalityBoundariesPromise) {
        cachedLocalityBoundariesPromise = fetch('/map_scope_boundaries/localities.json')
            .then(async (response) => {
                if (!response.ok) {
                    throw new Error(`Locality boundaries HTTP ${response.status}`)
                }
                const payload = await response.json() as Record<string, LocalityScopeBoundary>
                Object.values(payload).forEach((scope) => {
                    scope.label = cleanDisplayText(scope.label)
                    scope.precincts = (scope.precincts || []).map((value) => cleanDisplayText(value)).filter(Boolean)
                    scope.polygons = (scope.polygons || []).map((polygon) =>
                        normalizeBoundaryPolygonShape(polygon as BoundaryPolygon | BoundaryRing)
                    )
                })
                return payload
            })
            .catch((error) => {
                cachedLocalityBoundariesPromise = null
                throw error
            })
    }

    return cachedLocalityBoundariesPromise
}

export async function fetchMunicipalityScopeBoundaries(): Promise<Record<string, MunicipalityScopeBoundary>> {
    if (!cachedMunicipalityBoundariesPromise) {
        cachedMunicipalityBoundariesPromise = fetch('/map_scope_boundaries/municipalities_official.json')
            .then(async (response) => {
                if (!response.ok) {
                    throw new Error(`Municipality boundaries HTTP ${response.status}`)
                }
                const payload = await response.json() as Record<string, MunicipalityScopeBoundary>
                Object.values(payload).forEach((scope) => {
                    scope.label = cleanDisplayText(scope.label)
                    scope.precincts = (scope.precincts || []).map((value) => cleanDisplayText(value)).filter(Boolean)
                    scope.countyLabels = (scope.countyLabels || []).map((value) => cleanDisplayText(value)).filter(Boolean)
                    scope.polygons = (scope.polygons || []).map((polygon) =>
                        normalizeBoundaryPolygonShape(polygon as BoundaryPolygon | BoundaryRing)
                    )
                })
                return payload
            })
            .catch((error) => {
                cachedMunicipalityBoundariesPromise = null
                throw error
            })
    }

    return cachedMunicipalityBoundariesPromise
}
