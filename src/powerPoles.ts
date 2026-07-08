import Dexie, { type Table } from 'dexie'
import { fetchParcelByCoordinates, fetchParcelGeometryById, fetchParcelLocalities, fetchPiekoszowParcelsForBounds, type PiekoszowParcel } from './piekoszowParcels'
import { fetchDynamicParcelsForBounds } from './dynamicParcels'
import { lookupGeoportalParcelByPoint } from './geoportalParcels'
import { fetchUldkParcelByCoordinates } from './uldkParcels'
import { getLocalityCodeFromParcelId, getLocalityLabelFromCode } from './localityCatalog'
import { fetchPowerDataForBounds } from './powerOverpass'
import { resolveOfficialAddressForParcel, resolveOfficialAddressForParcelNumber } from './officialAddressPoints'
import { supabase } from './supabase'
import { isLocalOnlyMapDataEnabled } from './mapDataMode'
import { boundaryPolygonContainsPoint, type BoundaryPolygon } from './mapScopeBoundaries'
import { buildDisplayCivicAddress, getCivicAddressQuality, hasFullCivicAddress, normalizeCivicAddress } from './civicAddress'

export interface PowerPole {
    id: number
    lat: number
    lng: number
    type: 'pole' | 'tower' | 'station'
    voltage: 'nn' | 'sn' | 'wn' | 'unknown'
    voltageRaw?: string
    parcelId?: string
    parcelNumber?: string
    localityCode?: string
    localityLabel?: string
    municipality?: string
    precinct?: string
    county?: string
    voivodeship?: string
    parcelSource?: 'local' | 'live' | 'local_audit' | 'uldk_api'
    address?: string
    addressSource?: 'official' | 'assignment'
    sourceDatasetKey?: string
    sourceLocalityKey?: string
    sourceLocalityLabel?: string
}

export interface PowerLine {
    id: number
    coords: [number, number][]
    voltage: PowerPole['voltage']
    voltageRaw?: string
    type: 'line' | 'minor_line' | 'unknown'
    localityCodes?: string[]
    localityLabels?: string[]
}

type Bounds = {
    south: number
    west: number
    north: number
    east: number
}

export class PowerCacheDB extends Dexie {
    poles!: Table<PowerPole, number>
    lines!: Table<PowerLine, number>

    constructor() {
        super('PowerInfrastructureCache')
        this.version(1).stores({
            poles: 'id, lat, lng, type, voltage',
            lines: 'id, voltage'
        })
        this.version(2).stores({
            poles: 'id, lat, lng, type, voltage',
            lines: 'id, voltage'
        }).upgrade(async (transaction) => {
            await transaction.table('poles').clear()
        })
    }
}

export const db = new PowerCacheDB()

const LOCAL_POWER_REGIONS = [
    { south: 50.23, north: 51.43, west: 19.72, east: 21.52, anchorLat: 50.23, anchorLng: 19.72 },
    { south: 52.10, north: 52.90, west: 15.00, east: 16.90, anchorLat: 0, anchorLng: 0 }
]
const POWER_TILES_DIR = '/power_tiles'
const POWER_TILE_DEG = 0.3
const BUNDLED_POLE_ASSIGNMENTS_URL = '/power_tiles/kmz_pole_assignments.json'
const BUNDLED_POLE_ASSIGNMENT_MAX_DISTANCE_METERS = 20
const NEARBY_PARCEL_FALLBACK_RADIUS_METERS = 22
const NEARBY_PARCEL_SEARCH_PADDING_METERS = 8
const RESOLVE_POWER_POLES_MAX_CONCURRENCY = 4

const powerTileCache = new Map<string, Promise<{ poles: PowerPole[]; lines: PowerLine[] }>>()
const resolvedPoleCache = new Map<string, Promise<PowerPole>>()
const resolvedPoleDetailsCache = new Map<string, Promise<PowerPole>>()
const resolvedPoleAssignmentAddressCache = new Map<string, Promise<string | null>>()
let bundledPoleAssignmentsPromise: Promise<Map<string, BundledPoleAssignment[]>> | null = null

type PowerFetchOptions = {
    localityCodes?: string[] | null
    countyLabels?: string[] | null
    precinctLabels?: string[] | null
    boundaryPolygons?: BoundaryPolygon[] | null
}

type BundledPoleAssignment = {
    parcelId: string
    parcelNumber?: string
    municipality?: string
    precinct?: string
    county?: string
    voivodeship?: string
    type?: PowerPole['type']
    lat: number
    lng: number
    bucket: string
}

type ResolvePowerPoleBatchOptions = {
    maxConcurrency?: number
}

function isPoleWithinBounds(pole: Pick<PowerPole, 'lat' | 'lng'>, bounds?: Bounds) {
    if (!bounds) return true
    return (
        pole.lat >= bounds.south &&
        pole.lat <= bounds.north &&
        pole.lng >= bounds.west &&
        pole.lng <= bounds.east
    )
}

function mergePolesById(...groups: PowerPole[][]) {
    const merged = new Map<number, PowerPole>()
    groups.forEach((group) => {
        group.forEach((pole) => {
            if (!merged.has(pole.id)) {
                merged.set(pole.id, pole)
                return
            }

            merged.set(pole.id, {
                ...merged.get(pole.id)!,
                ...pole
            })
        })
    })
    return Array.from(merged.values())
}

function mergeLinesById(...groups: PowerLine[][]) {
    const merged = new Map<number, PowerLine>()
    groups.forEach((group) => {
        group.forEach((line) => {
            if (!merged.has(line.id)) {
                merged.set(line.id, line)
                return
            }

            merged.set(line.id, {
                ...merged.get(line.id)!,
                ...line
            })
        })
    })
    return Array.from(merged.values())
}

async function persistPowerInfrastructureSnapshot(data: { poles: PowerPole[]; lines: PowerLine[] }) {
    if (data.poles.length === 0 && data.lines.length === 0) return

    try {
        await db.transaction('rw', db.poles, db.lines, async () => {
            if (data.poles.length > 0) {
                await db.poles.bulkPut(data.poles)
            }
            if (data.lines.length > 0) {
                await db.lines.bulkPut(data.lines)
            }
        })
    } catch (error) {
        console.warn('Failed to persist power infrastructure snapshot locally:', error)
    }
}

async function fetchStoredPowerPoles(bounds?: Bounds): Promise<PowerPole[]> {
    try {
        const storedPoles = await db.poles.toArray()
        return storedPoles.filter((pole) => isPoleWithinBounds(pole, bounds))
    } catch (error) {
        console.warn('Failed to read stored poles from local cache:', error)
        return []
    }
}

function isLineWithinBounds(line: Pick<PowerLine, 'coords'>, bounds?: Bounds, padding = 0.01) {
    if (!bounds) return true
    return line.coords.some(([lng, lat]) =>
        lat >= bounds.south - padding &&
        lat <= bounds.north + padding &&
        lng >= bounds.west - padding &&
        lng <= bounds.east + padding
    )
}

async function fetchStoredPowerLines(bounds?: Bounds): Promise<PowerLine[]> {
    try {
        const storedLines = await db.lines.toArray()
        return storedLines.filter((line) => isLineWithinBounds(line, bounds))
    } catch (error) {
        console.warn('Failed to read stored lines from local cache:', error)
        return []
    }
}

function parseVoltageCategory(voltageRaw?: string, voltageCode?: string): PowerPole['voltage'] {
    const normalizedCode = `${voltageCode || ''}`.trim().toLowerCase()
    if (normalizedCode === 'wn' || normalizedCode === 'sn' || normalizedCode === 'nn') {
        return normalizedCode
    }

    const values = `${voltageRaw || ''}`
        .split(';')
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((value) => Number.isFinite(value))

    const maxVoltage = values.length > 0 ? Math.max(...values) : 0
    if (maxVoltage >= 110000) return 'wn'
    if (maxVoltage >= 15000) return 'sn'
    if (maxVoltage > 0) return 'nn'
    return 'unknown'
}

function normalizeLocalityName(value?: string | null) {
    const raw = `${value || ''}`
    if (!raw) return ''

    const repaired = raw
        .replaceAll('Ă„â€¦', 'Ä…')
        .replaceAll('Ă„â€ˇ', 'Ä‡')
        .replaceAll('Ă„â„˘', 'Ä™')
        .replaceAll('Äąâ€š', 'Ĺ‚')
        .replaceAll('Äąâ€ž', 'Ĺ„')
        .replaceAll('Ä‚Ĺ‚', 'Ăł')
        .replaceAll('Äąâ€ş', 'Ĺ›')
        .replaceAll('ÄąĹź', 'Ĺş')
        .replaceAll('ÄąÂĽ', 'ĹĽ')
        .replaceAll('Ă„â€ž', 'Ä„')
        .replaceAll('Ă„â€ ', 'Ä†')
        .replaceAll('Ă„Â', 'Ä')
        .replaceAll('ÄąÂ', 'Ĺ')
        .replaceAll('ÄąÂ', 'Ĺ')
        .replaceAll('Ä‚â€ś', 'Ă“')
        .replaceAll('ÄąĹˇ', 'Ĺš')
        .replaceAll('ÄąÂą', 'Ĺą')
        .replaceAll('ÄąÂ»', 'Ĺ»')

    return repaired
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
}


function isInsideLocalRegion(bounds?: Bounds) {
    if (!bounds) return true
    const centerLat = (bounds.north + bounds.south) / 2
    const centerLng = (bounds.west + bounds.east) / 2
    return LOCAL_POWER_REGIONS.some(region => 
        centerLat >= region.south && centerLat <= region.north &&
        centerLng >= region.west && centerLng <= region.east
    )
}

function tileKey(south: number, west: number): string {
    const s = Math.round(south * 100)
    const w = Math.round(west * 100)
    return `tile_${s < 0 ? 'n' + Math.abs(s) : s}_${w < 0 ? 'n' + Math.abs(w) : w}`
}

function buildPoleAssignmentBucket(lat: number, lng: number) {
    return `${Math.floor(lat * 100)}|${Math.floor(lng * 100)}`
}

function normalizeBundledPoleType(rawType?: string | null): PowerPole['type'] | undefined {
    if (rawType === 'tower' || rawType === 'station' || rawType === 'pole') return rawType
    return undefined
}

function hasResolvedPoleParcelMetadata(pole: Pick<PowerPole, 'parcelId' | 'parcelNumber' | 'precinct'>) {
    return Boolean(pole.parcelId && pole.parcelNumber && pole.precinct)
}

function normalizePoleAddressCandidate(value?: string | null) {
    const normalized = normalizeCivicAddress(value)
    return normalized || null
}

function getPoleAddressCandidateScore(value?: string | null) {
    const normalized = normalizePoleAddressCandidate(value)
    if (!normalized) return 0

    let score = 1
    const quality = getCivicAddressQuality(normalized)
    if (quality === 'full') score += 10
    else if (quality === 'partial') score += 4
    if (/\d/.test(normalized)) score += 2
    if (normalized.includes(',')) score += 1
    if (normalized.length >= 18) score += 1
    return score
}

function extractHouseNumberFromAddress(value?: string | null) {
    const normalized = normalizePoleAddressCandidate(value)
    if (!normalized) return null

    const firstSegment = normalized.split(',')[0]?.trim() || normalized
    const match = firstSegment.match(/\d+[A-Za-z]?(?:\/\d+[A-Za-z]?)?/)
    return match ? match[0] : null
}

function normalizeAdministrativeLabel(prefix: string, value?: string | null) {
    const normalized = `${value || ''}`.trim()
    if (!normalized) return null
    return normalized.toLowerCase().startsWith(prefix.toLowerCase()) ? normalized : `${prefix} ${normalized}`
}

function sanitizePoleLocationLabel(value?: string | null) {
    const normalized = `${value || ''}`.trim()
    if (!normalized) return ''
    if (/^\d+(?:[./-]\d+)*$/.test(normalized)) return ''
    if (/^obr(?:\.|eb|ęb)?\s*\d+(?:[./-]\d+)*$/i.test(normalized.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) return ''
    if (/^unknown::/i.test(normalized)) return ''
    return normalized
}

export function hasPowerPoleExactAddress(
    poleOrAddress?: Pick<PowerPole, 'address' | 'localityLabel' | 'precinct' | 'municipality'> | string | null
) {
    if (typeof poleOrAddress === 'string' || poleOrAddress == null) {
        return hasFullCivicAddress(poleOrAddress)
    }

    return hasFullCivicAddress(buildDisplayCivicAddress(
        poleOrAddress.address,
        poleOrAddress.localityLabel,
        poleOrAddress.precinct,
        poleOrAddress.municipality
    ))
}

export function getPowerPoleDisplayAddress(pole: Pick<PowerPole, 'address' | 'localityLabel' | 'precinct' | 'municipality'>) {
    const displayAddress = buildDisplayCivicAddress(
        pole.address,
        pole.localityLabel,
        pole.precinct,
        pole.municipality
    )
    return hasPowerPoleExactAddress(displayAddress) ? normalizePoleAddressCandidate(displayAddress) || '' : ''
}

function hasResolvedPoleAddress(pole: Pick<PowerPole, 'address' | 'localityLabel' | 'precinct' | 'municipality'>) {
    return hasPowerPoleExactAddress(pole)
}

export function getPowerPoleSuggestedLocation(
    pole: Pick<PowerPole, 'parcelNumber' | 'localityLabel' | 'precinct' | 'municipality' | 'county' | 'voivodeship'>
) {
    const locality = sanitizePoleLocationLabel(pole.localityLabel) || sanitizePoleLocationLabel(pole.precinct)
    const municipality = normalizeAdministrativeLabel('gmina', pole.municipality)
    const county = normalizeAdministrativeLabel('powiat', pole.county)
    const voivodeship = normalizeAdministrativeLabel('woj.', pole.voivodeship)

    return locality || municipality || county || voivodeship || ''
}

export function getPowerPoleGoogleMapsUrl(pole: Pick<PowerPole, 'lat' | 'lng'>) {
    return `https://www.google.com/maps?q=${pole.lat.toFixed(6)},${pole.lng.toFixed(6)}`
}

async function resolvePowerPoleAddressFromAssignments(
    pole: Pick<PowerPole, 'parcelId' | 'parcelNumber' | 'localityLabel'>
): Promise<string | null> {
    const parcelId = `${pole.parcelId || ''}`.trim()
    const parcelNumber = `${pole.parcelNumber || ''}`.trim()
    const localityLabel = `${pole.localityLabel || ''}`.trim()
    const cacheKey = parcelId
        ? `parcel:${parcelId}`
        : parcelNumber
            ? `parcel-number:${parcelNumber}|${localityLabel.toLowerCase()}`
            : ''

    if (!cacheKey) return null

    const cached = resolvedPoleAssignmentAddressCache.get(cacheKey)
    if (cached) return cached

    const request = (async () => {
        try {
            let query = supabase
                .from('pole_assignments')
                .select('address')
                .not('address', 'is', null)

            if (parcelId) {
                query = query.eq('parcel_id', parcelId)
            } else {
                query = query.eq('parcel_number', parcelNumber)
                if (localityLabel) {
                    query = query.eq('locality', localityLabel)
                }
            }

            const { data, error } = await query.limit(20)
            if (error) return null

            return (data || [])
                .map((row) => normalizePoleAddressCandidate(row.address))
                .filter((address): address is string => Boolean(address))
                .sort((left, right) => getPoleAddressCandidateScore(right) - getPoleAddressCandidateScore(left))[0] || null
        } catch {
            return null
        }
    })()

    resolvedPoleAssignmentAddressCache.set(cacheKey, request)
    return request
}

export function hasPowerPoleParcelAssignment(pole: Pick<PowerPole, 'parcelId' | 'parcelNumber'>) {
    return Boolean(`${pole.parcelId || pole.parcelNumber || ''}`.trim())
}

async function loadBundledPoleAssignments(): Promise<Map<string, BundledPoleAssignment[]>> {
    if (!bundledPoleAssignmentsPromise) {
        bundledPoleAssignmentsPromise = (async () => {
            try {
                const response = await fetch(BUNDLED_POLE_ASSIGNMENTS_URL)
                if (!response.ok) return new Map<string, BundledPoleAssignment[]>()

                const rawAssignments = await response.json() as Array<Record<string, unknown>>
                const lookup = new Map<string, BundledPoleAssignment[]>()

                rawAssignments.forEach((entry) => {
                    const parcelId = `${entry['ParcelId'] ?? ''}`.trim()
                    const lat = Number(entry['Lat'])
                    const lng = Number(entry['Lng'])
                    if (!parcelId || !Number.isFinite(lat) || !Number.isFinite(lng)) return

                    const assignment: BundledPoleAssignment = {
                        parcelId,
                        parcelNumber: `${entry['ParcelNumber'] ?? ''}`.trim() || undefined,
                        municipality: `${entry['Municipality'] ?? ''}`.trim() || undefined,
                        precinct: `${entry['Precinct'] ?? ''}`.trim() || undefined,
                        county: `${entry['County'] ?? ''}`.trim() || undefined,
                        voivodeship: `${entry['Voivodeship'] ?? ''}`.trim() || undefined,
                        type: normalizeBundledPoleType(`${entry['Type'] ?? ''}`.trim().toLowerCase()),
                        lat,
                        lng,
                        bucket: `${entry['Bucket'] ?? ''}`.trim() || buildPoleAssignmentBucket(lat, lng)
                    }

                    const bucketAssignments = lookup.get(assignment.bucket) || []
                    bucketAssignments.push(assignment)
                    lookup.set(assignment.bucket, bucketAssignments)
                })

                return lookup
            } catch {
                return new Map<string, BundledPoleAssignment[]>()
            }
        })()
    }

    return bundledPoleAssignmentsPromise
}

function mergePoleWithBundledAssignment(pole: PowerPole, assignment: BundledPoleAssignment): PowerPole {
    const localityCode = pole.localityCode || getLocalityCodeFromParcelId(assignment.parcelId) || undefined
    const localityLabel = pole.localityLabel || getLocalityLabelFromCode(localityCode) || assignment.precinct || assignment.municipality || undefined

    return {
        ...pole,
        parcelId: pole.parcelId || assignment.parcelId,
        parcelNumber: pole.parcelNumber || assignment.parcelNumber,
        localityCode,
        localityLabel,
        municipality: pole.municipality || assignment.municipality,
        precinct: pole.precinct || assignment.precinct,
        county: pole.county || assignment.county,
        voivodeship: pole.voivodeship || assignment.voivodeship,
        parcelSource: pole.parcelSource || 'local'
    }
}

function enrichPoleWithBundledAssignment(pole: PowerPole, lookup: Map<string, BundledPoleAssignment[]>) {
    if (hasResolvedPoleParcelMetadata(pole)) return pole

    const candidates = lookup.get(buildPoleAssignmentBucket(pole.lat, pole.lng)) || []
    if (candidates.length === 0) return pole

    const closest = candidates
        .filter((candidate) => !candidate.type || candidate.type === pole.type)
        .map((candidate) => ({
            candidate,
            distance: distanceMeters(pole.lat, pole.lng, candidate.lat, candidate.lng)
        }))
        .sort((left, right) => left.distance - right.distance)[0]

    if (!closest || closest.distance > BUNDLED_POLE_ASSIGNMENT_MAX_DISTANCE_METERS) {
        return pole
    }

    return mergePoleWithBundledAssignment(pole, closest.candidate)
}

function tilesForBounds(bounds: Bounds) {
    const region = LOCAL_POWER_REGIONS.find(r => 
        bounds.south >= r.south - POWER_TILE_DEG && bounds.north <= r.north + POWER_TILE_DEG &&
        bounds.west >= r.west - POWER_TILE_DEG && bounds.east <= r.east + POWER_TILE_DEG
    ) || LOCAL_POWER_REGIONS[0]

    const snapLat = (v: number) => Math.floor((v - region.anchorLat) / POWER_TILE_DEG) * POWER_TILE_DEG + region.anchorLat
    const snapLng = (v: number) => Math.floor((v - region.anchorLng) / POWER_TILE_DEG) * POWER_TILE_DEG + region.anchorLng
    
    const tiles: { s: number; w: number; key: string }[] = []
    for (let s = snapLat(bounds.south); s < bounds.north; s = Math.round((s + POWER_TILE_DEG) * 1e4) / 1e4) {
        for (let w = snapLng(bounds.west); w < bounds.east; w = Math.round((w + POWER_TILE_DEG) * 1e4) / 1e4) {
            if (s >= region.south - POWER_TILE_DEG && s < region.north &&
                w >= region.west - POWER_TILE_DEG && w < region.east) {
                tiles.push({ s, w, key: tileKey(s, w) })
            }
        }
    }
    return tiles
}

type RawTilePole = {
    id: number
    type: string
    voltage: string
    voltageRaw?: string
    lat: number
    lng: number
    parcelId?: string
    parcelNumber?: string
    localityCode?: string
    localityLabel?: string
    municipality?: string
    precinct?: string
    source?: string
    sourceDatasetKey?: string
    sourceLocalityKey?: string
    sourceLocalityLabel?: string
}
type RawTileLine = { id: number; type: string; voltage: string; voltageRaw?: string; coords: [number, number][] }

async function fetchPowerTile(key: string): Promise<{ poles: PowerPole[]; lines: PowerLine[] }> {
    const url = `${POWER_TILES_DIR}/${key}.json`
    const [response, bundledPoleAssignments] = await Promise.all([
        fetch(url),
        loadBundledPoleAssignments()
    ])
    if (!response.ok) {
        if (response.status === 404) return { poles: [], lines: [] }
        throw new Error(`Power tile ${key}: HTTP ${response.status}`)
    }
    const json = await response.json() as { poles?: RawTilePole[]; lines?: RawTileLine[] }
    const resolvePoleLocalityCode = (rawPole: RawTilePole): string | undefined => {
        if (rawPole.localityCode) return rawPole.localityCode

        const normalizedSource = `${rawPole.source || ''}`.toLowerCase()
        if (normalizedSource.includes('pruszkow')) return '260409'
        if (normalizedSource.includes('slupy_') || normalizedSource.includes('piekosz')) return '260414'

        const normalizedLocality = normalizeLocalityName(rawPole.localityLabel || rawPole.municipality || '')
        if (normalizedLocality.includes('pruszkow')) return '260409'
        if (normalizedLocality.includes('piekosz')) return '260414'
        return undefined
    }
    const poles: PowerPole[] = (json.poles || []).map((p) => {
        const localityCode = resolvePoleLocalityCode(p)
        return enrichPoleWithBundledAssignment({
            id: p.id,
            lat: p.lat,
            lng: p.lng,
            type: p.type === 'tower' ? 'tower' : p.type === 'station' ? 'station' : 'pole',
            voltage: parseVoltageCategory(p.voltageRaw, ['wn','sn','nn'].includes(p.voltage) ? p.voltage : undefined),
            voltageRaw: p.voltageRaw,
            parcelId: p.parcelId,
            parcelNumber: p.parcelNumber,
            localityCode,
            localityLabel: p.localityLabel || getLocalityLabelFromCode(localityCode) || undefined,
            municipality: p.municipality,
            precinct: p.precinct,
            parcelSource: p.parcelId || p.parcelNumber ? 'local_audit' : undefined,
            sourceDatasetKey: p.sourceDatasetKey,
            sourceLocalityKey: p.sourceLocalityKey,
            sourceLocalityLabel: p.sourceLocalityLabel
        }, bundledPoleAssignments)
    })
    const lines: PowerLine[] = (json.lines || []).map((l) => ({
        id: l.id,
        coords: l.coords,
        voltage: parseVoltageCategory(l.voltageRaw, ['wn','sn','nn'].includes(l.voltage) ? l.voltage : undefined),
        voltageRaw: l.voltageRaw,
        type: l.type === 'minor_line' ? 'minor_line' : l.type === 'line' ? 'line' : 'unknown'
    }))
    return { poles, lines }
}

async function loadPowerTilesForBounds(bounds: Bounds): Promise<{ poles: PowerPole[]; lines: PowerLine[] }> {
    const tiles = tilesForBounds(bounds)
    if (tiles.length === 0) return { poles: [], lines: [] }

    for (const { key } of tiles) {
        if (!powerTileCache.has(key)) {
            powerTileCache.set(key, fetchPowerTile(key).catch((err) => {
                powerTileCache.delete(key)
                console.warn(`Power tile ${key} error:`, err)
                return { poles: [], lines: [] }
            }))
        }
    }

    const results = await Promise.all(tiles.map(({ key }) => powerTileCache.get(key)!))
    const poleMap = new Map<number, PowerPole>()
    const lineMap = new Map<number, PowerLine>()
    for (const { poles, lines } of results) {
        for (const p of poles) poleMap.set(p.id, p)
        for (const l of lines) lineMap.set(l.id, l)
    }
    return { poles: Array.from(poleMap.values()), lines: Array.from(lineMap.values()) }
}

async function loadLocalInfrastructure(bounds?: Bounds): Promise<{ poles: PowerPole[]; lines: PowerLine[] }> {
    const effectiveBounds = bounds ?? LOCAL_POWER_REGIONS[0]
    const data = await loadPowerTilesForBounds(effectiveBounds)
    void persistPowerInfrastructureSnapshot(data)
    return data
}


export async function fetchAllLocalPoles(bounds?: Bounds): Promise<PowerPole[]> {
    try {
        const localPoles = isInsideLocalRegion(bounds)
            ? (await loadLocalInfrastructure(bounds)).poles
            : []
        const storedPoles = await fetchStoredPowerPoles(bounds)
        return mergePolesById(localPoles, storedPoles)
    } catch (error) {
        console.error('Failed to load local poles:', error)
        return fetchStoredPowerPoles(bounds)
    }
}

function boundsContainsPoint(bounds: { south: number; west: number; north: number; east: number }, lat: number, lng: number, padding = 0) {
    return (
        lat >= bounds.south - padding &&
        lat <= bounds.north + padding &&
        lng >= bounds.west - padding &&
        lng <= bounds.east + padding
    )
}

function buildResolvedPoleCacheKey(pole: PowerPole) {
    return `${pole.id}|${pole.lat.toFixed(6)}|${pole.lng.toFixed(6)}`
}

function metersToLatDegrees(meters: number) {
    return meters / 111_320
}

function metersToLngDegrees(meters: number, lat: number) {
    const cosLat = Math.max(0.2, Math.cos(lat * Math.PI / 180))
    return meters / (111_320 * cosLat)
}

function createPoleParcelProbePoints(lat: number, lng: number) {
    const nearLat = metersToLatDegrees(1.8)
    const nearLng = metersToLngDegrees(1.8, lat)
    const farLat = metersToLatDegrees(4.2)
    const farLng = metersToLngDegrees(4.2, lat)
    const wideLat = metersToLatDegrees(9)
    const wideLng = metersToLngDegrees(9, lat)
    const outerLat = metersToLatDegrees(18)
    const outerLng = metersToLngDegrees(18, lat)

    return [
        { lat, lng, weight: 4, order: 0 },
        { lat: lat + nearLat, lng, weight: 2, order: 1 },
        { lat: lat - nearLat, lng, weight: 2, order: 2 },
        { lat, lng: lng + nearLng, weight: 2, order: 3 },
        { lat, lng: lng - nearLng, weight: 2, order: 4 },
        { lat: lat + farLat, lng, weight: 1, order: 5 },
        { lat: lat - farLat, lng, weight: 1, order: 6 },
        { lat, lng: lng + farLng, weight: 1, order: 7 },
        { lat, lng: lng - farLng, weight: 1, order: 8 },
        { lat: lat + nearLat, lng: lng + nearLng, weight: 2, order: 9 },
        { lat: lat + nearLat, lng: lng - nearLng, weight: 2, order: 10 },
        { lat: lat - nearLat, lng: lng + nearLng, weight: 2, order: 11 },
        { lat: lat - nearLat, lng: lng - nearLng, weight: 2, order: 12 },
        { lat: lat + wideLat, lng, weight: 1, order: 13 },
        { lat: lat - wideLat, lng, weight: 1, order: 14 },
        { lat, lng: lng + wideLng, weight: 1, order: 15 },
        { lat, lng: lng - wideLng, weight: 1, order: 16 },
        { lat: lat + wideLat, lng: lng + wideLng, weight: 1, order: 17 },
        { lat: lat + wideLat, lng: lng - wideLng, weight: 1, order: 18 },
        { lat: lat - wideLat, lng: lng + wideLng, weight: 1, order: 19 },
        { lat: lat - wideLat, lng: lng - wideLng, weight: 1, order: 20 },
        { lat: lat + outerLat, lng, weight: 1, order: 21 },
        { lat: lat - outerLat, lng, weight: 1, order: 22 },
        { lat, lng: lng + outerLng, weight: 1, order: 23 },
        { lat, lng: lng - outerLng, weight: 1, order: 24 },
        { lat: lat + outerLat, lng: lng + outerLng, weight: 1, order: 25 },
        { lat: lat + outerLat, lng: lng - outerLng, weight: 1, order: 26 },
        { lat: lat - outerLat, lng: lng + outerLng, weight: 1, order: 27 },
        { lat: lat - outerLat, lng: lng - outerLng, weight: 1, order: 28 }
    ]
}


function mergePoleWithParcel(pole: PowerPole, parcel: PiekoszowParcel): PowerPole {
    const parcelDisplayAddress = buildDisplayCivicAddress(
        parcel.addressResolved,
        parcel.localityLabel,
        parcel.precinct,
        parcel.municipality
    )
    const parcelExactAddress = hasFullCivicAddress(parcelDisplayAddress)
        ? normalizePoleAddressCandidate(parcelDisplayAddress) || undefined
        : undefined
    const keepExistingExactAddress = hasPowerPoleExactAddress(pole)

    return {
        ...pole,
        parcelId: parcel.id,
        parcelNumber: parcel.parcelNumber,
        localityCode: parcel.localityCode || pole.localityCode,
        localityLabel: parcel.localityLabel || parcel.municipality || pole.localityLabel,
        municipality: parcel.municipality,
        precinct: parcel.precinct,
        county: parcel.county,
        voivodeship: parcel.voivodeship,
        address: keepExistingExactAddress ? pole.address : (parcelExactAddress || pole.address),
        addressSource: keepExistingExactAddress ? pole.addressSource : (parcelExactAddress ? 'official' : pole.addressSource),
        parcelSource: 'live'
    }
}

function mergePoleWithAddress(pole: PowerPole, address: string, addressSource: PowerPole['addressSource'] = 'official'): PowerPole {
    return {
        ...pole,
        address: normalizePoleAddressCandidate(address) || address,
        addressSource
    }
}

function rememberResolvedPole(pole: PowerPole) {
    for (const cached of powerTileCache.values()) {
        void cached.then((tile) => {
            const storedPole = tile.poles.find((p) => p.id === pole.id)
            if (storedPole) Object.assign(storedPole, pole)
        })
    }

    void db.poles.put(pole).catch((error) => {
        console.warn('Failed to persist resolved pole locally:', error)
    })
}

function isPointInsideParcelGeometry(parcel: PiekoszowParcel, lat: number, lng: number) {
    if (parcel.coords.length < 3) {
        return lat >= parcel.south && lat <= parcel.north && lng >= parcel.west && lng <= parcel.east
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

function projectToMeters(lat: number, lng: number, referenceLat: number) {
    const safeCos = Math.max(0.2, Math.cos(referenceLat * Math.PI / 180))
    return {
        x: lng * 111_320 * safeCos,
        y: lat * 111_320
    }
}

function distanceFromPointToSegmentMeters(
    lat: number,
    lng: number,
    start: [number, number],
    end: [number, number]
) {
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

function distanceFromPointToParcelMeters(parcel: PiekoszowParcel, lat: number, lng: number) {
    if (isPointInsideParcelGeometry(parcel, lat, lng)) return 0

    if (parcel.coords.length >= 2) {
        let bestDistance = Number.POSITIVE_INFINITY
        for (let index = 0; index < parcel.coords.length - 1; index += 1) {
            const distance = distanceFromPointToSegmentMeters(lat, lng, parcel.coords[index], parcel.coords[index + 1])
            if (distance < bestDistance) bestDistance = distance
        }

        if (Number.isFinite(bestDistance)) return bestDistance
    }

    const clampedLat = Math.min(Math.max(lat, parcel.south), parcel.north)
    const clampedLng = Math.min(Math.max(lng, parcel.west), parcel.east)
    return distanceMeters(lat, lng, clampedLat, clampedLng)
}

function mergeParcelsById(...groups: PiekoszowParcel[][]) {
    const merged = new Map<string, PiekoszowParcel>()
    groups.forEach((group) => {
        group.forEach((parcel) => {
            if (!merged.has(parcel.id)) merged.set(parcel.id, parcel)
        })
    })
    return Array.from(merged.values())
}

function buildBoundsAroundPoint(lat: number, lng: number, radiusMeters: number): Bounds {
    const latPad = metersToLatDegrees(radiusMeters)
    const lngPad = metersToLngDegrees(radiusMeters, lat)
    return {
        south: lat - latPad,
        west: lng - lngPad,
        north: lat + latPad,
        east: lng + lngPad
    }
}

async function findNearbyParcelForPole(lat: number, lng: number): Promise<PiekoszowParcel | null> {
    const localOnlyMapData = isLocalOnlyMapDataEnabled()
    const searchBounds = buildBoundsAroundPoint(lat, lng, NEARBY_PARCEL_FALLBACK_RADIUS_METERS + NEARBY_PARCEL_SEARCH_PADDING_METERS)
    const localCandidates = await fetchPiekoszowParcelsForBounds(searchBounds).catch(() => [] as PiekoszowParcel[])
    const dynamicCandidates = localCandidates.length === 0
        ? await fetchDynamicParcelsForBounds(searchBounds, { localOnly: localOnlyMapData }).catch(() => [] as PiekoszowParcel[])
        : []

    const candidates = mergeParcelsById(localCandidates, dynamicCandidates)

    if (!localOnlyMapData && candidates.length === 0) {
        const fallbackProbes = [
            { lat: lat + metersToLatDegrees(8), lng },
            { lat: lat - metersToLatDegrees(8), lng },
            { lat, lng: lng + metersToLngDegrees(8, lat) },
            { lat, lng: lng - metersToLngDegrees(8, lat) }
        ]
        const uldkHits = await Promise.all(fallbackProbes.map((p) => fetchUldkParcelByCoordinates(p.lat, p.lng).catch(() => null)))
        candidates.push(...uldkHits.filter((p): p is PiekoszowParcel => p !== null))
    }

    const closest = candidates
        .map((parcel) => ({
            parcel,
            edgeDistance: distanceFromPointToParcelMeters(parcel, lat, lng),
            centerDistance: distanceMeters(lat, lng, parcel.centerLat, parcel.centerLng)
        }))
        .filter((candidate) => candidate.edgeDistance <= NEARBY_PARCEL_FALLBACK_RADIUS_METERS)
        .sort((left, right) =>
            left.edgeDistance - right.edgeDistance ||
            left.centerDistance - right.centerDistance ||
            left.parcel.id.localeCompare(right.parcel.id)
        )[0]

    return closest?.parcel || null
}

async function resolveMostLikelyParcelForPole(lat: number, lng: number): Promise<PiekoszowParcel | null> {
    const probes = createPoleParcelProbePoints(lat, lng)
    const tiers = [
        probes.filter(p => p.order === 0),
        probes.filter(p => p.order >= 1 && p.order <= 4),
        probes.filter(p => p.order >= 5 && p.order <= 12),
        probes.filter(p => p.order >= 13)
    ]

    const scores = new Map<string, { parcel: PiekoszowParcel; score: number; bestOrder: number }>()
    let centerParcelId: string | undefined

    for (const tierProbes of tiers) {
        const matches = await Promise.all(
            tierProbes.map(async (probe) => {
                try {
                    const parcel = await fetchParcelByCoordinates(probe.lat, probe.lng)
                    if (probe.order === 0) centerParcelId = parcel?.id
                    return parcel ? { parcel, weight: probe.weight, order: probe.order } : null
                } catch {
                    return null
                }
            })
        )

        matches.forEach((match) => {
            if (!match) return
            const existing = scores.get(match.parcel.id)
            if (existing) {
                existing.score += match.weight
                existing.bestOrder = Math.min(existing.bestOrder, match.order)
                return
            }
            scores.set(match.parcel.id, {
                parcel: match.parcel,
                score: match.weight,
                bestOrder: match.order
            })
        })

        if (scores.size > 0) {
            const top = Array.from(scores.values()).sort((a, b) => b.score - a.score)[0]
            if (top.score >= 4) break
        }
    }

    if (scores.size === 0) {
        const nearbyParcel = await findNearbyParcelForPole(lat, lng)
        if (nearbyParcel) return nearbyParcel
        return lookupGeoportalParcelByPoint(lat, lng)
    }

    const scoredMatch = Array.from(scores.values())
        .sort((left, right) =>
            right.score - left.score ||
            Number(left.bestOrder === 0) - Number(right.bestOrder === 0) ||
            Number(right.parcel.id === centerParcelId) - Number(left.parcel.id === centerParcelId) ||
            left.bestOrder - right.bestOrder
        )[0]?.parcel || null

    return scoredMatch
}

export async function resolvePowerPoleParcel(pole: PowerPole): Promise<PowerPole> {
    if (hasResolvedPoleParcelMetadata(pole)) {
        return pole
    }

    const cacheKey = buildResolvedPoleCacheKey(pole)
    const cached = resolvedPoleCache.get(cacheKey)
    if (cached) return cached

    const request = resolveMostLikelyParcelForPole(pole.lat, pole.lng)
        .then((parcel) => {
            if (!parcel) return pole

            const resolvedPole = mergePoleWithParcel(pole, parcel)
            Object.assign(pole, resolvedPole)
            rememberResolvedPole(resolvedPole)
            return resolvedPole
        })
        .catch(() => pole)

    resolvedPoleCache.set(cacheKey, request)
    return request
}

export async function resolvePowerPoleDetails(pole: PowerPole): Promise<PowerPole> {
    const resolvedPole = await resolvePowerPoleParcel(pole).catch(() => pole)
    if (!hasPowerPoleParcelAssignment(resolvedPole) || hasResolvedPoleAddress(resolvedPole)) {
        return resolvedPole
    }

    const cacheKey = buildResolvedPoleCacheKey(resolvedPole)
    const cached = resolvedPoleDetailsCache.get(cacheKey)
    if (cached) return cached

    const request = (async () => {
        let parcel = resolvedPole.parcelId
            ? await fetchParcelGeometryById(resolvedPole.parcelId).catch(() => null)
            : null

        if (!parcel) {
            parcel = await fetchParcelByCoordinates(resolvedPole.lat, resolvedPole.lng, { exactOnly: true }).catch(() => null)
        }

        const assignmentAddress = await resolvePowerPoleAddressFromAssignments(resolvedPole).catch(() => null)

        if (!parcel) {
            if (!assignmentAddress) return resolvedPole
            const enrichedPole = mergePoleWithAddress(resolvedPole, assignmentAddress, 'assignment')
            Object.assign(resolvedPole, enrichedPole)
            if (pole !== resolvedPole) Object.assign(pole, enrichedPole)
            rememberResolvedPole(enrichedPole)
            return enrichedPole
        }

        const officialAddress = await resolveOfficialAddressForParcel(
            parcel,
            resolvedPole.localityLabel || resolvedPole.precinct || parcel.localityLabel || parcel.precinct || null
        ).catch(() => null)
        const assignmentHouseNumber = extractHouseNumberFromAddress(assignmentAddress)
        const ruralOfficialAddress = !officialAddress && assignmentHouseNumber
            ? await resolveOfficialAddressForParcelNumber(
                parcel,
                assignmentHouseNumber,
                resolvedPole.localityLabel || resolvedPole.precinct || parcel.localityLabel || parcel.precinct || null
            ).catch(() => null)
            : null

        const bestOfficialAddress = officialAddress || ruralOfficialAddress
        const useOfficialAddress = getPoleAddressCandidateScore(bestOfficialAddress) > getPoleAddressCandidateScore(assignmentAddress)
        const resolvedAddress = useOfficialAddress ? bestOfficialAddress : assignmentAddress
        const resolvedAddressSource = useOfficialAddress ? 'official' : 'assignment'

        if (!resolvedAddress) return resolvedPole

        const enrichedPole = mergePoleWithAddress(resolvedPole, resolvedAddress, resolvedAddressSource)
        Object.assign(resolvedPole, enrichedPole)
        if (pole !== resolvedPole) Object.assign(pole, enrichedPole)
        rememberResolvedPole(enrichedPole)
        return enrichedPole
    })().catch(() => resolvedPole)

    resolvedPoleDetailsCache.set(cacheKey, request)
    return request
}

export async function resolvePowerPoleParcels(
    poles: PowerPole[],
    options?: ResolvePowerPoleBatchOptions
): Promise<PowerPole[]> {
    const unresolvedPoles = poles.filter((pole) => !hasResolvedPoleParcelMetadata(pole))
    if (unresolvedPoles.length === 0) return poles

    const resolvedById = new Map<number, PowerPole>()
    const workerCount = Math.max(1, Math.min(options?.maxConcurrency ?? RESOLVE_POWER_POLES_MAX_CONCURRENCY, unresolvedPoles.length))
    let cursor = 0

    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (true) {
            const currentIndex = cursor
            cursor += 1
            const pole = unresolvedPoles[currentIndex]
            if (!pole) return

            const resolved = await resolvePowerPoleParcel(pole).catch(() => pole)
            if (resolved.parcelId) resolvedById.set(pole.id, resolved)
        }
    }))

    if (resolvedById.size === 0) return poles
    return poles.map((pole) => resolvedById.get(pole.id) || pole)
}

async function filterPowerInfrastructureForScope(
    infrastructure: { poles: PowerPole[]; lines: PowerLine[] },
    bounds: Bounds,
    options?: PowerFetchOptions
): Promise<{ poles: PowerPole[]; lines: PowerLine[] }> {
    const linePadding = 0.01
    const localityCodes = new Set(options?.localityCodes || [])
    const countyNameKeys = new Set((options?.countyLabels || []).map((label) => normalizeLocalityName(label)).filter(Boolean))
    const precinctNameKeys = new Set((options?.precinctLabels || []).map((label) => normalizeLocalityName(label)).filter(Boolean))
    const boundaryPolygons = options?.boundaryPolygons || []
    const hasBoundaryPolygons = boundaryPolygons.length > 0
    const localitySummaries = localityCodes.size > 0 || precinctNameKeys.size > 0
        ? (await fetchParcelLocalities()).filter((locality) =>
            locality.localityCodes.some((code) => localityCodes.has(code)) ||
            precinctNameKeys.has(normalizeLocalityName(locality.label)) ||
            locality.precincts.some((precinct) => precinctNameKeys.has(normalizeLocalityName(precinct)))
        )
        : []
    const localityNameKeys = new Set(
        [
            ...localitySummaries.map((locality) => normalizeLocalityName(locality.label)),
            ...Array.from(localityCodes).map((code) => normalizeLocalityName(getLocalityLabelFromCode(code)))
        ].filter(Boolean)
    )

    const inBoundsPoles = infrastructure.poles.filter((pole) => {
        const insideFetchBounds =
            pole.lat >= bounds.south &&
            pole.lat <= bounds.north &&
            pole.lng >= bounds.west &&
            pole.lng <= bounds.east

        if (!insideFetchBounds) return false

        if (hasBoundaryPolygons) {
            return boundaryPolygonContainsPoint(boundaryPolygons, pole.lat, pole.lng)
        }

        return (
            (localityCodes.size === 0 && countyNameKeys.size === 0 && precinctNameKeys.size === 0) ||
            (pole.localityCode && localityCodes.has(pole.localityCode)) ||
            localitySummaries.some((locality) => boundsContainsPoint(locality, pole.lat, pole.lng, 0.0025)) ||
            localityNameKeys.has(normalizeLocalityName(pole.localityLabel)) ||
            localityNameKeys.has(normalizeLocalityName(pole.municipality)) ||
            precinctNameKeys.has(normalizeLocalityName(pole.precinct)) ||
            precinctNameKeys.has(normalizeLocalityName(pole.localityLabel)) ||
            countyNameKeys.has(normalizeLocalityName(pole.county)) ||
            countyNameKeys.has(normalizeLocalityName(pole.localityLabel))
        )
    })

    const inBoundsLines = infrastructure.lines
        .filter((line) =>
            line.coords.some(([lng, lat]) => {
                const insideBounds =
                    lat >= bounds.south - linePadding &&
                    lat <= bounds.north + linePadding &&
                    lng >= bounds.west - linePadding &&
                    lng <= bounds.east + linePadding
                if (!insideBounds) return false
                return !hasBoundaryPolygons || boundaryPolygonContainsPoint(boundaryPolygons, lat, lng)
            })
        )
        .map((line) => {
            const matchingLocalities = localitySummaries.filter((locality) =>
                line.coords.some(([lng, lat]) => boundsContainsPoint(locality, lat, lng, 0.004))
            )

            return {
                ...line,
                localityCodes: Array.from(new Set(matchingLocalities.flatMap((locality) => locality.localityCodes))),
                localityLabels: matchingLocalities.map((locality) => locality.label)
            } satisfies PowerLine
        })
        .filter((line) =>
            hasBoundaryPolygons ||
            countyNameKeys.size > 0 ||
            precinctNameKeys.size > 0 ||
            localityCodes.size === 0 ||
            (line.localityCodes || []).some((code) => localityCodes.has(code))
        )

    return { poles: inBoundsPoles, lines: inBoundsLines }
}

export async function fetchPowerData(bounds: Bounds, options?: PowerFetchOptions): Promise<{ poles: PowerPole[]; lines: PowerLine[] }> {
    const localOnlyMapData = isLocalOnlyMapDataEnabled()
    const useLocalRegionTiles = isInsideLocalRegion(bounds)

    try {
        if (useLocalRegionTiles) {
            const infrastructure = await loadLocalInfrastructure(bounds)
            const filteredLocalData = await filterPowerInfrastructureForScope(infrastructure, bounds, options)

            if (localOnlyMapData) {
                return filteredLocalData
            }

            const shouldAugmentFromRemote =
                filteredLocalData.lines.length === 0 ||
                (filteredLocalData.poles.length === 0 && (options?.localityCodes?.length || 0) > 0)

            if (!shouldAugmentFromRemote) {
                return filteredLocalData
            }

            const remoteData = await fetchPowerDataForBounds(bounds)
            void persistPowerInfrastructureSnapshot(remoteData)
            const filteredRemoteData = await filterPowerInfrastructureForScope(remoteData, bounds, options)

            return {
                poles: mergePolesById(filteredLocalData.poles, filteredRemoteData.poles),
                lines: mergeLinesById(filteredLocalData.lines, filteredRemoteData.lines)
            }
        }

        if (localOnlyMapData) {
            const [storedPoles, storedLines] = await Promise.all([
                fetchStoredPowerPoles(bounds),
                fetchStoredPowerLines(bounds)
            ])
            return filterPowerInfrastructureForScope({ poles: storedPoles, lines: storedLines }, bounds, options)
        }

        const remoteData = await fetchPowerDataForBounds(bounds)
        void persistPowerInfrastructureSnapshot(remoteData)
        return filterPowerInfrastructureForScope(remoteData, bounds, options)
    } catch (error) {
        console.error('Failed to load power infrastructure for bounds:', error)
        const [storedPoles, storedLines] = await Promise.all([
            fetchStoredPowerPoles(bounds),
            fetchStoredPowerLines(bounds)
        ])
        return filterPowerInfrastructureForScope({ poles: storedPoles, lines: storedLines }, bounds, options)
    }
}

export async function fetchLocalPolesForBounds(bounds: Bounds, opts?: { excludeTypes?: PowerPole['type'][] }): Promise<PowerPole[]> {
    const data = await fetchPowerData(bounds)
    const excludedTypes = opts?.excludeTypes || []
    return data.poles.filter((pole) => !excludedTypes.includes(pole.type))
}

export async function fetchPowerPoles(bounds: Bounds): Promise<PowerPole[]> {
    const data = await fetchPowerData(bounds)
    return data.poles
}

export async function snapToNearestPole(lat: number, lng: number, maxDist = 30): Promise<{ lat: number; lng: number }> {
    const searchBounds = buildBoundsAroundPoint(lat, lng, Math.max(maxDist * 3, 120))
    const poles = (await fetchAllLocalPoles(searchBounds)).filter((pole) => pole.type !== 'station')
    let minDistance = maxDist
    let bestPole: PowerPole | null = null

    for (const pole of poles) {
        const distance = distanceMeters(lat, lng, pole.lat, pole.lng)
        if (distance < minDistance) {
            minDistance = distance
            bestPole = pole
        }
    }

    return bestPole ? { lat: bestPole.lat, lng: bestPole.lng } : { lat, lng }
}

export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const earthRadius = 6371000
    const dLat = (lat2 - lat1) * Math.PI / 180
    const dLng = (lng2 - lng1) * Math.PI / 180
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
    return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export const voltageConfig: Record<PowerPole['voltage'], { color: string; label: string; border: string }> = {
    nn: { color: '#38bdf8', label: '0.4 kV', border: '#0284c7' },
    sn: { color: '#2563eb', label: '15 kV', border: '#1d4ed8' },
    wn: { color: '#ca8a04', label: '110 kV', border: '#a16207' },
    unknown: { color: '#64748b', label: 'Nieznane', border: '#475569' }
}

export function calculatePathDistance(points: { latitude: number; longitude: number }[]): number {
    if (points.length < 2) return 0

    let total = 0
    for (let index = 0; index < points.length - 1; index++) {
        total += distanceMeters(points[index].latitude, points[index].longitude, points[index + 1].latitude, points[index + 1].longitude)
    }

    return total / 1000
}

