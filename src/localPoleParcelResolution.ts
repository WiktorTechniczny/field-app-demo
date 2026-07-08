import { getAllGeoportalParcels } from './geoportalParcels'
import type { PiekoszowParcel } from './piekoszowParcels'
import { fetchAllLocalParcels } from './piekoszowParcels'
import type { PowerPole } from './powerPoles'
import { buildDisplayCivicAddress, hasFullCivicAddress } from './civicAddress'

const PARCEL_GRID_CELL_DEG = 0.005
const NEARBY_PARCEL_MAX_DISTANCE_METERS = 24

type ParcelSpatialIndex = {
    cells: Map<string, PiekoszowParcel[]>
    bounds: { south: number; west: number; north: number; east: number }
}

let parcelSpatialIndexPromise: Promise<ParcelSpatialIndex> | null = null
let fallbackParcelSpatialIndexPromise: Promise<ParcelSpatialIndex> | null = null
const resolvedPoleCache = new Map<string, PowerPole>()

const buildCellKey = (row: number, col: number): string => `${row}:${col}`
const getCellCoordinate = (value: number): number => Math.floor(value / PARCEL_GRID_CELL_DEG)

const buildPoleCacheKey = (pole: Pick<PowerPole, 'id' | 'lat' | 'lng'>): string =>
    `${pole.id}|${pole.lat.toFixed(6)}|${pole.lng.toFixed(6)}`

const hasResolvedPoleParcelMetadata = (pole: Pick<PowerPole, 'parcelId' | 'parcelNumber' | 'precinct'>): boolean =>
    Boolean(pole.parcelId && pole.parcelNumber && pole.precinct)

export const hasExactPoleAddress = (address?: string | null): boolean => {
    const normalized = `${address || ''}`.trim()
    if (!normalized) return false
    if (/dzia[łl]ka/i.test(normalized)) return false

    const firstSegment = normalized.split(',')[0]?.trim() || normalized
    if (/^\d+[A-Za-z]?(?:\/\d+[A-Za-z]?)?$/.test(firstSegment)) return true
    if (/\d/.test(firstSegment) && /[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]/.test(firstSegment)) return true
    if (/\b(ul\.?|al\.?|os\.?|pl\.?|rondo)\b/i.test(normalized) && /\d/.test(normalized)) return true
    return false
}

const getParcelMetadataScore = (parcel: PiekoszowParcel): number => {
    let score = parcel.coords.length * 2
    if (parcel.parcelNumber) score += 12
    if (parcel.localityLabel) score += 8
    if (parcel.precinct) score += 8
    if (parcel.municipality) score += 6
    if (parcel.county) score += 4
    if (parcel.voivodeship) score += 2
    if (parcel.source === 'local') score += 1
    return score
}

const pickPreferredParcelVariant = (current: PiekoszowParcel, candidate: PiekoszowParcel): PiekoszowParcel => {
    const currentScore = getParcelMetadataScore(current)
    const candidateScore = getParcelMetadataScore(candidate)
    if (candidateScore !== currentScore) return candidateScore > currentScore ? candidate : current
    if (candidate.coords.length !== current.coords.length) return candidate.coords.length > current.coords.length ? candidate : current
    return candidate.id.localeCompare(current.id) < 0 ? candidate : current
}

const dedupeParcelsById = (parcels: PiekoszowParcel[]): PiekoszowParcel[] => {
    const merged = new Map<string, PiekoszowParcel>()
    parcels.forEach((parcel) => {
        const existing = merged.get(parcel.id)
        merged.set(parcel.id, existing ? pickPreferredParcelVariant(existing, parcel) : parcel)
    })
    return Array.from(merged.values())
}

const isPointInsideParcel = (parcel: PiekoszowParcel, lat: number, lng: number): boolean => {
    if (lat < parcel.south || lat > parcel.north || lng < parcel.west || lng > parcel.east) return false
    if (parcel.coords.length < 3) return true

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

const distanceMeters = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
    const earthRadius = 6371000
    const dLat = (lat2 - lat1) * Math.PI / 180
    const dLng = (lng2 - lng1) * Math.PI / 180
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2
    return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

const projectToMeters = (lat: number, lng: number, referenceLat: number) => {
    const safeCos = Math.max(0.2, Math.cos(referenceLat * Math.PI / 180))
    return {
        x: lng * 111_320 * safeCos,
        y: lat * 111_320
    }
}

const distancePointToSegmentMeters = (
    lat: number,
    lng: number,
    start: [number, number],
    end: [number, number]
): number => {
    const referenceLat = (lat + start[1] + end[1]) / 3
    const point = projectToMeters(lat, lng, referenceLat)
    const from = projectToMeters(start[1], start[0], referenceLat)
    const to = projectToMeters(end[1], end[0], referenceLat)
    const dx = to.x - from.x
    const dy = to.y - from.y
    const segmentLengthSquared = dx * dx + dy * dy

    if (segmentLengthSquared <= Number.EPSILON) {
        return Math.hypot(point.x - from.x, point.y - from.y)
    }

    const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / segmentLengthSquared))
    const closestX = from.x + t * dx
    const closestY = from.y + t * dy
    return Math.hypot(point.x - closestX, point.y - closestY)
}

const distancePointToParcelMeters = (parcel: PiekoszowParcel, lat: number, lng: number): number => {
    if (isPointInsideParcel(parcel, lat, lng)) return 0

    if (parcel.coords.length >= 2) {
        let bestDistance = Number.POSITIVE_INFINITY
        for (let index = 0; index < parcel.coords.length - 1; index += 1) {
            const distance = distancePointToSegmentMeters(lat, lng, parcel.coords[index], parcel.coords[index + 1])
            if (distance < bestDistance) bestDistance = distance
        }

        if (Number.isFinite(bestDistance)) return bestDistance
    }

    const clampedLat = Math.min(Math.max(lat, parcel.south), parcel.north)
    const clampedLng = Math.min(Math.max(lng, parcel.west), parcel.east)
    return distanceMeters(lat, lng, clampedLat, clampedLng)
}

const getCandidateParcels = (index: ParcelSpatialIndex, lat: number, lng: number): PiekoszowParcel[] => {
    if (index.cells.size === 0) return []
    if (
        lat < index.bounds.south ||
        lat > index.bounds.north ||
        lng < index.bounds.west ||
        lng > index.bounds.east
    ) {
        return []
    }

    const row = getCellCoordinate(lat)
    const col = getCellCoordinate(lng)
    const uniqueCandidates = new Map<string, PiekoszowParcel>()

    for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
        for (let colOffset = -1; colOffset <= 1; colOffset += 1) {
            const bucket = index.cells.get(buildCellKey(row + rowOffset, col + colOffset)) || []
            bucket.forEach((parcel) => {
                if (!uniqueCandidates.has(parcel.id)) uniqueCandidates.set(parcel.id, parcel)
            })
        }
    }

    return Array.from(uniqueCandidates.values())
}

const chooseBestParcel = (candidates: PiekoszowParcel[], lat: number, lng: number): PiekoszowParcel | null => {
    const exactMatch = candidates
        .filter((parcel) => isPointInsideParcel(parcel, lat, lng))
        .sort((left, right) =>
            distanceMeters(lat, lng, left.centerLat, left.centerLng) -
            distanceMeters(lat, lng, right.centerLat, right.centerLng) ||
            left.id.localeCompare(right.id)
        )[0]

    if (exactMatch) return exactMatch

    return candidates
        .map((parcel) => ({
            parcel,
            distanceToEdgeMeters: distancePointToParcelMeters(parcel, lat, lng),
            distanceToCenterMeters: distanceMeters(lat, lng, parcel.centerLat, parcel.centerLng)
        }))
        .filter((candidate) => candidate.distanceToEdgeMeters <= NEARBY_PARCEL_MAX_DISTANCE_METERS)
        .sort((left, right) =>
            left.distanceToEdgeMeters - right.distanceToEdgeMeters ||
            left.distanceToCenterMeters - right.distanceToCenterMeters ||
            left.parcel.id.localeCompare(right.parcel.id)
        )[0]?.parcel || null
}

const buildParcelSpatialIndex = (parcels: PiekoszowParcel[]): ParcelSpatialIndex => {
    const cells = new Map<string, PiekoszowParcel[]>()

    if (parcels.length === 0) {
        return {
            cells,
            bounds: { south: -90, west: -180, north: 90, east: 180 }
        }
    }

    let south = Number.POSITIVE_INFINITY
    let west = Number.POSITIVE_INFINITY
    let north = Number.NEGATIVE_INFINITY
    let east = Number.NEGATIVE_INFINITY

    parcels.forEach((parcel) => {
        south = Math.min(south, parcel.south)
        west = Math.min(west, parcel.west)
        north = Math.max(north, parcel.north)
        east = Math.max(east, parcel.east)

        const startRow = getCellCoordinate(parcel.south)
        const endRow = getCellCoordinate(parcel.north)
        const startCol = getCellCoordinate(parcel.west)
        const endCol = getCellCoordinate(parcel.east)

        for (let row = startRow; row <= endRow; row += 1) {
            for (let col = startCol; col <= endCol; col += 1) {
                const key = buildCellKey(row, col)
                const bucket = cells.get(key)
                if (bucket) {
                    bucket.push(parcel)
                } else {
                    cells.set(key, [parcel])
                }
            }
        }
    })

    return {
        cells,
        bounds: { south, west, north, east }
    }
}

const loadPrimaryIndexParcels = async (): Promise<PiekoszowParcel[]> => {
    return dedupeParcelsById(await fetchAllLocalParcels())
}

const loadFallbackIndexParcels = async (): Promise<PiekoszowParcel[]> => {
    const [localParcels, geoportalParcels] = await Promise.all([
        fetchAllLocalParcels(),
        getAllGeoportalParcels()
    ])
    const localParcelIds = new Set(localParcels.map((parcel) => parcel.id))

    return dedupeParcelsById(
        geoportalParcels.filter((parcel) => !localParcelIds.has(parcel.id))
    )
}

const getParcelSpatialIndex = async (): Promise<ParcelSpatialIndex> => {
    if (!parcelSpatialIndexPromise) {
        parcelSpatialIndexPromise = loadPrimaryIndexParcels().then((parcels) => buildParcelSpatialIndex(parcels)).catch((error) => {
            parcelSpatialIndexPromise = null
            throw error
        })
    }

    return parcelSpatialIndexPromise
}

const getFallbackParcelSpatialIndex = async (): Promise<ParcelSpatialIndex> => {
    if (!fallbackParcelSpatialIndexPromise) {
        fallbackParcelSpatialIndexPromise = loadFallbackIndexParcels().then((parcels) => buildParcelSpatialIndex(parcels)).catch((error) => {
            fallbackParcelSpatialIndexPromise = null
            throw error
        })
    }

    return fallbackParcelSpatialIndexPromise
}

const mergePoleWithParcel = (pole: PowerPole, parcel: PiekoszowParcel): PowerPole => {
    const parcelDisplayAddress = buildDisplayCivicAddress(
        parcel.addressResolved,
        parcel.localityLabel,
        parcel.precinct,
        parcel.municipality
    )
    const parcelExactAddress = hasFullCivicAddress(parcelDisplayAddress) ? parcelDisplayAddress : ''
    const keepExistingExactAddress = hasFullCivicAddress(buildDisplayCivicAddress(
        pole.address,
        pole.localityLabel,
        pole.precinct,
        pole.municipality
    ))

    return {
        ...pole,
        parcelId: pole.parcelId || parcel.id,
        parcelNumber: pole.parcelNumber || parcel.parcelNumber,
        localityCode: pole.localityCode || parcel.localityCode,
        localityLabel: pole.localityLabel || parcel.localityLabel || parcel.municipality,
        municipality: pole.municipality || parcel.municipality,
        precinct: pole.precinct || parcel.precinct,
        county: pole.county || parcel.county,
        voivodeship: pole.voivodeship || parcel.voivodeship,
        address: keepExistingExactAddress ? pole.address : (parcelExactAddress || pole.address),
        addressSource: keepExistingExactAddress ? pole.addressSource : (parcelExactAddress ? 'official' : pole.addressSource),
        parcelSource: pole.parcelSource || 'live'
    }
}

const tryResolvePoleFromIndex = (pole: PowerPole, index: ParcelSpatialIndex): PowerPole | null => {
    const candidates = getCandidateParcels(index, pole.lat, pole.lng)
    if (candidates.length === 0) return null

    const bestParcel = chooseBestParcel(candidates, pole.lat, pole.lng)
    return bestParcel ? mergePoleWithParcel(pole, bestParcel) : null
}

export async function resolvePowerPolesWithLocalParcels(poles: PowerPole[]): Promise<PowerPole[]> {
    if (poles.length === 0) return poles

    const index = await getParcelSpatialIndex()
    const resolvedPoles: PowerPole[] = new Array(poles.length)
    const unresolvedPoleIndexes: number[] = []

    poles.forEach((pole, poleIndex) => {
        if (hasResolvedPoleParcelMetadata(pole)) {
            resolvedPoles[poleIndex] = pole
            return
        }

        const cacheKey = buildPoleCacheKey(pole)
        const cached = resolvedPoleCache.get(cacheKey)
        if (cached) {
            resolvedPoles[poleIndex] = cached
            return
        }

        const locallyResolvedPole = tryResolvePoleFromIndex(pole, index)
        if (locallyResolvedPole) {
            resolvedPoleCache.set(cacheKey, locallyResolvedPole)
            resolvedPoles[poleIndex] = locallyResolvedPole
            return
        }

        unresolvedPoleIndexes.push(poleIndex)
        resolvedPoles[poleIndex] = pole
    })

    if (unresolvedPoleIndexes.length === 0) {
        return resolvedPoles
    }

    const fallbackIndex = await getFallbackParcelSpatialIndex()

    unresolvedPoleIndexes.forEach((poleIndex) => {
        const pole = poles[poleIndex]
        const cacheKey = buildPoleCacheKey(pole)
        const fallbackResolvedPole = tryResolvePoleFromIndex(pole, fallbackIndex) || pole
        resolvedPoles[poleIndex] = fallbackResolvedPole
        resolvedPoleCache.set(cacheKey, fallbackResolvedPole)
    })

    return resolvedPoles
}
