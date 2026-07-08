import { getLocalityCodeFromParcelId, getLocalityLabelFromCode, getParcelNumberFromIdentifier } from './localityCatalog'
import type { PiekoszowParcel } from './piekoszowParcels'

const GEOPORTAL_GEOJSON_URL = '/piekoszow_dzialki_geometria.geojson'
const KML_GEOJSON_URL = '/piekoszow_kml_parcels.geojson'
const WFS_GEOJSON_URL = '/piekoszow_wfs_parcels.geojson'
const ONGEO_GEOJSON_URL = '/piekoszow_ongeo_parcels.geojson'

type GeoportalFeature = {
    type: 'Feature'
    properties: Record<string, unknown>
    geometry: {
        type: string
        coordinates: number[][][]
    }
}

type GeoportalCollection = {
    type: 'FeatureCollection'
    features: GeoportalFeature[]
}

type IndexedParcel = PiekoszowParcel & {
    ring: [number, number][]
}

let geoportalParcelsPromise: Promise<IndexedParcel[]> | null = null

function parseGeomExtent(extentStr: string): { south: number; west: number; north: number; east: number } | null {
    const parts = extentStr.split(',').map(Number)
    if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null
    const [west, south, east, north] = parts
    return { south, west, north, east }
}

function isPointInRing(ring: [number, number][], lat: number, lng: number): boolean {
    let inside = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [iLng, iLat] = ring[i]
        const [jLng, jLat] = ring[j]
        const intersects =
            (iLat > lat) !== (jLat > lat) &&
            lng < ((jLng - iLng) * (lat - iLat)) / ((jLat - iLat) || Number.EPSILON) + iLng
        if (intersects) inside = !inside
    }
    return inside
}

function parseGeoportalFeature(feature: GeoportalFeature): IndexedParcel | null {
    const props = feature.properties
    const id = `${props['ID_DZIALKI'] ?? props['id'] ?? ''}`.trim()
    if (!id) return null

    if (feature.geometry?.type !== 'Polygon' || !Array.isArray(feature.geometry.coordinates)) return null
    const outerRing = feature.geometry.coordinates[0]
    if (!Array.isArray(outerRing) || outerRing.length < 3) return null

    const ring: [number, number][] = outerRing
        .map((pt) => {
            if (!Array.isArray(pt) || pt.length < 2) return null
            const pLng = Number(pt[0])
            const pLat = Number(pt[1])
            if (!Number.isFinite(pLng) || !Number.isFinite(pLat)) return null
            return [pLng, pLat] as [number, number]
        })
        .filter((pt): pt is [number, number] => pt !== null)

    if (ring.length < 3) return null

    const extentStr = `${props['geom_extent'] ?? ''}`.trim()
    const extent = extentStr ? parseGeomExtent(extentStr) : null
    let south: number, west: number, north: number, east: number

    if (extent) {
        ;({ south, west, north, east } = extent)
    } else {
        const lats = ring.map(([, lat]) => lat)
        const lngs = ring.map(([lng]) => lng)
        south = Math.min(...lats)
        north = Math.max(...lats)
        west = Math.min(...lngs)
        east = Math.max(...lngs)
    }

    const centerLat = (south + north) / 2
    const centerLng = (west + east) / 2

    const parcelNumber = `${props['numer_dzialki'] ?? props['parcel'] ?? getParcelNumberFromIdentifier(id) ?? ''}`.trim()
    const municipality = `${props['gmina'] ?? props['commune'] ?? ''}`.trim() || undefined
    const precinct = `${props['region'] ?? ''}`.trim() || undefined
    const county = `${props['powiat'] ?? ''}`.trim() || undefined
    const localityCode = getLocalityCodeFromParcelId(id) || undefined
    const localityLabel = (getLocalityLabelFromCode(localityCode) || precinct || municipality || undefined)

    return {
        id,
        label: parcelNumber || id,
        shortLabel: parcelNumber,
        parcelNumber,
        localityCode,
        localityLabel,
        municipality,
        precinct,
        county,
        voivodeship: 'mazowieckie',
        centerLat,
        centerLng,
        south,
        west,
        north,
        east,
        coords: ring,
        source: 'live' as const,
        ring
    }
}

async function loadGeojsonFile(url: string): Promise<IndexedParcel[]> {
    try {
        const response = await fetch(url)
        if (!response.ok) return []
        const rawText = await response.text()
        const collection = JSON.parse(rawText.charCodeAt(0) === 0xFEFF ? rawText.slice(1) : rawText) as GeoportalCollection
        return (collection.features ?? []).flatMap((f) => {
            const p = parseGeoportalFeature(f)
            return p ? [p] : []
        })
    } catch {
        return []
    }
}

async function loadGeoportalParcels(): Promise<IndexedParcel[]> {
    const [main, kml, wfs, ongeo] = await Promise.all([
        loadGeojsonFile(GEOPORTAL_GEOJSON_URL),
        loadGeojsonFile(KML_GEOJSON_URL),
        loadGeojsonFile(WFS_GEOJSON_URL),
        loadGeojsonFile(ONGEO_GEOJSON_URL)
    ])
    return [...main, ...kml, ...wfs, ...ongeo]
}

function ensureGeoportalLoaded(): Promise<IndexedParcel[]> {
    if (!geoportalParcelsPromise) {
        geoportalParcelsPromise = loadGeoportalParcels().catch(() => [])
    }
    return geoportalParcelsPromise
}

/**
 * Finds the Geoportal parcel that truly contains the given point.
 * Returns null if no parcel polygon contains the point — no proximity guessing.
 */
export async function lookupGeoportalParcelByPoint(lat: number, lng: number): Promise<PiekoszowParcel | null> {
    const parcels = await ensureGeoportalLoaded()
    for (const parcel of parcels) {
        if (lat < parcel.south || lat > parcel.north || lng < parcel.west || lng > parcel.east) continue
        if (isPointInRing(parcel.ring, lat, lng)) return parcel
    }
    return null
}

export async function getAllGeoportalParcels(): Promise<PiekoszowParcel[]> {
    return ensureGeoportalLoaded()
}
