export type ParcelTileBounds = {
    south: number
    west: number
    north: number
    east: number
}

export type ParcelTileIndexEntry = {
    key: string
    count: number
}

export type ParcelTileIndex = {
    tileDeg: number
    bbox: ParcelTileBounds
    tiles: ParcelTileIndexEntry[]
}

let cachedParcelTileIndexPromise: Promise<ParcelTileIndex> | null = null

const FALLBACK_PARCEL_TILE_INDEX: ParcelTileIndex = {
    tileDeg: 0.05,
    bbox: {
        south: 50.72,
        west: 20.07,
        north: 51.01,
        east: 20.65
    },
    tiles: []
}

export function parseParcelTileKey(key: string, tileDeg = 0.05): ParcelTileBounds | null {
    const match = /^tile_(n?\d+)_(n?\d+)$/.exec(`${key || ''}`.trim())
    if (!match) return null

    const decode = (raw: string) => {
        const negative = raw.startsWith('n')
        const value = Number.parseInt(negative ? raw.slice(1) : raw, 10)
        if (!Number.isFinite(value)) return Number.NaN
        return (negative ? -value : value) / 100
    }

    const south = decode(match[1])
    const west = decode(match[2])
    if (![south, west].every(Number.isFinite)) return null

    return {
        south,
        west,
        north: south + tileDeg,
        east: west + tileDeg
    }
}

export function boundsIntersect(a: ParcelTileBounds, b: ParcelTileBounds) {
    return !(
        a.east < b.west ||
        a.west > b.east ||
        a.north < b.south ||
        a.south > b.north
    )
}

export function scopeHasOfflineParcelGeometry(scope: ParcelTileBounds, index?: ParcelTileIndex | null) {
    const effectiveIndex = index || FALLBACK_PARCEL_TILE_INDEX
    if (!boundsIntersect(scope, effectiveIndex.bbox)) return false
    if (!Array.isArray(effectiveIndex.tiles) || effectiveIndex.tiles.length === 0) return true

    return effectiveIndex.tiles.some((tile) => {
        const tileBounds = parseParcelTileKey(tile.key, effectiveIndex.tileDeg)
        return tileBounds ? boundsIntersect(scope, tileBounds) : false
    })
}

export async function fetchParcelTileIndex(): Promise<ParcelTileIndex> {
    if (!cachedParcelTileIndexPromise) {
        cachedParcelTileIndexPromise = fetch('/parcel_tiles/index.json')
            .then(async (response) => {
                if (!response.ok) {
                    throw new Error(`Parcel tile index HTTP ${response.status}`)
                }

                return response.json() as Promise<ParcelTileIndex>
            })
            .catch((error) => {
                cachedParcelTileIndexPromise = null
                throw error
            })
    }

    return cachedParcelTileIndexPromise
}
