import { fetchAllLocalParcels, fetchParcelByCoordinates, fetchParcelGeometryById, type PiekoszowParcel } from './piekoszowParcels'

const GRS80_A = 6378137
const GRS80_F = 1 / 298.257222101
const GRS80_E2 = 2 * GRS80_F - GRS80_F * GRS80_F
const GRS80_EP2 = GRS80_E2 / (1 - GRS80_E2)
const CS92_SCALE = 0.9993
const CS92_CENTRAL_MERIDIAN = (19 * Math.PI) / 180
const CS92_FALSE_EASTING = 500000
const CS92_FALSE_NORTHING = -5300000

const parcelSurfaceAreaCache = new Map<string, Promise<number | null>>()
let cachedLocalParcelsByIdPromise: Promise<Map<string, PiekoszowParcel>> | null = null

const formatSurfaceAreaNumber = (value: number, maximumFractionDigits: number): string =>
    value.toLocaleString('pl-PL', {
        minimumFractionDigits: 0,
        maximumFractionDigits
    })

export const parseSurfaceAreaSqm = (value?: string | null): number | null => {
    const raw = `${value || ''}`.trim()
    if (!raw) return null

    const normalizedUnits = raw
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
    const isHectares = /\bha\b/.test(normalizedUnits)
    const normalized = normalizedUnits
        .replace(/\s+/g, '')
        .replace(/m2|m²|ha|hektar(?:y|ow|a)?/giu, '')
        .replace(',', '.')

    const parsed = Number.parseFloat(normalized)
    if (!Number.isFinite(parsed)) return null

    return isHectares ? parsed * 10000 : parsed
}

export const formatSurfaceArea = (
    value?: string | null,
    options?: { mode?: 'ha' | 'both' | 'sqm' }
): string => {
    const squareMeters = parseSurfaceAreaSqm(value)
    if (squareMeters === null) return `${value || ''}`.trim()

    if (options?.mode === 'sqm') {
        return `${formatSurfaceAreaNumber(squareMeters, 2)} m2`
    }

    const hectares = squareMeters / 10000
    const hectareLabel = `${formatSurfaceAreaNumber(hectares, 2)} ha`
    if (options?.mode === 'both') {
        return `${hectareLabel} (${formatSurfaceAreaNumber(squareMeters, 2)} m2)`
    }

    return hectareLabel
}

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

    return {
        x: CS92_FALSE_EASTING + CS92_SCALE * n * (
            a +
            ((1 - t + c) * a ** 3) / 6 +
            ((5 - 18 * t + t ** 2 + 72 * c - 58 * GRS80_EP2) * a ** 5) / 120
        ),
        y: CS92_FALSE_NORTHING + CS92_SCALE * (
            meridianArc +
            n * tanPhi * (
                (a ** 2) / 2 +
                ((5 - t + 9 * c + 4 * c ** 2) * a ** 4) / 24 +
                ((61 - 58 * t + t ** 2 + 600 * c - 330 * GRS80_EP2) * a ** 6) / 720
            )
        )
    }
}

export const calculateParcelSurfaceAreaSqmFromGeometry = (parcel: Pick<PiekoszowParcel, 'coords'>): number | null => {
    if (!Array.isArray(parcel.coords) || parcel.coords.length < 4) return null

    const projectedRing = parcel.coords
        .map(([lng, lat]) => {
            const point = toEpsg2180(lat, lng)
            return [point.x, point.y] as const
        })
        .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))

    if (projectedRing.length < 4) return null

    let twiceArea = 0
    for (let index = 0; index < projectedRing.length; index += 1) {
        const [x1, y1] = projectedRing[index]
        const [x2, y2] = projectedRing[(index + 1) % projectedRing.length]
        twiceArea += (x1 * y2) - (x2 * y1)
    }

    const squareMeters = Math.abs(twiceArea) / 2
    return squareMeters > 0 ? squareMeters : null
}

const formatSurfaceAreaStorageValue = (squareMeters: number): string =>
    Number.isInteger(squareMeters) ? String(squareMeters) : squareMeters.toFixed(2).replace(/\.?0+$/, '')

const getCachedLocalParcelsById = async (): Promise<Map<string, PiekoszowParcel>> => {
    if (!cachedLocalParcelsByIdPromise) {
        cachedLocalParcelsByIdPromise = fetchAllLocalParcels().then((parcels) => new Map(parcels.map((parcel) => [parcel.id, parcel])))
    }

    return cachedLocalParcelsByIdPromise
}

const resolveParcelGeometryForLookup = async (lookup: {
    parcelId?: string | null
    lat?: number | null
    lng?: number | null
}): Promise<PiekoszowParcel | null> => {
    const parcelId = `${lookup.parcelId || ''}`.trim()
    if (parcelId) {
        const localParcelsById = await getCachedLocalParcelsById()
        const localMatch = localParcelsById.get(parcelId)
        if (localMatch) return localMatch

        const fetchedById = await fetchParcelGeometryById(parcelId)
        if (fetchedById) return fetchedById
    }

    const lat = Number(lookup.lat)
    const lng = Number(lookup.lng)
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return fetchParcelByCoordinates(lat, lng, { exactOnly: true })
    }

    return null
}

export async function resolveParcelSurfaceAreaSqmByLookup(lookup: {
    parcelId?: string | null
    lat?: number | null
    lng?: number | null
}): Promise<number | null> {
    const parcelId = `${lookup.parcelId || ''}`.trim()
    const key = parcelId
        ? `parcel:${parcelId}`
        : Number.isFinite(Number(lookup.lat)) && Number.isFinite(Number(lookup.lng))
            ? `point:${Number(lookup.lat).toFixed(6)}:${Number(lookup.lng).toFixed(6)}`
            : ''
    if (!key) return null

    if (!parcelSurfaceAreaCache.has(key)) {
        parcelSurfaceAreaCache.set(
            key,
            resolveParcelGeometryForLookup(lookup)
                .then((parcel) => (parcel ? calculateParcelSurfaceAreaSqmFromGeometry(parcel) : null))
                .catch(() => null)
        )
    }

    return parcelSurfaceAreaCache.get(key) || null
}

export const toParcelSurfaceAreaStorageValue = (squareMeters: number | null | undefined): string | null =>
    Number.isFinite(squareMeters) && Number(squareMeters) > 0
        ? formatSurfaceAreaStorageValue(Number(squareMeters))
        : null
