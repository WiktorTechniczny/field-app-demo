import type { PowerLine, PowerPole } from './powerPoles'

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
const TILE_DEG = 0.5
const MAX_CONCURRENT_TILES = 4

type Bounds = { south: number; west: number; north: number; east: number }

type OsmElement =
    | { type: 'node'; id: number; lat: number; lon: number; tags?: Record<string, string> }
    | { type: 'way'; id: number; nodes: number[]; tags?: Record<string, string> }

function snapToTile(value: number): number {
    return Math.floor(value / TILE_DEG) * TILE_DEG
}

function tileKey(tileS: number, tileW: number): string {
    return `${tileS.toFixed(2)}|${tileW.toFixed(2)}`
}

function boundsToTiles(bounds: Bounds) {
    const tiles: { s: number; w: number; n: number; e: number; key: string }[] = []
    const s0 = snapToTile(bounds.south)
    const w0 = snapToTile(bounds.west)

    for (let s = s0; s < bounds.north; s = Math.round((s + TILE_DEG) * 1000) / 1000) {
        for (let w = w0; w < bounds.east; w = Math.round((w + TILE_DEG) * 1000) / 1000) {
            const n = Math.round((s + TILE_DEG) * 1000) / 1000
            const e = Math.round((w + TILE_DEG) * 1000) / 1000
            tiles.push({ s, w, n, e, key: tileKey(s, w) })
        }
    }

    return tiles
}

function parseVoltage(voltageRaw?: string): PowerPole['voltage'] {
    const values = `${voltageRaw || ''}`.split(';').map(v => parseInt(v.trim(), 10)).filter(v => isFinite(v))
    const max = values.length > 0 ? Math.max(...values) : 0
    if (max >= 110000) return 'wn'
    if (max >= 15000) return 'sn'
    if (max > 0) return 'nn'
    return 'unknown'
}

function parseOsmResponse(elements: OsmElement[]): { poles: PowerPole[]; lines: PowerLine[] } {
    const nodeMap = new Map<number, { lat: number; lon: number; tags?: Record<string, string> }>()

    for (const el of elements) {
        if (el.type === 'node') {
            nodeMap.set(el.id, { lat: el.lat, lon: el.lon, tags: el.tags })
        }
    }

    const nodeVoltageFromLine = new Map<number, { voltage: PowerPole['voltage']; voltageRaw?: string }>()
    const nodeTypeFromLine = new Map<number, 'pole' | 'tower'>()
    const addedNodeIds = new Set<number>()

    const lines: PowerLine[] = []

    for (const el of elements) {
        if (el.type !== 'way') continue
        const tags = el.tags || {}
        const powerTag = tags.power
        if (!powerTag || !['line', 'minor_line', 'cable'].includes(powerTag)) continue

        const coords: [number, number][] = []
        for (const nid of el.nodes || []) {
            const node = nodeMap.get(nid)
            if (node) coords.push([node.lon, node.lat])
        }
        if (coords.length < 2) continue

        const lineType: PowerLine['type'] = powerTag === 'minor_line' ? 'minor_line' : powerTag === 'line' ? 'line' : 'unknown'
        const voltageRaw = tags.voltage || undefined
        const voltage = parseVoltage(voltageRaw)

        lines.push({ id: el.id, coords, voltage, voltageRaw, type: lineType })

        for (const nid of el.nodes || []) {
            if (!nodeVoltageFromLine.has(nid) || voltage !== 'unknown') {
                nodeVoltageFromLine.set(nid, { voltage, voltageRaw })
            }
            if (!nodeTypeFromLine.has(nid)) {
                const nodeType = powerTag === 'line' && voltage === 'wn' ? 'tower' : 'pole'
                nodeTypeFromLine.set(nid, nodeType)
            }
            addedNodeIds.add(nid)
        }
    }

    const poles: PowerPole[] = []

    for (const nid of addedNodeIds) {
        const node = nodeMap.get(nid)
        if (!node) continue

        const lat = node.lat
        const lng = node.lon
        if (!isFinite(lat) || !isFinite(lng)) continue

        const nodeTags = node.tags || {}
        const explicitType = nodeTags.power === 'tower' ? 'tower' : nodeTags.power === 'pole' ? 'pole' : undefined
        const type: PowerPole['type'] = explicitType || nodeTypeFromLine.get(nid) || 'pole'

        const lineVoltage = nodeVoltageFromLine.get(nid)
        const ownVoltageRaw = nodeTags.voltage || nodeTags.cables || undefined
        const ownVoltage = ownVoltageRaw ? parseVoltage(ownVoltageRaw) : 'unknown'
        let voltage: PowerPole['voltage'] = ownVoltage !== 'unknown' ? ownVoltage : (lineVoltage?.voltage || 'unknown')
        if (voltage === 'unknown' && type === 'pole') voltage = 'nn'

        poles.push({
            id: nid,
            lat,
            lng,
            type,
            voltage,
            voltageRaw: ownVoltageRaw || lineVoltage?.voltageRaw || undefined
        })
    }

    for (const el of elements) {
        if (el.type !== 'node') continue
        if (addedNodeIds.has(el.id)) continue
        const tags = el.tags || {}
        if (!['tower', 'pole', 'substation'].includes(tags.power || '')) continue

        const lat = el.lat
        const lng = el.lon
        if (!isFinite(lat) || !isFinite(lng)) continue

        const type: PowerPole['type'] = tags.power === 'tower' ? 'tower' : tags.power === 'substation' ? 'station' : 'pole'
        const voltageRaw = tags.voltage || undefined
        let voltage = parseVoltage(voltageRaw)
        if (voltage === 'unknown' && type === 'pole') voltage = 'nn'

        poles.push({ id: el.id, lat, lng, type, voltage, voltageRaw })
        addedNodeIds.add(el.id)
    }

    return { poles, lines }
}

async function fetchTileFromOverpass(s: number, w: number, n: number, e: number): Promise<{ poles: PowerPole[]; lines: PowerLine[] }> {
    const query = [
        '[out:json][timeout:25];',
        '(',
        `  node["power"~"tower|pole|substation"](${s},${w},${n},${e});`,
        `  way["power"~"line|minor_line|cable"](${s},${w},${n},${e});`,
        ');',
        'out body;',
        '>;',
        'out skel qt;'
    ].join('\n')

    const response = await fetch(OVERPASS_URL, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(30_000)
    })

    if (!response.ok) throw new Error(`Overpass error: ${response.status}`)
    const json = await response.json() as { elements: OsmElement[] }
    return parseOsmResponse(json.elements || [])
}

const tileCache = new Map<string, Promise<{ poles: PowerPole[]; lines: PowerLine[] }>>()

function getCachedTile(key: string, s: number, w: number, n: number, e: number): Promise<{ poles: PowerPole[]; lines: PowerLine[] }> {
    if (!tileCache.has(key)) {
        tileCache.set(key, fetchTileFromOverpass(s, w, n, e).catch((err) => {
            tileCache.delete(key)
            console.warn(`Overpass tile ${key} failed:`, err)
            return { poles: [], lines: [] }
        }))
    }

    return tileCache.get(key)!
}

export async function fetchPowerDataForBounds(bounds: Bounds): Promise<{ poles: PowerPole[]; lines: PowerLine[] }> {
    const tiles = boundsToTiles(bounds)
    if (tiles.length === 0) return { poles: [], lines: [] }

    const poleMap = new Map<number, PowerPole>()
    const lineMap = new Map<number, PowerLine>()

    for (let i = 0; i < tiles.length; i += MAX_CONCURRENT_TILES) {
        const batch = tiles.slice(i, i + MAX_CONCURRENT_TILES)
        const results = await Promise.all(
            batch.map(({ s, w, n, e, key }) => getCachedTile(key, s, w, n, e))
        )
        for (const { poles, lines } of results) {
            for (const pole of poles) poleMap.set(pole.id, pole)
            for (const line of lines) lineMap.set(line.id, line)
        }
    }

    const allPoles = Array.from(poleMap.values()).filter(pole =>
        pole.lat >= bounds.south && pole.lat <= bounds.north &&
        pole.lng >= bounds.west && pole.lng <= bounds.east
    )

    const allLines = Array.from(lineMap.values()).filter(line =>
        line.coords.some(([lng, lat]) =>
            lat >= bounds.south - 0.01 && lat <= bounds.north + 0.01 &&
            lng >= bounds.west - 0.01 && lng <= bounds.east + 0.01
        )
    )

    return { poles: allPoles, lines: allLines }
}

export function clearOverpassCache() {
    tileCache.clear()
}
