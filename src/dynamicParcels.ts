import Dexie, { type Table } from 'dexie'
import { getLocalityCodeFromParcelId, getLocalityLabelFromCode } from './localityCatalog'
import type { PiekoszowParcel } from './piekoszowParcels'

const WFS_PROXY = '/api/wfs-warszawa'
const TILE_DEG = 0.01
const MAX_CONCURRENT = 4
const PAGE_SIZE = 1500

type Bounds = { south: number; west: number; north: number; east: number }
type DynamicParcelFetchOptions = { localOnly?: boolean }

type CachedDynamicParcelTile = {
    key: string
    s: number
    w: number
    n: number
    e: number
    parcels: PiekoszowParcel[]
    updatedAt: number
}

class DynamicParcelCacheDB extends Dexie {
    tiles!: Table<CachedDynamicParcelTile, string>

    constructor() {
        super('dynamicParcelCache')
        this.version(1).stores({
            tiles: '&key, updatedAt'
        })
    }
}

const dynamicParcelCacheDB = new DynamicParcelCacheDB()

function snapToTile(v: number) {
    return Math.floor(v / TILE_DEG) * TILE_DEG
}

function tileKey(s: number, w: number) {
    return `${s.toFixed(3)}|${w.toFixed(3)}`
}

function boundsToTiles(bounds: Bounds) {
    const tiles: { s: number; w: number; n: number; e: number; key: string }[] = []
    const s0 = snapToTile(bounds.south)
    const w0 = snapToTile(bounds.west)
    for (let s = s0; s < bounds.north; s = Math.round((s + TILE_DEG) * 1e4) / 1e4) {
        for (let w = w0; w < bounds.east; w = Math.round((w + TILE_DEG) * 1e4) / 1e4) {
            const n = Math.round((s + TILE_DEG) * 1e4) / 1e4
            const e = Math.round((w + TILE_DEG) * 1e4) / 1e4
            tiles.push({ s, w, n, e, key: tileKey(s, w) })
        }
    }
    return tiles
}

function decodeXml(v: string) {
    return v
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
}

function extractTag(xml: string, tag: string): string {
    const m = xml.match(new RegExp(`<ewns:${tag}>([\\s\\S]*?)<\\/ewns:${tag}>`, 'i'))
    return m ? decodeXml(m[1].trim()) : ''
}

function extractPosLists(xml: string): string[] {
    return Array.from(xml.matchAll(/<gml:posList>([\s\S]*?)<\/gml:posList>/gi)).map(m => m[1].trim())
}

function buildCoords(posList: string): [number, number][] {
    const vals = posList.split(/\s+/).map(Number).filter(isFinite)
    const pts: [number, number][] = []
    for (let i = 0; i < vals.length - 1; i += 2) {
        pts.push([vals[i + 1], vals[i]])
    }
    if (pts.length > 0) {
        const [fx, fy] = pts[0]
        const [lx, ly] = pts[pts.length - 1]
        if (fx !== lx || fy !== ly) pts.push([fx, fy])
    }
    return pts
}

function parseMember(xml: string): PiekoszowParcel | null {
    const id = extractTag(xml, 'ID_DZIALKI')
    if (!id) return null

    const parcelNumber = extractTag(xml, 'NUMER_DZIALKI')
    const precinct = extractTag(xml, 'NAZWA_OBREBU')
    const municipality = extractTag(xml, 'NAZWA_GMINY')
    const localityCode = getLocalityCodeFromParcelId(id) || undefined
    const localityLabel = getLocalityLabelFromCode(localityCode) || precinct || municipality || undefined

    const posLists = extractPosLists(xml)
    const coords = posLists.length > 0 ? buildCoords(posLists[0]) : []
    if (coords.length < 4) return null

    const lats = coords.map(([, lat]) => lat)
    const lngs = coords.map(([lng]) => lng)
    const south = Math.min(...lats)
    const north = Math.max(...lats)
    const west = Math.min(...lngs)
    const east = Math.max(...lngs)
    const centerLat = (south + north) / 2
    const centerLng = (west + east) / 2

    return {
        id,
        label: parcelNumber || id,
        shortLabel: parcelNumber,
        parcelNumber,
        localityCode,
        precinct,
        municipality,
        localityLabel,
        county: 'powiat warszawski',
        voivodeship: '\u015bwi\u0119tokrzyskie',
        centerLat,
        centerLng,
        south,
        west,
        north,
        east,
        coords: coords as [number, number][],
        source: 'live' as const
    }
}

function parseWfsXml(xml: string): PiekoszowParcel[] {
    return Array.from(xml.matchAll(/<wfs:member>([\s\S]*?)<\/wfs:member>/gi))
        .map(m => parseMember(m[1]))
        .filter((p): p is PiekoszowParcel => p !== null)
}

async function fetchWfsTile(s: number, w: number, n: number, e: number): Promise<PiekoszowParcel[]> {
    const url = new URL(WFS_PROXY, location.origin)
    url.searchParams.set('SERVICE', 'WFS')
    url.searchParams.set('VERSION', '2.0.0')
    url.searchParams.set('REQUEST', 'GetFeature')
    url.searchParams.set('TYPENAMES', 'ewns:dzialki')
    url.searchParams.set('SRSNAME', 'urn:ogc:def:crs:EPSG::4326')
    url.searchParams.set('COUNT', `${PAGE_SIZE}`)
    url.searchParams.set('BBOX', `${s},${w},${n},${e}`)

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`WFS ${res.status}`)
    const xml = await res.text()
    return parseWfsXml(xml)
}

const tileCache = new Map<string, Promise<PiekoszowParcel[]>>()

async function readCachedTile(key: string): Promise<PiekoszowParcel[] | null> {
    try {
        const cached = await dynamicParcelCacheDB.tiles.get(key)
        return cached?.parcels || null
    } catch {
        return null
    }
}

async function writeCachedTile(key: string, s: number, w: number, n: number, e: number, parcels: PiekoszowParcel[]) {
    try {
        await dynamicParcelCacheDB.tiles.put({
            key,
            s,
            w,
            n,
            e,
            parcels,
            updatedAt: Date.now()
        })
    } catch {
    }
}

function getCachedTile(
    key: string,
    s: number,
    w: number,
    n: number,
    e: number,
    options?: DynamicParcelFetchOptions
): Promise<PiekoszowParcel[]> {
    const localOnly = Boolean(options?.localOnly)
    if (localOnly) {
        const inMemoryRequest = tileCache.get(key)
        if (inMemoryRequest) return inMemoryRequest
        return readCachedTile(key).then((cached) => cached || [])
    }

    if (!tileCache.has(key)) {
        tileCache.set(key, (async () => {
            const cached = await readCachedTile(key)
            if (cached) return cached

            try {
                const parcels = await fetchWfsTile(s, w, n, e)
                await writeCachedTile(key, s, w, n, e, parcels)
                return parcels
            } catch (err) {
                tileCache.delete(key)
                console.warn(`WFS tile ${key} failed:`, err)
                return []
            }
        })())
    }
    return tileCache.get(key)!
}

export async function fetchDynamicParcelsForBounds(bounds: Bounds, options?: DynamicParcelFetchOptions): Promise<PiekoszowParcel[]> {
    const tiles = boundsToTiles(bounds)
    if (tiles.length === 0) return []

    const parcelMap = new Map<string, PiekoszowParcel>()

    for (let i = 0; i < tiles.length; i += MAX_CONCURRENT) {
        const batch = tiles.slice(i, i + MAX_CONCURRENT)
        const results = await Promise.all(batch.map(({ s, w, n, e, key }) => getCachedTile(key, s, w, n, e, options)))
        for (const parcels of results) {
            for (const p of parcels) parcelMap.set(p.id, p)
        }
    }

    const pad = 0.0025
    return Array.from(parcelMap.values()).filter(p =>
        p.north >= bounds.south - pad &&
        p.south <= bounds.north + pad &&
        p.east >= bounds.west - pad &&
        p.west <= bounds.east + pad
    )
}

export async function findDynamicParcelById(parcelId: string): Promise<PiekoszowParcel | null> {
    const normalizedId = `${parcelId || ''}`.trim()
    if (!normalizedId) return null

    for (const cachedTilesPromise of tileCache.values()) {
        const cachedTiles = await cachedTilesPromise
        const foundInMemory = cachedTiles.find((parcel) => parcel.id === normalizedId)
        if (foundInMemory) return foundInMemory
    }

    try {
        const cachedTiles = await dynamicParcelCacheDB.tiles.toArray()
        for (const tile of cachedTiles) {
            const foundPersisted = tile.parcels.find((parcel) => parcel.id === normalizedId)
            if (foundPersisted) return foundPersisted
        }
    } catch {
    }

    return null
}
