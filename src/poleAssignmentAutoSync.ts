import type { PoleAssignment } from './db'
import { supabase } from './supabase'
import { fetchParcelByCoordinates, fetchParcelGeometryById, type PiekoszowParcel } from './piekoszowParcels'
import { resolvePowerPolesWithLocalParcels } from './localPoleParcelResolution'
import { fetchPowerData, db as powerCacheDb, type PowerPole } from './powerPoles'
import { normalizeSalesMeetingAddress, normalizeSalesMeetingInlineText } from './salesMeetingText'
import {
    parseSurfaceAreaSqm,
    resolveParcelSurfaceAreaSqmByLookup,
    toParcelSurfaceAreaStorageValue
} from './parcelSurfaceArea'
import type { BoundaryPolygon } from './mapScopeBoundaries'

type Bounds = {
    south: number
    west: number
    north: number
    east: number
}

type SyncOptions = {
    bounds: Bounds
    localityCodes?: string[] | null
    countyLabels?: string[] | null
    precinctLabels?: string[] | null
    boundaryPolygons?: BoundaryPolygon[] | null
}

const TABLE_FETCH_BATCH_SIZE = 1000
const UPSERT_BATCH_SIZE = 250
const RESOLVE_POLES_MAX_CONCURRENCY = 12

function normalizeText(value: string) {
    return `${value || ''}`
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
}

function toNullableText(value: unknown): string | null {
    const text = `${value ?? ''}`.trim()
    return text || null
}

function normalizeParcelIdentifier(value?: string | null) {
    return `${value || ''}`
        .toLowerCase()
        .replace(/\s+/g, '')
        .trim()
}

function buildParcelContextKey(
    parcelNumber?: string | null,
    segments: Array<string | null | undefined> = []
) {
    const parcel = normalizeParcelIdentifier(parcelNumber)
    if (!parcel) return null

    const normalizedSegments = segments.map((value) => normalizeText(value || '')).filter(Boolean)
    if (normalizedSegments.length === 0) return null
    return [parcel, ...normalizedSegments].join('|')
}

function getParcelContextKeys(row: {
    parcelNumber?: string | null
    locality?: string | null
    municipality?: string | null
    county?: string | null
    voivodeship?: string | null
}) {
    const keys = [
        buildParcelContextKey(row.parcelNumber, [row.locality, row.municipality, row.county, row.voivodeship]),
        buildParcelContextKey(row.parcelNumber, [row.locality, row.municipality, row.county]),
        buildParcelContextKey(row.parcelNumber, [row.locality, row.municipality]),
        buildParcelContextKey(row.parcelNumber, [row.locality]),
        buildParcelContextKey(row.parcelNumber, [row.municipality, row.county, row.voivodeship]),
        buildParcelContextKey(row.parcelNumber, [row.municipality, row.county]),
        buildParcelContextKey(row.parcelNumber, [row.municipality]),
        buildParcelContextKey(row.parcelNumber, [row.county, row.voivodeship])
    ].filter((value): value is string => Boolean(value))

    return Array.from(new Set(keys))
}

function getExistingRowScore(row: PoleAssignment) {
    let score = 0
    if (typeof row.salesperson_id === 'number') score += 8
    if (row.planned_date) score += 8
    if (row.status_ph) score += 6
    if (normalizeSalesMeetingAddress(row.address)) score += 5
    if (row.notes) score += 4
    if (row.worker_notes) score += 4
    if (row.owner_details) score += 4
    if (row.kw_mode) score += 3
    if (row.kw_value) score += 2
    if (row.pge_servitude_status) score += 2
    if (typeof row.can_proceed === 'boolean') score += 2
    if (Number.isFinite(row.travel_minutes)) score += 2
    if (row.result_status) score += 2
    if (row.surface_area) score += 1
    return score
}

function chooseBestExistingRow(rows: PoleAssignment[]) {
    if (rows.length === 0) return null

    return [...rows].sort((left, right) => {
        const scoreDiff = getExistingRowScore(right) - getExistingRowScore(left)
        if (scoreDiff !== 0) return scoreDiff

        const leftId = typeof left.id === 'number' ? left.id : Number.MAX_SAFE_INTEGER
        const rightId = typeof right.id === 'number' ? right.id : Number.MAX_SAFE_INTEGER
        return leftId - rightId
    })[0] || null
}

function buildFallbackPoleAssignmentAddress(row: {
    address?: string | null
    locality?: string | null
    parcelNumber?: string | null
    parcelId?: string | null
}) {
    const normalizedAddress = normalizeSalesMeetingAddress(row.address)
    if (normalizedAddress) return normalizedAddress

    const locality = normalizeSalesMeetingInlineText(row.locality)
    const parcel = normalizeSalesMeetingInlineText(row.parcelNumber || row.parcelId)
    const fallback = [locality, parcel ? `dzialka ${parcel}` : ''].filter(Boolean).join(', ')
    return fallback || null
}

function mergePoleWithParcel(pole: PowerPole, parcel: PiekoszowParcel): PowerPole {
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
        parcelSource: 'live'
    }
}

async function resolvePoleParcelFast(pole: PowerPole): Promise<PowerPole> {
    if (pole.parcelId && pole.parcelNumber && pole.county && (pole.localityLabel || pole.precinct)) {
        return pole
    }

    const parcel = (
        pole.parcelId
            ? await fetchParcelGeometryById(pole.parcelId).catch(() => null)
            : await fetchParcelByCoordinates(pole.lat, pole.lng, { exactOnly: true }).catch(() => null)
    ) || await fetchParcelByCoordinates(pole.lat, pole.lng).catch(() => null)

    return parcel ? mergePoleWithParcel(pole, parcel) : pole
}

async function resolvePolesForAssignments(poles: PowerPole[]) {
    const preResolvedPoles = await resolvePowerPolesWithLocalParcels(poles)
    const resolvedById = new Map<number, PowerPole>()
    const workerCount = Math.max(1, Math.min(RESOLVE_POLES_MAX_CONCURRENCY, preResolvedPoles.length))
    let cursor = 0

    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (true) {
            const currentIndex = cursor
            cursor += 1
            const pole = preResolvedPoles[currentIndex]
            if (!pole) return

            const resolved = await resolvePoleParcelFast(pole).catch(() => pole)
            resolvedById.set(pole.id, resolved)
        }
    }))

    const resolvedPoles = preResolvedPoles.map((pole) => resolvedById.get(pole.id) || pole)
    try {
        await powerCacheDb.poles.bulkPut(resolvedPoles)
    } catch {
    }
    return resolvedPoles
}

async function loadAllPoleAssignmentsFromDb(): Promise<PoleAssignment[]> {
    const allRows: PoleAssignment[] = []

    for (let from = 0; ; from += TABLE_FETCH_BATCH_SIZE) {
        const { data, error } = await supabase
            .from('pole_assignments')
            .select('*')
            .range(from, from + TABLE_FETCH_BATCH_SIZE - 1)

        if (error) throw error

        const batch = (data || []) as PoleAssignment[]
        allRows.push(...batch)
        if (batch.length < TABLE_FETCH_BATCH_SIZE) break
    }

    return allRows
}

async function getParcelSurfaceAreaValue(row: Pick<PoleAssignment, 'parcel_id' | 'pole_lat' | 'pole_lng'>) {
    const squareMeters = await resolveParcelSurfaceAreaSqmByLookup({
        parcelId: row.parcel_id,
        lat: row.pole_lat,
        lng: row.pole_lng
    })

    return toParcelSurfaceAreaStorageValue(squareMeters)
}

function buildAutoImportKey(groupKey: string) {
    return `auto-pole-assignment|${groupKey}`
}

type ExistingRowLookups = {
    byImportKey: Map<string, PoleAssignment[]>
    byParcelId: Map<string, PoleAssignment[]>
    byContextKey: Map<string, PoleAssignment[]>
    byPoleId: Map<string, PoleAssignment[]>
}

function appendRowLookup(map: Map<string, PoleAssignment[]>, key: string | null | undefined, row: PoleAssignment) {
    if (!key) return
    const existing = map.get(key) || []
    existing.push(row)
    map.set(key, existing)
}

function buildExistingRowLookups(rows: PoleAssignment[]): ExistingRowLookups {
    const byImportKey = new Map<string, PoleAssignment[]>()
    const byParcelId = new Map<string, PoleAssignment[]>()
    const byContextKey = new Map<string, PoleAssignment[]>()
    const byPoleId = new Map<string, PoleAssignment[]>()

    rows.forEach((row) => {
        appendRowLookup(byImportKey, row.import_key, row)
        appendRowLookup(byParcelId, normalizeParcelIdentifier(row.parcel_id), row)
        appendRowLookup(byPoleId, normalizeText(row.pole_id || ''), row)
        getParcelContextKeys({
            parcelNumber: row.parcel_number,
            locality: row.locality,
            municipality: row.municipality,
            county: row.county,
            voivodeship: row.voivodeship
        }).forEach((contextKey) => appendRowLookup(byContextKey, contextKey, row))
    })

    return { byImportKey, byParcelId, byContextKey, byPoleId }
}

function findMatchingExistingRow(
    lookups: ExistingRowLookups,
    row: {
        importKey: string
        poleId?: string | null
        parcelId?: string | null
        parcelNumber?: string | null
        locality?: string | null
        municipality?: string | null
        county?: string | null
        voivodeship?: string | null
    }
) {
    const directImport = chooseBestExistingRow(lookups.byImportKey.get(row.importKey) || [])
    if (directImport) return directImport

    const directParcel = chooseBestExistingRow(lookups.byParcelId.get(normalizeParcelIdentifier(row.parcelId)) || [])
    if (directParcel) return directParcel

    const directPole = chooseBestExistingRow(lookups.byPoleId.get(normalizeText(row.poleId || '')) || [])
    if (directPole) return directPole

    for (const contextKey of getParcelContextKeys(row)) {
        const contextMatch = chooseBestExistingRow(lookups.byContextKey.get(contextKey) || [])
        if (contextMatch) return contextMatch
    }

    return null
}

type GroupedPoleRow = {
    groupKey: string
    pole_id: string | null
    pole_lat: number | null
    pole_lng: number | null
    voivodeship: string | null
    county: string | null
    municipality: string | null
    locality: string | null
    address: string | null
    parcel_number: string | null
    parcel_id: string | null
    surface_area: string | null
    pole_count: number
}

async function buildPoleAssignmentRowsFromResolvedPoles(
    poles: PowerPole[],
    existingRows: PoleAssignment[]
): Promise<PoleAssignment[]> {
    const groupedRows = new Map<string, GroupedPoleRow>()

    poles.forEach((pole) => {
        const poleId = toNullableText(pole.id)
        const parcelId = toNullableText(pole.parcelId)
        const parcelNumber = toNullableText(pole.parcelNumber)
        const locality = toNullableText(pole.localityLabel) || toNullableText(pole.precinct)
        const municipality = toNullableText(pole.municipality)
        const county = toNullableText(pole.county)
        const voivodeship = toNullableText(pole.voivodeship)
        const groupKey =
            (parcelId && `parcel:${normalizeParcelIdentifier(parcelId)}`) ||
            buildParcelContextKey(parcelNumber, [locality, municipality, county, voivodeship]) ||
            buildParcelContextKey(parcelNumber, [locality, municipality, county]) ||
            buildParcelContextKey(parcelNumber, [locality, municipality]) ||
            buildParcelContextKey(parcelNumber, [locality])

        if (!groupKey || (!parcelId && !parcelNumber)) return

        const existingGroup = groupedRows.get(groupKey)
        if (existingGroup) {
            existingGroup.pole_count += 1
            if (!existingGroup.pole_id && poleId) existingGroup.pole_id = poleId
            if (!Number.isFinite(existingGroup.pole_lat) && Number.isFinite(pole.lat)) existingGroup.pole_lat = pole.lat
            if (!Number.isFinite(existingGroup.pole_lng) && Number.isFinite(pole.lng)) existingGroup.pole_lng = pole.lng
            if (!existingGroup.parcel_id && parcelId) existingGroup.parcel_id = parcelId
            if (!existingGroup.parcel_number && parcelNumber) existingGroup.parcel_number = parcelNumber
            if (!existingGroup.locality && locality) existingGroup.locality = locality
            if (!existingGroup.municipality && municipality) existingGroup.municipality = municipality
            if (!existingGroup.county && county) existingGroup.county = county
            if (!existingGroup.voivodeship && voivodeship) existingGroup.voivodeship = voivodeship
            if (!existingGroup.address) {
                existingGroup.address = buildFallbackPoleAssignmentAddress({
                    locality,
                    parcelNumber,
                    parcelId
                })
            }
            return
        }

        groupedRows.set(groupKey, {
            groupKey,
            pole_id: poleId,
            pole_lat: Number.isFinite(pole.lat) ? pole.lat : null,
            pole_lng: Number.isFinite(pole.lng) ? pole.lng : null,
            voivodeship,
            county,
            municipality,
            locality,
            address: buildFallbackPoleAssignmentAddress({
                locality,
                parcelNumber,
                parcelId
            }),
            parcel_number: parcelNumber,
            parcel_id: parcelId,
            surface_area: null,
            pole_count: 1
        })
    })

    const existingLookups = buildExistingRowLookups(existingRows)
    const rows = await Promise.all(
        Array.from(groupedRows.values()).map(async (group) => {
            const computedImportKey = buildAutoImportKey(group.groupKey)
            const existingRow = findMatchingExistingRow(existingLookups, {
                importKey: computedImportKey,
                poleId: group.pole_id,
                parcelId: group.parcel_id,
                parcelNumber: group.parcel_number,
                locality: group.locality,
                municipality: group.municipality,
                county: group.county,
                voivodeship: group.voivodeship
            })

            const resolvedSurfaceArea =
                toParcelSurfaceAreaStorageValue(parseSurfaceAreaSqm(existingRow?.surface_area)) ||
                await getParcelSurfaceAreaValue({
                    parcel_id: group.parcel_id,
                    pole_lat: group.pole_lat,
                    pole_lng: group.pole_lng
                })

            return {
                ...existingRow,
                import_key: existingRow?.import_key || computedImportKey,
                pole_id: existingRow?.pole_id || group.pole_id,
                pole_lat: existingRow?.pole_lat ?? group.pole_lat,
                pole_lng: existingRow?.pole_lng ?? group.pole_lng,
                voivodeship: group.voivodeship || existingRow?.voivodeship || null,
                county: group.county || existingRow?.county || null,
                municipality: group.municipality || existingRow?.municipality || null,
                locality: group.locality || existingRow?.locality || null,
                address: normalizeSalesMeetingAddress(existingRow?.address) || group.address,
                parcel_number: group.parcel_number || existingRow?.parcel_number || null,
                parcel_id: group.parcel_id || existingRow?.parcel_id || null,
                surface_area: resolvedSurfaceArea || existingRow?.surface_area || null,
                pole_count: group.pole_count,
                imported_at: new Date().toISOString()
            } satisfies PoleAssignment
        })
    )

    return rows
}

export async function syncPoleAssignmentsFromScope(options: SyncOptions) {
    const { poles } = await fetchPowerData(options.bounds, {
        localityCodes: options.localityCodes && options.localityCodes.length > 0 ? options.localityCodes : null,
        countyLabels: options.countyLabels && options.countyLabels.length > 0 ? options.countyLabels : null,
        precinctLabels: options.precinctLabels && options.precinctLabels.length > 0 ? options.precinctLabels : null,
        boundaryPolygons: options.boundaryPolygons && options.boundaryPolygons.length > 0 ? options.boundaryPolygons : null
    })
    const candidatePoles = poles.filter((pole) => pole.type !== 'station')
    if (candidatePoles.length === 0) {
        return { poleCount: 0, rowCount: 0 }
    }

    const [existingRows, resolvedPoles] = await Promise.all([
        loadAllPoleAssignmentsFromDb(),
        resolvePolesForAssignments(candidatePoles)
    ])
    const rowsToUpsert = await buildPoleAssignmentRowsFromResolvedPoles(resolvedPoles, existingRows)
    if (rowsToUpsert.length === 0) {
        return { poleCount: resolvedPoles.length, rowCount: 0 }
    }

    for (let offset = 0; offset < rowsToUpsert.length; offset += UPSERT_BATCH_SIZE) {
        const batch = rowsToUpsert.slice(offset, offset + UPSERT_BATCH_SIZE)
        const { error } = await supabase.from('pole_assignments').upsert(batch, { onConflict: 'import_key' })
        if (error) throw error
    }

    return { poleCount: resolvedPoles.length, rowCount: rowsToUpsert.length }
}
