import L from 'leaflet'
import {
    getLocalityCodeFromParcelId,
    getLocalityLabelFromCode,
    getParcelNumberFromIdentifier
} from './localityCatalog'
import { fetchDynamicParcelsForBounds, findDynamicParcelById } from './dynamicParcels'
import { getAllGeoportalParcels, lookupGeoportalParcelByPoint } from './geoportalParcels'
import { fetchUldkParcelByCoordinates, fetchUldkParcelGeometryById } from './uldkParcels'
import { isLocalOnlyMapDataEnabled } from './mapDataMode'
import { fetchParcelTileIndex, parseParcelTileKey, type ParcelTileIndex } from './parcelTileIndex'

export type MapBounds = {
    south: number
    west: number
    north: number
    east: number
}

export interface PiekoszowParcel {
    id: string
    label: string
    shortLabel: string
    parcelNumber: string
    localityCode?: string
    localityLabel?: string
    centerLat: number
    centerLng: number
    south: number
    west: number
    north: number
    east: number
    coords: [number, number][]
    municipality?: string
    precinct?: string
    county?: string
    voivodeship?: string
    addressResolved?: string
    source?: 'local' | 'live'
}

function sanitizeParcelAdminLabel(value?: unknown) {
    const text = `${value || ''}`.trim()
    if (!text) return undefined
    if (/^\d+(?:[./-]\d+)*$/.test(text)) return undefined
    if (/^obr(?:\.|eb|ęb)?\s*\d+(?:[./-]\d+)*$/i.test(text.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) return undefined
    if (/^unknown::/i.test(text)) return undefined
    return text
}

type ParcelCollection = {
    features?: Array<{
        properties?: Record<string, unknown>
    }>
}

type ParcelFetchOptions = {
    localityCodes?: string[] | null
    precincts?: string[] | null
}

type ParcelPointLookupOptions = {
    exactOnly?: boolean
}

export interface ParcelLocalitySummary {
    code: string
    label: string
    south: number
    west: number
    north: number
    east: number
    count: number
    localityCodes: string[]
    precincts: string[]
    municipalities: string[]
    countyLabels: string[]
}

export interface ParcelRegionSummary {
    key: string
    label: string
    regionType: 'municipal-seat' | 'locality'
    south: number
    west: number
    north: number
    east: number
    centerLat: number
    centerLng: number
    count: number
    coords: [number, number][][]
    localityCodes: string[]
    precincts: string[]
}

export interface ParcelMunicipalitySummary {
    code: string
    label: string
    south: number
    west: number
    north: number
    east: number
    centerLat: number
    centerLng: number
    count: number
    coords: [number, number][][]
    localityCodes: string[]
    precincts: string[]
    countyLabels: string[]
}

const PARCEL_TILES_DIR = '/parcel_tiles'
const PARCEL_TILE_DEG = 0.05

let cachedParcelLocalities: ParcelLocalitySummary[] | null = null
let cachedParcelRegions: ParcelRegionSummary[] | null = null
let cachedParcelPrecincts: string[] | null = null
let cachedParcelMunicipalities: ParcelMunicipalitySummary[] | null = null
let allLocalParcelsPromise: Promise<PiekoszowParcel[]> | null = null
let allKnownParcelsPromise: Promise<PiekoszowParcel[]> | null = null
let knownParcelByIdPromise: Promise<Map<string, PiekoszowParcel>> | null = null
let parcelTileIndexPromise: Promise<ParcelTileIndex> | null = null
const VISIBLE_PARCEL_CACHE_LIMIT = 24
const visibleParcelCache = new Map<string, Promise<PiekoszowParcel[]>>()
const parcelTileCache = new Map<string, Promise<PiekoszowParcel[]>>()
const DYNAMIC_PARCEL_AUGMENT_MIN_ZOOM = 15

async function getParcelTileIndex() {
    if (!parcelTileIndexPromise) {
        parcelTileIndexPromise = fetchParcelTileIndex().catch((error) => {
            parcelTileIndexPromise = null
            throw error
        })
    }

    return parcelTileIndexPromise
}

function normalizeParcelText(value: string) {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
}

function resolveParcelRegionLabel(parcel: Pick<PiekoszowParcel, 'precinct' | 'localityLabel' | 'localityCode'>) {
    return `${parcel.precinct || parcel.localityLabel || parcel.localityCode || 'Bez rejonu'}`.trim() || 'Bez rejonu'
}

function resolveParcelRegionType(label: string): ParcelRegionSummary['regionType'] {
    return normalizeParcelText(label) === 'piekoszow' ? 'municipal-seat' : 'locality'
}

function roundForCache(value: number) {
    return value.toFixed(5)
}

function rememberVisibleParcelCache(key: string, value: Promise<PiekoszowParcel[]>) {
    if (visibleParcelCache.has(key)) visibleParcelCache.delete(key)
    visibleParcelCache.set(key, value)

    if (visibleParcelCache.size <= VISIBLE_PARCEL_CACHE_LIMIT) return
    const oldestKey = visibleParcelCache.keys().next().value
    if (oldestKey) visibleParcelCache.delete(oldestKey)
}

function buildVisibleParcelCacheKey(map: L.Map, bounds: MapBounds, options?: ParcelFetchOptions) {
    const size = map.getSize()
    const localityKey = [...(options?.localityCodes || [])].sort().join(',')
    const precinctKey = [...(options?.precincts || [])].sort().join(',')
    return [
        map.getZoom(),
        size.x,
        size.y,
        roundForCache(bounds.south),
        roundForCache(bounds.west),
        roundForCache(bounds.north),
        roundForCache(bounds.east),
        localityKey,
        precinctKey
    ].join('|')
}

function intersectsBounds(bounds: MapBounds, parcel: Pick<PiekoszowParcel, 'south' | 'west' | 'north' | 'east'>, padding = 0) {
    return (
        parcel.north >= bounds.south - padding &&
        parcel.south <= bounds.north + padding &&
        parcel.east >= bounds.west - padding &&
        parcel.west <= bounds.east + padding
    )
}

function filterVisibleParcels(bounds: MapBounds, parcels: PiekoszowParcel[], options?: ParcelFetchOptions) {
    const padding = 0.0025
    if (options?.precincts && options.precincts.length === 0) {
        return []
    }

    const localityCodes = new Set(options?.localityCodes || [])
    const precincts = new Set((options?.precincts || []).map((value) => normalizeParcelText(value)))

    return parcels.filter((parcel) =>
        (localityCodes.size === 0 || (parcel.localityCode && localityCodes.has(parcel.localityCode))) &&
        (precincts.size === 0 || precincts.has(normalizeParcelText(parcel.precinct || parcel.localityLabel || ''))) &&
        parcel.north >= bounds.south - padding &&
        parcel.south <= bounds.north + padding &&
        parcel.east >= bounds.west - padding &&
        parcel.west <= bounds.east + padding
    )
}

function containsPoint(bounds: MapBounds, lat: number, lng: number, padding = 0) {
    return (
        lat >= bounds.south - padding &&
        lat <= bounds.north + padding &&
        lng >= bounds.west - padding &&
        lng <= bounds.east + padding
    )
}

function buildFallbackRegionPolygon(bounds: Pick<ParcelRegionSummary, 'south' | 'west' | 'north' | 'east'>): [number, number][] {
    return [
        [bounds.west, bounds.south],
        [bounds.east, bounds.south],
        [bounds.east, bounds.north],
        [bounds.west, bounds.north],
        [bounds.west, bounds.south]
    ]
}

function crossProduct(origin: [number, number], a: [number, number], b: [number, number]) {
    return (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0])
}

function buildConvexHull(points: [number, number][]) {
    const uniquePoints = Array.from(new Map(
        points.map((point) => [`${point[0].toFixed(6)}|${point[1].toFixed(6)}`, point] as const)
    ).values()).sort((left, right) => {
        if (left[0] === right[0]) return left[1] - right[1]
        return left[0] - right[0]
    })

    if (uniquePoints.length <= 3) {
        return uniquePoints.length >= 3 ? [...uniquePoints, uniquePoints[0]] : uniquePoints
    }

    const lower: [number, number][] = []
    uniquePoints.forEach((point) => {
        while (lower.length >= 2 && crossProduct(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
            lower.pop()
        }
        lower.push(point)
    })

    const upper: [number, number][] = []
    for (let index = uniquePoints.length - 1; index >= 0; index -= 1) {
        const point = uniquePoints[index]
        while (upper.length >= 2 && crossProduct(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
            upper.pop()
        }
        upper.push(point)
    }

    const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)]
    return hull.length >= 3 ? [...hull, hull[0]] : hull
}

function buildPointKey(point: [number, number]) {
    return `${point[0].toFixed(6)}|${point[1].toFixed(6)}`
}

function buildEdgeKey(a: [number, number], b: [number, number]) {
    const left = buildPointKey(a)
    const right = buildPointKey(b)
    return left < right ? `${left}__${right}` : `${right}__${left}`
}

function closePolygonRing(points: [number, number][]) {
    if (points.length === 0) return points
    const [firstLng, firstLat] = points[0]
    const [lastLng, lastLat] = points[points.length - 1]
    if (firstLng === lastLng && firstLat === lastLat) return points
    return [...points, points[0]]
}

function calculateRingArea(points: [number, number][]) {
    if (points.length < 4) return 0

    let area = 0
    for (let index = 0; index < points.length - 1; index += 1) {
        const [x1, y1] = points[index]
        const [x2, y2] = points[index + 1]
        area += (x1 * y2) - (x2 * y1)
    }

    return area / 2
}

function isPointInsidePolygon(points: [number, number][], lat: number, lng: number) {
    if (points.length < 3) return false

    let inside = false
    for (let currentIndex = 0, previousIndex = points.length - 1; currentIndex < points.length; previousIndex = currentIndex++) {
        const [currentLng, currentLat] = points[currentIndex]
        const [previousLng, previousLat] = points[previousIndex]
        const intersects = ((currentLat > lat) !== (previousLat > lat)) &&
            (lng < ((previousLng - currentLng) * (lat - currentLat)) / ((previousLat - currentLat) || Number.EPSILON) + currentLng)

        if (intersects) inside = !inside
    }

    return inside
}

function buildRegionBoundaryPolygons(rings: [number, number][][]) {
    const edgeMap = new Map<string, { count: number; a: [number, number]; b: [number, number] }>()
    const pointMap = new Map<string, [number, number]>()

    rings.forEach((ring) => {
        const closedRing = closePolygonRing(ring)
        for (let index = 0; index < closedRing.length - 1; index += 1) {
            const a = closedRing[index]
            const b = closedRing[index + 1]
            const aKey = buildPointKey(a)
            const bKey = buildPointKey(b)
            if (aKey === bKey) continue

            pointMap.set(aKey, a)
            pointMap.set(bKey, b)

            const edgeKey = buildEdgeKey(a, b)
            const existing = edgeMap.get(edgeKey)
            if (existing) {
                existing.count += 1
                continue
            }

            edgeMap.set(edgeKey, { count: 1, a, b })
        }
    })

    const boundarySegments = Array.from(edgeMap.values()).filter((edge) => edge.count === 1)
    if (boundarySegments.length === 0) return []

    const adjacency = new Map<string, Array<{ segmentIndex: number; otherKey: string }>>()
    boundarySegments.forEach((segment, segmentIndex) => {
        const aKey = buildPointKey(segment.a)
        const bKey = buildPointKey(segment.b)
        const left = adjacency.get(aKey) || []
        left.push({ segmentIndex, otherKey: bKey })
        adjacency.set(aKey, left)

        const right = adjacency.get(bKey) || []
        right.push({ segmentIndex, otherKey: aKey })
        adjacency.set(bKey, right)
    })

    const usedSegments = new Set<number>()
    const polygons: [number, number][][] = []

    boundarySegments.forEach((segment, segmentIndex) => {
        if (usedSegments.has(segmentIndex)) return

        usedSegments.add(segmentIndex)
        const startKey = buildPointKey(segment.a)
        let previousKey = startKey
        let currentKey = buildPointKey(segment.b)
        const ring: [number, number][] = [segment.a, segment.b]

        while (currentKey !== startKey) {
            const nextEntry = (adjacency.get(currentKey) || []).find((candidate) => !usedSegments.has(candidate.segmentIndex))
            if (!nextEntry) break

            usedSegments.add(nextEntry.segmentIndex)
            const nextPoint = pointMap.get(nextEntry.otherKey)
            if (!nextPoint) break

            previousKey = currentKey
            currentKey = nextEntry.otherKey
            ring.push(nextPoint)

            if (currentKey === previousKey) break
        }

        const closedRing = closePolygonRing(ring)
        if (closedRing.length >= 4 && Math.abs(calculateRingArea(closedRing)) > 0) {
            polygons.push(closedRing)
        }
    })

    return polygons.sort((left, right) => Math.abs(calculateRingArea(right)) - Math.abs(calculateRingArea(left)))
}

function buildGridCellRing(west: number, south: number, stepLng: number, stepLat: number): [number, number][] {
    return [
        [west, south],
        [west + stepLng, south],
        [west + stepLng, south + stepLat],
        [west, south + stepLat],
        [west, south]
    ]
}

function buildGridCellKey(row: number, column: number) {
    return `${row}:${column}`
}

function buildUnifiedRegionPolygons(regions: Array<{
    key: string
    west: number
    south: number
    east: number
    north: number
    centerLat: number
    centerLng: number
    basePolygon: [number, number][]
    parcelRings: [number, number][][]
}>): Map<string, [number, number][][]> {
    if (regions.length === 0) return new Map()

    const gridStepLng = 0.00045
    const gridStepLat = 0.00035
    const paddingLng = gridStepLng * 0.5
    const paddingLat = gridStepLat * 0.5
    const minWest = Math.min(...regions.map((region) => region.west)) - paddingLng
    const maxEast = Math.max(...regions.map((region) => region.east)) + paddingLng
    const minSouth = Math.min(...regions.map((region) => region.south)) - paddingLat
    const maxNorth = Math.max(...regions.map((region) => region.north)) + paddingLat
    const columnCount = Math.max(1, Math.ceil((maxEast - minWest) / gridStepLng))
    const rowCount = Math.max(1, Math.ceil((maxNorth - minSouth) / gridStepLat))
    const regionKeyByCell = new Map<string, string>()

    for (let row = 0; row < rowCount; row += 1) {
        const south = minSouth + row * gridStepLat
        const centerLat = south + gridStepLat / 2

        for (let column = 0; column < columnCount; column += 1) {
            const west = minWest + column * gridStepLng
            const centerLng = west + gridStepLng / 2
            const candidates = regions.filter((region) => {
                if (
                    centerLng < region.west - paddingLng ||
                    centerLng > region.east + paddingLng ||
                    centerLat < region.south - paddingLat ||
                    centerLat > region.north + paddingLat
                ) {
                    return false
                }

                return region.parcelRings.some((ring) => isPointInsidePolygon(ring, centerLat, centerLng))
            })

            if (candidates.length === 0) continue

            const owner = candidates.reduce((best, region) => {
                if (!best) return region

                const bestDistance = ((best.centerLng - centerLng) ** 2) + ((best.centerLat - centerLat) ** 2)
                const regionDistance = ((region.centerLng - centerLng) ** 2) + ((region.centerLat - centerLat) ** 2)
                return regionDistance < bestDistance ? region : best
            }, candidates[0])

            regionKeyByCell.set(buildGridCellKey(row, column), owner.key)
        }
    }

    const fillCandidates = new Map<string, Array<{ regionKey: string; score: number }>>()

    for (let row = 0; row < rowCount; row += 1) {
        for (let column = 0; column < columnCount; column += 1) {
            const cellKey = buildGridCellKey(row, column)
            if (regionKeyByCell.has(cellKey)) continue

            const neighborScores = new Map<string, number>()

            for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
                for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
                    if (rowOffset === 0 && columnOffset === 0) continue

                    const neighborKey = regionKeyByCell.get(buildGridCellKey(row + rowOffset, column + columnOffset))
                    if (!neighborKey) continue
                    neighborScores.set(neighborKey, (neighborScores.get(neighborKey) || 0) + 1)
                }
            }

            Array.from(neighborScores.entries()).forEach(([regionKey, score]) => {
                if (score < 7) return

                const existing = fillCandidates.get(cellKey) || []
                existing.push({ regionKey, score })
                fillCandidates.set(cellKey, existing)
            })
        }
    }

    fillCandidates.forEach((candidates, cellKey) => {
        const winner = candidates.sort((left, right) => right.score - left.score)[0]
        if (!winner) return
        regionKeyByCell.set(cellKey, winner.regionKey)
    })

    const cellRingsByRegion = new Map<string, [number, number][][]>()
    regionKeyByCell.forEach((regionKey, cellKey) => {
        const [rowText, columnText] = cellKey.split(':')
        const row = Number.parseInt(rowText || '', 10)
        const column = Number.parseInt(columnText || '', 10)
        if (!Number.isFinite(row) || !Number.isFinite(column)) return

        const south = minSouth + row * gridStepLat
        const west = minWest + column * gridStepLng
        const existing = cellRingsByRegion.get(regionKey) || []
        existing.push(buildGridCellRing(west, south, gridStepLng, gridStepLat))
        cellRingsByRegion.set(regionKey, existing)
    })

    return new Map(regions.map((region) => {
        const cellRings = cellRingsByRegion.get(region.key) || []
        const polygons = buildRegionBoundaryPolygons(cellRings)
        return [region.key, polygons.length > 0 ? [polygons[0]] : [region.basePolygon]] as const
    }))
}

function isPointInsideParcel(parcel: PiekoszowParcel, lat: number, lng: number) {
    if (parcel.coords.length < 3) {
        return containsPoint(parcel, lat, lng)
    }

    let inside = false
    for (let currentIndex = 0, previousIndex = parcel.coords.length - 1; currentIndex < parcel.coords.length; previousIndex = currentIndex++) {
        const [currentLng, currentLat] = parcel.coords[currentIndex]
        const [previousLng, previousLat] = parcel.coords[previousIndex]
        const intersects = ((currentLat > lat) !== (previousLat > lat)) &&
            (lng < ((previousLng - currentLng) * (lat - currentLat)) / ((previousLat - currentLat) || Number.EPSILON) + currentLng)

        if (intersects) inside = !inside
    }

    return inside
}

export function getParcelSearchText(parcel: PiekoszowParcel) {
    return [
        parcel.id,
        parcel.parcelNumber,
        parcel.localityLabel,
        parcel.localityCode,
        parcel.municipality,
        parcel.precinct,
        parcel.county,
        parcel.voivodeship
    ].filter(Boolean).join(' ')
}

export async function fetchParcelByCoordinates(
    lat: number,
    lng: number,
    options?: ParcelPointLookupOptions
): Promise<PiekoszowParcel | null> {
    const localOnlyMapData = isLocalOnlyMapDataEnabled()
    const pad = PARCEL_TILE_DEG * 0.1
    const tileBounds: MapBounds = { south: lat - pad, west: lng - pad, north: lat + pad, east: lng + pad }
    const [localParcels, geoportalParcels] = await Promise.all([
        loadParcels(tileBounds),
        loadGeoportalParcelsForBounds(tileBounds)
    ])
    const parcels = mergeParcelsById(localParcels, geoportalParcels)

    const exactParcel = parcels.find((parcel) =>
        containsPoint(parcel, lat, lng) && isPointInsideParcel(parcel, lat, lng)
    )
    if (exactParcel) return exactParcel

    const bboxParcel = parcels.find((parcel) => containsPoint(parcel, lat, lng, 0.00005))
    let dynamicParcels: PiekoszowParcel[] = []
    try {
        dynamicParcels = await fetchDynamicParcelsForBounds(tileBounds, { localOnly: localOnlyMapData })
        const dynamicExact = dynamicParcels.find((parcel) =>
            containsPoint(parcel, lat, lng) && isPointInsideParcel(parcel, lat, lng)
        )
        if (dynamicExact) return dynamicExact
    } catch {
    }

    const uldkParcel = localOnlyMapData ? null : await fetchUldkParcelByCoordinates(lat, lng).catch(() => null)
    if (uldkParcel) return uldkParcel

    if (options?.exactOnly) return null

    if (bboxParcel) return bboxParcel

    const dynamicBbox = dynamicParcels.find((parcel) => containsPoint(parcel, lat, lng, 0.00005))
    if (dynamicBbox) return dynamicBbox

    return lookupGeoportalParcelByPoint(lat, lng)
}

export async function fetchParcelGeometryById(parcelId: string): Promise<PiekoszowParcel | null> {
    const localOnlyMapData = isLocalOnlyMapDataEnabled()
    const normalizedParcelId = `${parcelId || ''}`.trim()
    if (!normalizedParcelId) return null

    try {
        const knownLookup = await getKnownParcelByIdLookup()
        const knownParcel = knownLookup.get(normalizedParcelId)
        if (knownParcel) return knownParcel
    } catch {
    }

    const alreadyCached = Array.from(parcelTileCache.values())
    for (const tilePromise of alreadyCached) {
        const tile = await tilePromise
        const found = tile.find((p) => p.id === normalizedParcelId)
        if (found) return found
    }
    const geoportalParcels = await getAllGeoportalParcels()
    const geoportalFound = geoportalParcels.find((parcel) => parcel.id === normalizedParcelId)
    if (geoportalFound) return geoportalFound
    const dynamicFound = await findDynamicParcelById(normalizedParcelId)
    if (dynamicFound) return dynamicFound
    const uldkFound = localOnlyMapData ? null : await fetchUldkParcelGeometryById(normalizedParcelId).catch(() => null)
    if (uldkFound) return uldkFound
    const parcels = await fetchAllLocalParcels()
    return parcels.find((parcel) => parcel.id === normalizedParcelId) || null
}

export async function fetchParcelsByIds(parcelIds: string[]): Promise<PiekoszowParcel[]> {
    const localOnlyMapData = isLocalOnlyMapDataEnabled()
    const normalizedIds = Array.from(new Set(parcelIds.map((parcelId) => `${parcelId || ''}`.trim()).filter(Boolean)))
    if (normalizedIds.length === 0) return []

    const lookup = await getKnownParcelByIdLookup()
    const resolvedKnown = normalizedIds
        .map((parcelId) => lookup.get(parcelId))
        .filter((parcel): parcel is PiekoszowParcel => Boolean(parcel))

    const resolvedKnownIds = new Set(resolvedKnown.map((parcel) => parcel.id))
    const missingIds = normalizedIds.filter((parcelId) => !resolvedKnownIds.has(parcelId))
    if (missingIds.length === 0) return resolvedKnown

    const resolvedLive = localOnlyMapData
        ? []
        : await Promise.all(
            missingIds.map((parcelId) => fetchUldkParcelGeometryById(parcelId).catch(() => null))
        )

    return Array.from(new Map(
        [...resolvedKnown, ...resolvedLive.filter((parcel): parcel is PiekoszowParcel => Boolean(parcel))]
            .map((parcel) => [parcel.id, parcel] as const)
    ).values())
}

export async function fetchAllLocalParcels(): Promise<PiekoszowParcel[]> {
    if (!allLocalParcelsPromise) {
        allLocalParcelsPromise = loadParcels().catch((error) => {
            allLocalParcelsPromise = null
            throw error
        })
    }

    return allLocalParcelsPromise
}

async function fetchAllKnownParcels(): Promise<PiekoszowParcel[]> {
    if (!allKnownParcelsPromise) {
        allKnownParcelsPromise = Promise.all([
            fetchAllLocalParcels(),
            getAllGeoportalParcels()
        ]).then(([localParcels, geoportalParcels]) => mergeParcelsById(localParcels, geoportalParcels)).catch((error) => {
            allKnownParcelsPromise = null
            throw error
        })
    }

    return allKnownParcelsPromise
}

async function getKnownParcelByIdLookup(): Promise<Map<string, PiekoszowParcel>> {
    if (!knownParcelByIdPromise) {
        knownParcelByIdPromise = fetchAllKnownParcels().then((parcels) =>
            new Map(parcels.map((parcel) => [parcel.id, parcel] as const))
        ).catch((error) => {
            knownParcelByIdPromise = null
            throw error
        })
    }

    return knownParcelByIdPromise
}

export function filterParcelsByQuery(parcels: PiekoszowParcel[], query: string) {
    const normalizedQuery = normalizeParcelText(query)
    if (!normalizedQuery) return parcels

    return parcels.filter((parcel) =>
        normalizeParcelText(getParcelSearchText(parcel)).includes(normalizedQuery)
    )
}

async function parcelTilesForBounds(bounds: MapBounds) {
    const index = await getParcelTileIndex()
    return index.tiles
        .filter((tile) => {
            const tileBounds = parseParcelTileKey(tile.key, index.tileDeg || PARCEL_TILE_DEG)
            return tileBounds ? intersectsBounds(bounds, tileBounds) : false
        })
        .map((tile) => tile.key)
}

function parseParcelFeature(feature: { properties?: Record<string, unknown>; geometry?: { type?: string; coordinates?: unknown } }): PiekoszowParcel | null {
    const properties = feature.properties || {}
    const id = `${properties.id || properties.label || ''}`.trim()
    if (!id) return null

    const centerLat = Number(properties.centerLat)
    const centerLng = Number(properties.centerLng)
    const south = Number(properties.south)
    const west = Number(properties.west)
    const north = Number(properties.north)
    const east = Number(properties.east)
    if (![centerLat, centerLng, south, west, north, east].every(Number.isFinite)) return null

    const label = `${properties.label || id}`
    const parcelNumber = `${properties.parcelNumber || getParcelNumberFromIdentifier(label)}`
    const localityCode = getLocalityCodeFromParcelId(id) || undefined
    const localityLabel = sanitizeParcelAdminLabel(properties.localityLabel)
        || sanitizeParcelAdminLabel(getLocalityLabelFromCode(localityCode))
        || undefined
    const municipality = `${properties.municipality || ''}`.trim() || undefined
    const precinct = sanitizeParcelAdminLabel(properties.precinct || '')
    const county = `${properties.county || ''}`.trim() || undefined
    const voivodeship = `${properties.voivodeship || ''}`.trim() || undefined
    const addressResolved = `${properties.addressResolved || ''}`.trim() || undefined

    const geometry = feature as { geometry?: { type?: string; coordinates?: unknown } }
    const outerRing = geometry.geometry?.type === 'Polygon' && Array.isArray(geometry.geometry.coordinates)
        ? geometry.geometry.coordinates[0] as unknown[] | undefined
        : undefined
    const coords = (outerRing || [])
        .map((point) => {
            if (!Array.isArray(point) || point.length < 2) return null
            const lng = Number(point[0])
            const lat = Number(point[1])
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
            return [lng, lat] as [number, number]
        })
        .filter((point): point is [number, number] => Array.isArray(point))

    return {
        id,
        label,
        shortLabel: parcelNumber,
        parcelNumber,
        localityCode,
        localityLabel,
        municipality,
        precinct,
        county,
        voivodeship,
        addressResolved,
        centerLat,
        centerLng,
        south,
        west,
        north,
        east,
        coords,
        source: 'local'
    }
}

async function fetchParcelTile(key: string): Promise<PiekoszowParcel[]> {
    const url = `${PARCEL_TILES_DIR}/${key}.geojson`
    const response = await fetch(url)
    if (!response.ok) {
        if (response.status === 404) return []
        throw new Error(`Parcel tile ${key}: HTTP ${response.status}`)
    }
    const payload = await response.json() as ParcelCollection
    return (payload.features || []).flatMap((f) => { const p = parseParcelFeature(f); return p ? [p] : [] })
}

function getOrLoadParcelTile(key: string): Promise<PiekoszowParcel[]> {
    if (!parcelTileCache.has(key)) {
        parcelTileCache.set(key, fetchParcelTile(key).catch((err) => {
            parcelTileCache.delete(key)
            console.warn(`Parcel tile ${key} error:`, err)
            return []
        }))
    }
    return parcelTileCache.get(key)!
}

async function loadParcelTilesForBounds(bounds: MapBounds): Promise<PiekoszowParcel[]> {
    const keys = await parcelTilesForBounds(bounds)
    if (keys.length === 0) return []
    const results = await Promise.all(keys.map(getOrLoadParcelTile))
    const seen = new Set<string>()
    const merged: PiekoszowParcel[] = []
    for (const list of results) {
        for (const p of list) {
            if (!seen.has(p.id)) { seen.add(p.id); merged.push(p) }
        }
    }
    return merged
}

async function loadParcels(bounds?: MapBounds): Promise<PiekoszowParcel[]> {
    const index = await getParcelTileIndex()
    const effectiveBounds = bounds ?? index.bbox
    return loadParcelTilesForBounds(effectiveBounds)
}

async function loadGeoportalParcelsForBounds(bounds?: MapBounds): Promise<PiekoszowParcel[]> {
    const index = await getParcelTileIndex()
    const effectiveBounds = bounds ?? index.bbox
    const parcels = await getAllGeoportalParcels()
    return parcels.filter((parcel) => intersectsBounds(effectiveBounds, parcel))
}

function mergeParcelsById(...groups: PiekoszowParcel[][]): PiekoszowParcel[] {
    const merged = new Map<string, PiekoszowParcel>()
    groups.forEach((group) => {
        group.forEach((parcel) => {
            if (!merged.has(parcel.id)) merged.set(parcel.id, parcel)
        })
    })
    return Array.from(merged.values())
}

export async function fetchParcelLocalities(): Promise<ParcelLocalitySummary[]> {
    if (cachedParcelLocalities) return cachedParcelLocalities

    const parcels = await fetchAllKnownParcels()
    const summaryMap = new Map<string, ParcelLocalitySummary>()

    parcels.forEach((parcel) => {
        const label = `${sanitizeParcelAdminLabel(parcel.precinct)
            || sanitizeParcelAdminLabel(parcel.localityLabel)
            || sanitizeParcelAdminLabel(getLocalityLabelFromCode(parcel.localityCode))
            || parcel.localityCode
            || 'Bez obszaru'}`
            .trim() || 'Bez obszaru'
        const scopeKey = `${parcel.localityCode || 'unknown'}::${normalizeParcelText(label)}`

        const existing = summaryMap.get(scopeKey)
        if (existing) {
            existing.south = Math.min(existing.south, parcel.south)
            existing.west = Math.min(existing.west, parcel.west)
            existing.north = Math.max(existing.north, parcel.north)
            existing.east = Math.max(existing.east, parcel.east)
            existing.count += 1
            if (parcel.localityCode && !existing.localityCodes.includes(parcel.localityCode)) {
                existing.localityCodes.push(parcel.localityCode)
            }
            const precinctLabel = `${parcel.precinct || parcel.localityLabel || label}`.trim() || label
            if (!existing.precincts.includes(precinctLabel)) {
                existing.precincts.push(precinctLabel)
            }
            const municipalityLabel = sanitizeParcelAdminLabel(parcel.municipality)
            if (municipalityLabel && !existing.municipalities.includes(municipalityLabel)) {
                existing.municipalities.push(municipalityLabel)
            }
            const countyLabel = sanitizeParcelAdminLabel(parcel.county)
            if (countyLabel && !existing.countyLabels.includes(countyLabel)) {
                existing.countyLabels.push(countyLabel)
            }
            return
        }

        summaryMap.set(scopeKey, {
            code: scopeKey,
            label,
            south: parcel.south,
            west: parcel.west,
            north: parcel.north,
            east: parcel.east,
            count: 1,
            localityCodes: parcel.localityCode ? [parcel.localityCode] : [],
            precincts: [`${parcel.precinct || parcel.localityLabel || label}`.trim() || label],
            municipalities: sanitizeParcelAdminLabel(parcel.municipality) ? [sanitizeParcelAdminLabel(parcel.municipality)!] : [],
            countyLabels: sanitizeParcelAdminLabel(parcel.county) ? [sanitizeParcelAdminLabel(parcel.county)!] : []
        })
    })

    cachedParcelLocalities = Array.from(summaryMap.values()).sort((left, right) => left.label.localeCompare(right.label, 'pl'))
    return cachedParcelLocalities
}

export async function fetchParcelPrecincts(): Promise<string[]> {
    if (cachedParcelPrecincts) return cachedParcelPrecincts

    const parcels = await fetchAllKnownParcels()
    cachedParcelPrecincts = Array.from(new Set(
        parcels.map((parcel) => `${parcel.precinct || parcel.localityLabel || 'Bez obrębu'}`.trim() || 'Bez obrębu')
    )).sort((left, right) => left.localeCompare(right, 'pl', { sensitivity: 'base' }))

    return cachedParcelPrecincts
}

export async function fetchParcelRegions(): Promise<ParcelRegionSummary[]> {
    if (cachedParcelRegions) return cachedParcelRegions

    const parcels = await fetchAllKnownParcels()
    const summaryMap = new Map<string, {
        key: string
        label: string
        south: number
        west: number
        north: number
        east: number
        count: number
        points: [number, number][]
        rings: [number, number][][]
        localityCodes: Set<string>
        precincts: Set<string>
    }>()

    parcels.forEach((parcel) => {
        const label = resolveParcelRegionLabel(parcel)
        const key = `region:${normalizeParcelText(label) || label.toLowerCase()}`
        const existing = summaryMap.get(key)

        if (existing) {
            existing.south = Math.min(existing.south, parcel.south)
            existing.west = Math.min(existing.west, parcel.west)
            existing.north = Math.max(existing.north, parcel.north)
            existing.east = Math.max(existing.east, parcel.east)
            existing.count += 1
            if (parcel.localityCode) existing.localityCodes.add(parcel.localityCode)
            if (parcel.precinct) existing.precincts.add(parcel.precinct)
            existing.points.push(
                [parcel.west, parcel.south],
                [parcel.east, parcel.south],
                [parcel.east, parcel.north],
                [parcel.west, parcel.north]
            )
            existing.rings.push(parcel.coords.length >= 3 ? parcel.coords : buildFallbackRegionPolygon(parcel))
            return
        }

        summaryMap.set(key, {
            key,
            label,
            south: parcel.south,
            west: parcel.west,
            north: parcel.north,
            east: parcel.east,
            count: 1,
            points: [
                [parcel.west, parcel.south],
                [parcel.east, parcel.south],
                [parcel.east, parcel.north],
                [parcel.west, parcel.north]
            ],
            rings: [parcel.coords.length >= 3 ? parcel.coords : buildFallbackRegionPolygon(parcel)],
            localityCodes: new Set(parcel.localityCode ? [parcel.localityCode] : []),
            precincts: new Set(parcel.precinct ? [parcel.precinct] : [])
        })
    })

    const unifiedRegionBases = Array.from(summaryMap.values()).map((region) => {
        const fallbackHull = buildConvexHull(region.points)
        const basePolygon = fallbackHull.length >= 4 ? fallbackHull : buildFallbackRegionPolygon(region)

        return {
            ...region,
            centerLat: (region.south + region.north) / 2,
            centerLng: (region.west + region.east) / 2,
            basePolygon,
            parcelRings: region.rings
        }
    })

    const unifiedRegionPolygons = buildUnifiedRegionPolygons(unifiedRegionBases)

    cachedParcelRegions = unifiedRegionBases
        .map((region) => {
            const polygons = unifiedRegionPolygons.get(region.key) || [region.basePolygon]

            return {
                key: region.key,
                label: region.label,
                regionType: resolveParcelRegionType(region.label),
                south: region.south,
                west: region.west,
                north: region.north,
                east: region.east,
                centerLat: region.centerLat,
                centerLng: region.centerLng,
                count: region.count,
                coords: polygons,
                localityCodes: Array.from(region.localityCodes).sort(),
                precincts: Array.from(region.precincts).sort((left, right) => left.localeCompare(right, 'pl', { sensitivity: 'base' }))
            } satisfies ParcelRegionSummary
        })
        .sort((left, right) => {
            if (left.regionType !== right.regionType) {
                return left.regionType === 'municipal-seat' ? -1 : 1
            }

            return left.label.localeCompare(right.label, 'pl', { sensitivity: 'base' })
        })

    return cachedParcelRegions
}

export async function fetchParcelMunicipalities(): Promise<ParcelMunicipalitySummary[]> {
    if (cachedParcelMunicipalities) return cachedParcelMunicipalities

    const parcels = await fetchAllKnownParcels()
    const summaryMap = new Map<string, {
        code: string
        key: string
        label: string
        south: number
        west: number
        north: number
        east: number
        count: number
        points: [number, number][]
        rings: [number, number][][]
        localityCodes: Set<string>
        precincts: Set<string>
        countyLabels: Set<string>
    }>()

    parcels.forEach((parcel) => {
        const municipalityLabel = sanitizeParcelAdminLabel(parcel.municipality)
        if (!municipalityLabel) return

        const code = `municipality:${normalizeParcelText(municipalityLabel)}`
        const existing = summaryMap.get(code)
        if (existing) {
            existing.south = Math.min(existing.south, parcel.south)
            existing.west = Math.min(existing.west, parcel.west)
            existing.north = Math.max(existing.north, parcel.north)
            existing.east = Math.max(existing.east, parcel.east)
            existing.count += 1
            if (parcel.localityCode) existing.localityCodes.add(parcel.localityCode)
            if (parcel.precinct) existing.precincts.add(parcel.precinct)
            if (sanitizeParcelAdminLabel(parcel.county)) existing.countyLabels.add(sanitizeParcelAdminLabel(parcel.county)!)
            existing.points.push(
                [parcel.west, parcel.south],
                [parcel.east, parcel.south],
                [parcel.east, parcel.north],
                [parcel.west, parcel.north]
            )
            existing.rings.push(parcel.coords.length >= 3 ? parcel.coords : buildFallbackRegionPolygon(parcel))
            return
        }

        summaryMap.set(code, {
            code,
            key: code,
            label: municipalityLabel,
            south: parcel.south,
            west: parcel.west,
            north: parcel.north,
            east: parcel.east,
            count: 1,
            points: [
                [parcel.west, parcel.south],
                [parcel.east, parcel.south],
                [parcel.east, parcel.north],
                [parcel.west, parcel.north]
            ],
            rings: [parcel.coords.length >= 3 ? parcel.coords : buildFallbackRegionPolygon(parcel)],
            localityCodes: new Set(parcel.localityCode ? [parcel.localityCode] : []),
            precincts: new Set(parcel.precinct ? [parcel.precinct] : []),
            countyLabels: new Set(sanitizeParcelAdminLabel(parcel.county) ? [sanitizeParcelAdminLabel(parcel.county)!] : [])
        })
    })

    const municipalityBases = Array.from(summaryMap.values()).map((region) => {
        const fallbackHull = buildConvexHull(region.points)
        const basePolygon = fallbackHull.length >= 4 ? fallbackHull : buildFallbackRegionPolygon(region)

        return {
            ...region,
            key: region.key,
            centerLat: (region.south + region.north) / 2,
            centerLng: (region.west + region.east) / 2,
            basePolygon,
            parcelRings: region.rings
        }
    })

    const unifiedMunicipalityPolygons = buildUnifiedRegionPolygons(municipalityBases)
    cachedParcelMunicipalities = municipalityBases
        .map((region) => ({
            code: region.code,
            label: region.label,
            south: region.south,
            west: region.west,
            north: region.north,
            east: region.east,
            centerLat: region.centerLat,
            centerLng: region.centerLng,
            count: region.count,
            coords: unifiedMunicipalityPolygons.get(region.key) || [region.basePolygon],
            localityCodes: Array.from(region.localityCodes).sort(),
            precincts: Array.from(region.precincts).sort((left, right) => left.localeCompare(right, 'pl', { sensitivity: 'base' })),
            countyLabels: Array.from(region.countyLabels).sort((left, right) => left.localeCompare(right, 'pl', { sensitivity: 'base' }))
        }))
        .sort((left, right) => left.label.localeCompare(right.label, 'pl', { sensitivity: 'base' }))

    return cachedParcelMunicipalities
}

export async function resolveParcelRegionByCoordinates(lat: number, lng: number): Promise<ParcelRegionSummary | null> {
    const regions = await fetchParcelRegions()
    const exactRegion = regions.find((region) =>
        containsPoint(region, lat, lng) && region.coords.some((polygon) => isPointInsidePolygon(polygon, lat, lng))
    )
    if (exactRegion) return exactRegion

    const boundedRegion = regions.find((region) => containsPoint(region, lat, lng, 0.0003))
    return boundedRegion || null
}

export async function fetchPiekoszowParcelsForBounds(bounds: MapBounds, options?: ParcelFetchOptions): Promise<PiekoszowParcel[]> {
    const [localParcels, geoportalParcels] = await Promise.all([
        loadParcels(bounds),
        loadGeoportalParcelsForBounds(bounds)
    ])
    return filterVisibleParcels(bounds, mergeParcelsById(localParcels, geoportalParcels), options)
}

export async function fetchVisibleParcelsForMap(map: L.Map, options?: ParcelFetchOptions): Promise<PiekoszowParcel[]> {
    const localOnlyMapData = isLocalOnlyMapDataEnabled()
    const bounds = {
        south: map.getBounds().getSouth(),
        west: map.getBounds().getWest(),
        north: map.getBounds().getNorth(),
        east: map.getBounds().getEast()
    }
    const cacheKey = buildVisibleParcelCacheKey(map, bounds, options)
    const cachedRequest = visibleParcelCache.get(cacheKey)
    if (cachedRequest) return cachedRequest

    const request = (async () => {
        const localVisible = await fetchPiekoszowParcelsForBounds(bounds, options)
        if (localOnlyMapData || map.getZoom() < DYNAMIC_PARCEL_AUGMENT_MIN_ZOOM) {
            return localVisible
        }

        try {
            const dynamicVisible = filterVisibleParcels(
                bounds,
                await fetchDynamicParcelsForBounds(bounds, { localOnly: localOnlyMapData }),
                options
            )
            return mergeParcelsById(localVisible, dynamicVisible)
        } catch {
            return localVisible
        }
    })().catch((error) => {
        visibleParcelCache.delete(cacheKey)
        console.error('fetchVisibleParcelsForMap error:', error)
        return [] as PiekoszowParcel[]
    })

    rememberVisibleParcelCache(cacheKey, request)
    return request
}
