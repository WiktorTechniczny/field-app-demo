import type { MapBounds, PiekoszowParcel } from './piekoszowParcels'
import { fetchAllLocalParcels } from './piekoszowParcels'

const OFFICIAL_ADDRESS_WFS_URL = 'https://mapy.geoportal.gov.pl/wss/ext/KrajowaIntegracjaNumeracjiAdresowej'
const OFFICIAL_ADDRESS_CACHE_URL = '/parcel_tiles/official_address_points_cache.json'
const ONGEO_PLOT_REVERSE_API_URL = 'https://plot.reverse.geocoding.api.ongeo.pl/1.0/search'
const ONGEO_GEOMETRY_ADDRESS_API_URL = 'https://address.reverse.geocoding.api.ongeo.pl/1.0/search_by_geometry'
const ONGEO_API_KEY = 'a9968cb3-5b6e-4c6a-a06c-97904fd58f4b'
const ADDRESS_WFS_PAGE_SIZE = 500
const ADDRESS_TILE_DEG = 0.05
const MAPSERVER_NS = 'http://mapserver.gis.umn.edu/mapserver'
const GML_NS = 'http://www.opengis.net/gml/3.2'
const STRICT_NEARBY_PARCEL_ADDRESS_MAX_DISTANCE_METERS = 12
const RELAXED_NEARBY_PARCEL_FETCH_PADDING_DEGREES = 0.0016
const WFS_ADDRESS_SRS = 'EPSG:2180'
const GRS80_A = 6378137
const GRS80_F = 1 / 298.257222101
const GRS80_E2 = 2 * GRS80_F - GRS80_F * GRS80_F
const GRS80_EP2 = GRS80_E2 / (1 - GRS80_E2)
const CS92_SCALE = 0.9993
const CS92_CENTRAL_MERIDIAN = (19 * Math.PI) / 180
const CS92_FALSE_EASTING = 500000
const CS92_FALSE_NORTHING = -5300000
const ADDRESS_FETCH_RETRIES = 2

export interface OfficialAddressPoint {
    lat: number
    lng: number
    locality: string
    street: string
    number: string
    postalCode: string
}

type ParcelAddressGeometry = Pick<PiekoszowParcel, 'id' | 'south' | 'west' | 'north' | 'east' | 'coords' | 'localityLabel' | 'precinct'>

const addressTileCache = new Map<string, Promise<OfficialAddressPoint[]>>()
let bundledOfficialAddressCachePromise: Promise<Record<string, OfficialAddressPoint[]>> | null = null

const normalizeComparableText = (value?: string | null): string =>
    `${value || ''}`
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()

const toEpsg2180 = (lat: number, lng: number): { x: number; y: number } => {
    const phi = (lat * Math.PI) / 180
    const lambda = (lng * Math.PI) / 180
    const sinPhi = Math.sin(phi)
    const cosPhi = Math.cos(phi)
    const tanPhi = Math.tan(phi)
    const n = GRS80_A / Math.sqrt(1 - GRS80_E2 * sinPhi * sinPhi)
    const t = tanPhi * tanPhi
    const c = GRS80_EP2 * cosPhi * cosPhi
    const a = (lambda - CS92_CENTRAL_MERIDIAN) * cosPhi
    const meridianArc = GRS80_A * (
        (1 - GRS80_E2 / 4 - (3 * GRS80_E2 ** 2) / 64 - (5 * GRS80_E2 ** 3) / 256) * phi -
        ((3 * GRS80_E2) / 8 + (3 * GRS80_E2 ** 2) / 32 + (45 * GRS80_E2 ** 3) / 1024) * Math.sin(2 * phi) +
        ((15 * GRS80_E2 ** 2) / 256 + (45 * GRS80_E2 ** 3) / 1024) * Math.sin(4 * phi) -
        ((35 * GRS80_E2 ** 3) / 3072) * Math.sin(6 * phi)
    )

    const easting = CS92_FALSE_EASTING + CS92_SCALE * n * (
        a +
        ((1 - t + c) * a ** 3) / 6 +
        ((5 - 18 * t + t ** 2 + 72 * c - 58 * GRS80_EP2) * a ** 5) / 120
    )
    const northing = CS92_FALSE_NORTHING + CS92_SCALE * (
        meridianArc +
        n * tanPhi * (
            (a ** 2) / 2 +
            ((5 - t + 9 * c + 4 * c ** 2) * a ** 4) / 24 +
            ((61 - 58 * t + t ** 2 + 600 * c - 330 * GRS80_EP2) * a ** 6) / 720
        )
    )

    // Geoportal WFS exposes EPSG:2180 coordinates in axis order northing, easting.
    return { x: northing, y: easting }
}

const fromEpsg2180 = (x: number, y: number): { lat: number; lng: number } => {
    const easting = y
    const northing = x
    const adjustedEasting = easting - CS92_FALSE_EASTING
    const adjustedNorthing = northing - CS92_FALSE_NORTHING
    const meridianArc = adjustedNorthing / CS92_SCALE
    const mu = meridianArc / (
        GRS80_A * (1 - GRS80_E2 / 4 - (3 * GRS80_E2 ** 2) / 64 - (5 * GRS80_E2 ** 3) / 256)
    )
    const e1 = (1 - Math.sqrt(1 - GRS80_E2)) / (1 + Math.sqrt(1 - GRS80_E2))
    const phi1 = mu +
        ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
        ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
        ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
        ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu)

    const sinPhi1 = Math.sin(phi1)
    const cosPhi1 = Math.cos(phi1)
    const tanPhi1 = Math.tan(phi1)
    const c1 = GRS80_EP2 * cosPhi1 * cosPhi1
    const t1 = tanPhi1 * tanPhi1
    const n1 = GRS80_A / Math.sqrt(1 - GRS80_E2 * sinPhi1 * sinPhi1)
    const r1 = (GRS80_A * (1 - GRS80_E2)) / Math.pow(1 - GRS80_E2 * sinPhi1 * sinPhi1, 1.5)
    const d = adjustedEasting / (n1 * CS92_SCALE)

    const phi = phi1 - ((n1 * tanPhi1) / r1) * (
        (d ** 2) / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * GRS80_EP2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * GRS80_EP2 - 3 * c1 ** 2) * d ** 6) / 720
    )
    const lambda = CS92_CENTRAL_MERIDIAN + (
        d -
        ((1 + 2 * t1 + c1) * d ** 3) / 6 +
        ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * GRS80_EP2 + 24 * t1 ** 2) * d ** 5) / 120
    ) / cosPhi1

    return {
        lat: (phi * 180) / Math.PI,
        lng: (lambda * 180) / Math.PI
    }
}

const snapTileCoordinate = (value: number): number => Math.floor((value + 1e-9) / ADDRESS_TILE_DEG) * ADDRESS_TILE_DEG

const tileBoundsForCoordinate = (lat: number, lng: number): MapBounds => {
    const south = snapTileCoordinate(lat)
    const west = snapTileCoordinate(lng)
    return {
        south,
        west,
        north: south + ADDRESS_TILE_DEG,
        east: west + ADDRESS_TILE_DEG
    }
}

const getTileKey = (bounds: MapBounds): string =>
    `${bounds.south.toFixed(4)}|${bounds.west.toFixed(4)}|${bounds.north.toFixed(4)}|${bounds.east.toFixed(4)}`

const getTileBoundsForArea = (bounds: MapBounds): MapBounds[] => {
    const tiles: MapBounds[] = []
    for (let lat = snapTileCoordinate(bounds.south); lat <= bounds.north + 1e-9; lat += ADDRESS_TILE_DEG) {
        for (let lng = snapTileCoordinate(bounds.west); lng <= bounds.east + 1e-9; lng += ADDRESS_TILE_DEG) {
            tiles.push(tileBoundsForCoordinate(lat, lng))
        }
    }
    return tiles
}

const expandBounds = (bounds: MapBounds, paddingDegrees: number): MapBounds => ({
    south: bounds.south - paddingDegrees,
    west: bounds.west - paddingDegrees,
    north: bounds.north + paddingDegrees,
    east: bounds.east + paddingDegrees
})

const buildEpsg2180Bbox = (bounds: MapBounds): string => {
    const corners = [
        toEpsg2180(bounds.south, bounds.west),
        toEpsg2180(bounds.south, bounds.east),
        toEpsg2180(bounds.north, bounds.west),
        toEpsg2180(bounds.north, bounds.east)
    ]
    const xs = corners.map((corner) => corner.x)
    const ys = corners.map((corner) => corner.y)

    return `${Math.min(...xs)},${Math.min(...ys)},${Math.max(...xs)},${Math.max(...ys)},${WFS_ADDRESS_SRS}`
}

const getElementText = (feature: Element, namespace: string, localName: string): string =>
    feature.getElementsByTagNameNS(namespace, localName)[0]?.textContent?.trim() || ''

const parseOfficialAddressFeatures = (xmlText: string): OfficialAddressPoint[] => {
    const xml = new DOMParser().parseFromString(xmlText, 'application/xml')
    const features = Array.from(xml.getElementsByTagNameNS(MAPSERVER_NS, 'prg-adresy'))

    return features.flatMap((feature) => {
        const posText = feature.getElementsByTagNameNS(GML_NS, 'pos')[0]?.textContent?.trim() || ''
        const [xRaw, yRaw] = posText.split(/\s+/).map(Number)
        if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) return []

        const { lat, lng } = fromEpsg2180(xRaw, yRaw)
        const locality = getElementText(feature, MAPSERVER_NS, 'miejscowosc')
        const street = getElementText(feature, MAPSERVER_NS, 'ulica')
        const number = getElementText(feature, MAPSERVER_NS, 'numer')
        const postalCode = getElementText(feature, MAPSERVER_NS, 'kod')

        if (!locality && !street && !number) return []

        return [{
            lat,
            lng,
            locality,
            street,
            number,
            postalCode
        }]
    })
}

const dedupeOfficialAddressPoints = (points: OfficialAddressPoint[]): OfficialAddressPoint[] => {
    const uniquePoints = new Map<string, OfficialAddressPoint>()

    points.forEach((point) => {
        const key = [
            point.lat.toFixed(7),
            point.lng.toFixed(7),
            normalizeComparableText(point.locality),
            normalizeComparableText(point.street),
            normalizeComparableText(point.number),
            normalizeComparableText(point.postalCode)
        ].join('|')

        if (!uniquePoints.has(key)) uniquePoints.set(key, point)
    })

    return Array.from(uniquePoints.values())
}

const getBundledOfficialAddressCache = async (): Promise<Record<string, OfficialAddressPoint[]>> => {
    if (!bundledOfficialAddressCachePromise) {
        bundledOfficialAddressCachePromise = fetch(OFFICIAL_ADDRESS_CACHE_URL)
            .then(async (response) => {
                if (!response.ok) throw new Error(`Bundled official address cache HTTP ${response.status}`)
                return response.json() as Promise<Record<string, OfficialAddressPoint[]>>
            })
            .catch((error) => {
                bundledOfficialAddressCachePromise = null
                throw error
            })
    }

    return bundledOfficialAddressCachePromise
}

const fetchBundledOfficialAddressTile = async (bounds: MapBounds): Promise<OfficialAddressPoint[]> => {
    const cache = await getBundledOfficialAddressCache().catch(() => null)
    if (!cache) return []

    const bundledPoints = cache[getTileKey(bounds)] || []
    return dedupeOfficialAddressPoints(
        bundledPoints.filter((point) =>
            Number.isFinite(point.lat) &&
            Number.isFinite(point.lng) &&
            (point.locality || point.street || point.number)
        )
    )
}

const fetchOfficialAddressTile = async (bounds: MapBounds): Promise<OfficialAddressPoint[]> => {
    const bundledPoints = await fetchBundledOfficialAddressTile(bounds).catch(() => [] as OfficialAddressPoint[])
    if (bundledPoints.length > 0) return bundledPoints

    const points: OfficialAddressPoint[] = []

    for (let startIndex = 0; ; startIndex += ADDRESS_WFS_PAGE_SIZE) {
        let lastError: unknown = null

        for (let attempt = 0; attempt <= ADDRESS_FETCH_RETRIES; attempt += 1) {
            try {
                const url = new URL(OFFICIAL_ADDRESS_WFS_URL)
                url.searchParams.set('SERVICE', 'WFS')
                url.searchParams.set('VERSION', '2.0.0')
                url.searchParams.set('REQUEST', 'GetFeature')
                url.searchParams.set('TYPENAMES', 'ms:prg-adresy')
                url.searchParams.set('SRSNAME', WFS_ADDRESS_SRS)
                url.searchParams.set('COUNT', `${ADDRESS_WFS_PAGE_SIZE}`)
                url.searchParams.set('STARTINDEX', `${startIndex}`)
                url.searchParams.set('BBOX', buildEpsg2180Bbox(bounds))

                const response = await fetch(url.toString())
                if (!response.ok) {
                    throw new Error(`Official address WFS HTTP ${response.status}`)
                }

                const xmlText = await response.text()
                const batch = parseOfficialAddressFeatures(xmlText)
                if (batch.length === 0) {
                    return dedupeOfficialAddressPoints(points)
                }

                points.push(...batch)
                if (batch.length < ADDRESS_WFS_PAGE_SIZE) {
                    return dedupeOfficialAddressPoints(points)
                }

                lastError = null
                break
            } catch (error) {
                lastError = error
                if (attempt < ADDRESS_FETCH_RETRIES) {
                    await new Promise((resolve) => window.setTimeout(resolve, 220 * (attempt + 1)))
                    continue
                }
            }
        }

        if (lastError) throw lastError
    }

    return dedupeOfficialAddressPoints(points)
}

const getOfficialAddressTile = (bounds: MapBounds): Promise<OfficialAddressPoint[]> => {
    const key = getTileKey(bounds)
    if (!addressTileCache.has(key)) {
        addressTileCache.set(key, fetchOfficialAddressTile(bounds).catch((error) => {
            addressTileCache.delete(key)
            throw error
        }))
    }

    return addressTileCache.get(key)!
}

export const fetchOfficialAddressPointsForBounds = async (bounds: MapBounds): Promise<OfficialAddressPoint[]> => {
    const tiles = getTileBoundsForArea(bounds)
    if (tiles.length === 0) return []

    const results = await Promise.all(tiles.map(getOfficialAddressTile))
    return dedupeOfficialAddressPoints(results.flat())
}

export const formatOfficialAddressPoint = (point: Pick<OfficialAddressPoint, 'locality' | 'street' | 'number' | 'postalCode'>): string => {
    const locality = `${point.locality || ''}`.trim()
    const street = `${point.street || ''}`.trim()
    const number = `${point.number || ''}`.trim()
    const postalCode = `${point.postalCode || ''}`.trim()

    const primary = street
        ? [street, number].filter(Boolean).join(' ').trim()
        : [locality, number].filter(Boolean).join(' ').trim()
    const suffix = street ? [locality, postalCode].filter(Boolean) : [postalCode].filter(Boolean)

    return [primary, ...suffix].filter(Boolean).join(', ')
}

export const resolveOfficialAddressForParcelNumber = async (
    parcel: Pick<PiekoszowParcel, 'id' | 'south' | 'west' | 'north' | 'east' | 'coords' | 'centerLat' | 'centerLng' | 'localityLabel' | 'precinct'>,
    houseNumber: string,
    preferredLocality?: string | null
): Promise<string | null> => {
    const normalizedHouseNumber = normalizeComparableText(houseNumber)
    if (!normalizedHouseNumber) return null

    const points = await fetchOfficialAddressPointsForBounds(
        expandBounds(parcel, RELAXED_NEARBY_PARCEL_FETCH_PADDING_DEGREES)
    )
    if (points.length === 0) return null

    const normalizedLocality = normalizeComparableText(preferredLocality || parcel.localityLabel || parcel.precinct)
    const matchingPoint = points
        .filter((point) =>
            normalizeComparableText(point.number) === normalizedHouseNumber &&
            isMatchingLocality(point.locality, normalizedLocality)
        )
        .map((point) => ({
            point,
            exactParcel: isPointWithinBounds(point, parcel) && (parcel.coords.length < 3 || isPointInsidePolygon(parcel.coords, point.lat, point.lng)),
            distanceToCenterMeters: distancePointToParcelCenterMeters(point, parcel),
            distanceToBoundsMeters: distancePointToBoundsMeters(point, parcel)
        }))
        .sort((left, right) =>
            Number(right.exactParcel) - Number(left.exactParcel) ||
            left.distanceToBoundsMeters - right.distanceToBoundsMeters ||
            left.distanceToCenterMeters - right.distanceToCenterMeters
        )[0]?.point

    return matchingPoint ? formatOfficialAddressPoint(matchingPoint) : null
}

const buildResolvedAddressFromOngeoAddress = (address: Record<string, unknown> | null | undefined): string | null => {
    if (!address) return null
    const street = `${address.street || address.road || ''}`.trim()
    const houseNumber = `${address.houseNumber || address.house_number || address.buildingNumber || ''}`.trim()
    const locality = `${address.city || address.locality || address.village || address.place || ''}`.trim()
    const postalCode = `${address.postalCode || address.postCode || address.zipCode || address.zip || ''}`.trim()

    const streetPart = [street, houseNumber].filter(Boolean).join(' ').trim()
    const localityPart = [locality, postalCode].filter(Boolean).join(', ').trim()
    const resolved = [streetPart, localityPart].filter(Boolean).join(', ').trim()
    return resolved || null
}

const fetchOngeoAddressForParcelGeometry = async (
    parcel: Pick<PiekoszowParcel, 'id' | 'centerLat' | 'centerLng'>
): Promise<string | null> => {
    const plotLookupUrl = new URL(ONGEO_PLOT_REVERSE_API_URL)
    plotLookupUrl.searchParams.set('api_key', ONGEO_API_KEY)
    plotLookupUrl.searchParams.set('point', `${parcel.centerLng},${parcel.centerLat}`)
    plotLookupUrl.searchParams.set('additionalData', 'details,address,boundary')

    const plotResponse = await fetch(plotLookupUrl.toString())
    if (!plotResponse.ok) {
        throw new Error(`OnGeo plot reverse HTTP ${plotResponse.status}`)
    }

    const plotPayload = await plotResponse.json().catch(() => null as {
        details?: { id?: string | null }
        point?: { coordinates?: number[] | null }
        boundary?: Record<string, unknown> | null
    } | null)

    if (normalizeComparableText(plotPayload?.details?.id || '') !== normalizeComparableText(parcel.id)) {
        return null
    }

    const geometryGeojson = plotPayload?.boundary
    const point = Array.isArray(plotPayload?.point?.coordinates)
        ? plotPayload.point.coordinates.join(',')
        : `${parcel.centerLng},${parcel.centerLat}`
    if (!geometryGeojson) return null

    const response = await fetch(ONGEO_GEOMETRY_ADDRESS_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': ONGEO_API_KEY
        },
        body: JSON.stringify({
            geometryGeojson,
            point,
            additionalData: ['address']
        })
    })

    if (!response.ok) {
        throw new Error(`OnGeo geometry HTTP ${response.status}`)
    }

    const payload = await response.json().catch(() => [] as Array<{ address?: Record<string, unknown> }>)
    const firstResult = Array.isArray(payload) ? payload[0] : payload
    return buildResolvedAddressFromOngeoAddress(firstResult?.address)
}

const isPointWithinBounds = (point: OfficialAddressPoint, bounds: MapBounds, paddingDegrees = 0): boolean =>
    point.lat >= bounds.south - paddingDegrees &&
    point.lat <= bounds.north + paddingDegrees &&
    point.lng >= bounds.west - paddingDegrees &&
    point.lng <= bounds.east + paddingDegrees

const distanceMeters = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
    const earthRadius = 6371000
    const dLat = (lat2 - lat1) * Math.PI / 180
    const dLng = (lng2 - lng1) * Math.PI / 180
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    return earthRadius * c
}

const distancePointToBoundsMeters = (point: OfficialAddressPoint, bounds: MapBounds): number => {
    const clampedLat = Math.min(Math.max(point.lat, bounds.south), bounds.north)
    const clampedLng = Math.min(Math.max(point.lng, bounds.west), bounds.east)
    return distanceMeters(point.lat, point.lng, clampedLat, clampedLng)
}

const distancePointToParcelCenterMeters = (
    point: OfficialAddressPoint,
    parcel: Pick<PiekoszowParcel, 'centerLat' | 'centerLng'>
): number => distanceMeters(point.lat, point.lng, parcel.centerLat, parcel.centerLng)

const hasUsableHouseNumber = (point: OfficialAddressPoint): boolean => normalizeComparableText(point.number).length > 0

const isMatchingLocality = (pointLocality: string, normalizedLocality: string): boolean => {
    if (!normalizedLocality) return true
    const normalizedPointLocality = normalizeComparableText(pointLocality)
    if (!normalizedPointLocality) return true

    return (
        normalizedPointLocality === normalizedLocality ||
        normalizedPointLocality.includes(normalizedLocality) ||
        normalizedLocality.includes(normalizedPointLocality)
    )
}

const buildOfficialAddressKey = (point: OfficialAddressPoint): string =>
    [
        normalizeComparableText(point.street),
        normalizeComparableText(point.number),
        normalizeComparableText(point.locality),
        normalizeComparableText(point.postalCode)
    ].join('|')

const doesParcelMatchLocality = (
    parcel: Pick<ParcelAddressGeometry, 'localityLabel' | 'precinct'>,
    normalizedLocality: string
): boolean => {
    if (!normalizedLocality) return true
    return isMatchingLocality(parcel.localityLabel || parcel.precinct || '', normalizedLocality)
}

export const isPointInsidePolygon = (ring: [number, number][], lat: number, lng: number): boolean => {
    if (ring.length < 3) return false

    let inside = false
    for (let currentIndex = 0, previousIndex = ring.length - 1; currentIndex < ring.length; previousIndex = currentIndex++) {
        const [currentLng, currentLat] = ring[currentIndex]
        const [previousLng, previousLat] = ring[previousIndex]
        const intersects = ((currentLat > lat) !== (previousLat > lat)) &&
            (lng < ((previousLng - currentLng) * (lat - currentLat)) / ((previousLat - currentLat) || Number.EPSILON) + currentLng)

        if (intersects) inside = !inside
    }

    return inside
}

export const resolveOfficialAddressForParcel = async (
    parcel: Pick<PiekoszowParcel, 'id' | 'south' | 'west' | 'north' | 'east' | 'coords' | 'centerLat' | 'centerLng' | 'localityLabel' | 'precinct'>,
    preferredLocality?: string | null
): Promise<string | null> => {
    const geometryResolvedAddress = await fetchOngeoAddressForParcelGeometry(parcel).catch(() => null)
    if (geometryResolvedAddress) return geometryResolvedAddress

    const points = await fetchOfficialAddressPointsForBounds(
        expandBounds(parcel, RELAXED_NEARBY_PARCEL_FETCH_PADDING_DEGREES)
    )
    if (points.length === 0) return null

    const normalizedLocality = normalizeComparableText(preferredLocality || parcel.localityLabel || parcel.precinct)
    const localParcels = await fetchAllLocalParcels().catch(() => [] as PiekoszowParcel[])
    const nearbyParcels: ParcelAddressGeometry[] = localParcels.filter((candidate) => {
        if (candidate.id === parcel.id) return true
        if (
            candidate.north < parcel.south - RELAXED_NEARBY_PARCEL_FETCH_PADDING_DEGREES ||
            candidate.south > parcel.north + RELAXED_NEARBY_PARCEL_FETCH_PADDING_DEGREES ||
            candidate.east < parcel.west - RELAXED_NEARBY_PARCEL_FETCH_PADDING_DEGREES ||
            candidate.west > parcel.east + RELAXED_NEARBY_PARCEL_FETCH_PADDING_DEGREES
        ) {
            return false
        }

        return doesParcelMatchLocality(candidate, normalizedLocality)
    })
    if (!nearbyParcels.some((candidate) => candidate.id === parcel.id)) {
        nearbyParcels.push(parcel)
    }

    const localityMatchedPoints = points.filter((point) => isMatchingLocality(point.locality, normalizedLocality))
    const parcelCandidatePoints = localityMatchedPoints.length > 0 ? localityMatchedPoints : points

    const parcelCandidates = parcelCandidatePoints
        .filter((point) => {
            if (!isPointWithinBounds(point, parcel)) return false
            if (parcel.coords.length >= 3 && !isPointInsidePolygon(parcel.coords, point.lat, point.lng)) return false
            return true
        })
        .map((point) => ({
            point,
            distanceToParcelBoundsMeters: 0,
            distanceToParcelCenterMeters: distancePointToParcelCenterMeters(point, parcel)
        }))

    const pointBelongsToCurrentParcel = (point: OfficialAddressPoint, maxDistanceMeters: number): boolean => {
        const exactParcel = nearbyParcels.find((candidate) =>
            isPointWithinBounds(point, candidate) &&
            (candidate.coords.length < 3 || isPointInsidePolygon(candidate.coords, point.lat, point.lng))
        )
        if (exactParcel) return exactParcel.id === parcel.id

        const rankedParcels = nearbyParcels
            .map((candidate) => ({
                id: candidate.id,
                distanceToParcelBoundsMeters: distancePointToBoundsMeters(point, candidate)
            }))
            .filter(({ distanceToParcelBoundsMeters }) => distanceToParcelBoundsMeters <= maxDistanceMeters + 0.5)
            .sort((left, right) => left.distanceToParcelBoundsMeters - right.distanceToParcelBoundsMeters)

        if (rankedParcels.length === 0) return false
        if (rankedParcels[0].id !== parcel.id) return false

        const competingParcel = rankedParcels.find((candidate) => candidate.id !== parcel.id)
        if (competingParcel && Math.abs(competingParcel.distanceToParcelBoundsMeters - rankedParcels[0].distanceToParcelBoundsMeters) <= 0.75) {
            return false
        }

        return true
    }

    const buildNearbyCandidates = (maxDistanceMeters: number) =>
        localityMatchedPoints
            .map((point) => ({
                point,
                distanceToParcelBoundsMeters: distancePointToBoundsMeters(point, parcel),
                distanceToParcelCenterMeters: distancePointToParcelCenterMeters(point, parcel)
            }))
            .filter(({ point, distanceToParcelBoundsMeters }) =>
                hasUsableHouseNumber(point) &&
                distanceToParcelBoundsMeters <= maxDistanceMeters &&
                pointBelongsToCurrentParcel(point, maxDistanceMeters)
            )

    const strictNearbyCandidates = buildNearbyCandidates(STRICT_NEARBY_PARCEL_ADDRESS_MAX_DISTANCE_METERS)
    const uniqueNearbyAddressCount = new Set(strictNearbyCandidates.map(({ point }) => buildOfficialAddressKey(point))).size
    const scoredCandidates = (
        parcelCandidates.length > 0
            ? parcelCandidates
            : uniqueNearbyAddressCount === 1
                ? strictNearbyCandidates
                : []
    )
        .sort((left, right) => {
            const numberedOrder = Number(hasUsableHouseNumber(right.point)) - Number(hasUsableHouseNumber(left.point))
            if (numberedOrder !== 0) return numberedOrder

            const boundsDistanceOrder = left.distanceToParcelBoundsMeters - right.distanceToParcelBoundsMeters
            if (Math.abs(boundsDistanceOrder) > 0.5) return boundsDistanceOrder

            const centerDistanceOrder = left.distanceToParcelCenterMeters - right.distanceToParcelCenterMeters
            if (Math.abs(centerDistanceOrder) > 0.5) return centerDistanceOrder

            const streetOrder = normalizeComparableText(left.point.street).localeCompare(normalizeComparableText(right.point.street))
            if (streetOrder !== 0) return streetOrder

            return left.point.number.localeCompare(right.point.number, 'pl', { numeric: true, sensitivity: 'base' })
        })

    const bestPoint = scoredCandidates[0]?.point

    return bestPoint ? formatOfficialAddressPoint(bestPoint) : null
}
