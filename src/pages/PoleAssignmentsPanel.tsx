import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WheelEvent as ReactWheelEvent } from 'react'
import { memo } from 'react'
import toast from 'react-hot-toast'
import type {
    PoleAssignment,
    PoleAssignmentKwMode,
    PoleAssignmentPgeServitudeStatus,
    SalesMeeting,
    SalesMeetingStatus,
    User
} from '../db'
import { supabase } from '../supabase'
import { SALES_MEETING_STATUSES } from '../salesMeetingStatus'
import { mapSalesMeetingsMutationError } from '../salesMeetingsErrors'
import { normalizeSalesMeetingAddress, normalizeSalesMeetingInlineText } from '../salesMeetingText'
import { buildDisplayCivicAddress, getCivicAddressQuality } from '../civicAddress'
import { cleanDisplayText } from '../textNormalization'
import {
    formatPoleAssignmentTravel,
    getPoleAssignmentCanProceedLabel,
    getPoleAssignmentPgeLabel,
    getPoleAssignmentClientName,
    getPoleAssignmentLocationLabel,
    getPoleAssignmentStatusLabel,
    getPoleAssignmentWorkerNotes,
    parsePoleAssignmentStatus,
    POLE_ASSIGNMENT_CAN_PROCEED_OPTIONS,
    POLE_ASSIGNMENT_KW_OPTIONS,
    POLE_ASSIGNMENT_PGE_OPTIONS
} from '../poleAssignments'
import { getSalesMeetingDisplayMeta } from '../salesMeetingStatus'
import { fetchAllLocalPoles, getPowerPoleDisplayAddress } from '../powerPoles'
import { resolvePowerPolesWithLocalParcels } from '../localPoleParcelResolution'
import { fetchAllLocalParcels } from '../piekoszowParcels'
import {
    calculateParcelSurfaceAreaSqmFromGeometry,
    formatSurfaceArea,
    parseSurfaceAreaSqm,
    resolveParcelSurfaceAreaSqmByLookup,
    toParcelSurfaceAreaStorageValue
} from '../parcelSurfaceArea'

type AddressFilter = 'all' | 'exact' | 'needs_clarification'

const card = 'bg-white dark:bg-slate-800 rounded-xl border border-gray-200/60 dark:border-slate-700 shadow-md'
const inputClass =
    'w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-700 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/20 dark:border-slate-600 dark:bg-slate-900/60 dark:text-slate-100 dark:[color-scheme:dark]'
const selectClass =
    'w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-700 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/20 dark:border-slate-600 dark:bg-slate-900/60 dark:text-slate-100'
const PARCEL_AREA_GEOJSON_URL = '/piekoszow_dzialki_geometria.geojson'
const PARCEL_METADATA_GEOJSON_URLS = [PARCEL_AREA_GEOJSON_URL, '/piekoszow_kml_parcels.geojson'] as const
const TABLE_FETCH_BATCH_SIZE = 1000
const PAGE_SIZE_OPTIONS = [25, 50, 100, 250] as const
const EXTENDED_SALES_MEETING_ASSIGNMENT_KEYS = [
    'county',
    'surface_area',
    'kw_mode',
    'kw_value',
    'pge_servitude_status',
    'owner_details',
    'can_proceed',
    'travel_minutes',
    'result_status',
    'worker_notes'
] as const

type ParcelAreaFeatureCollection = {
    features?: Array<{
        properties?: Record<string, unknown>
    }>
}

type ParcelImportMeta = {
    parcelId: string | null
    parcelNumber: string | null
    locality: string | null
    municipality: string | null
    county: string | null
    voivodeship: string | null
    surfaceArea: string | null
}

type ParcelImportMetadata = {
    byParcelId: Map<string, ParcelImportMeta>
    byContextKey: Map<string, ParcelImportMeta>
}

let parcelImportMetadataPromise: Promise<ParcelImportMetadata> | null = null
let cachedOfflinePowerTileRowsPromise: Promise<PoleAssignment[]> | null = null

type CachedUldkParcelEntry = {
    id?: string | null
    voivodeship?: string | null
    county?: string | null
    municipality?: string | null
    localityLabel?: string | null
    number?: string | null
}

const normalizeText = (value: string): string =>
    `${value || ''}`
        .replace(/[Łł]/g, (char) => (char === 'Ł' ? 'L' : 'l'))
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()


const getScheduledTimePart = (value?: string | null): string => {
    const date = new Date(`${value || ''}`)
    if (!Number.isNaN(date.getTime())) {
        const hh = String(date.getHours()).padStart(2, '0')
        const mm = String(date.getMinutes()).padStart(2, '0')
        return `${hh}:${mm}`
    }

    const match = `${value || ''}`.match(/T(\d{2}:\d{2})/)
    return match?.[1] || '10:00'
}

const getDatePartFromIsoValue = (value?: string | null): string => {
    const match = `${value || ''}`.match(/^(\d{4}-\d{2}-\d{2})/)
    return match?.[1] || ''
}

const buildImportKey = (row: {
    poleId?: string | null
    parcelId?: string | null
    parcelNumber?: string | null
    locality?: string | null
    address?: string | null
}): string => {
    const parts = [
        normalizeText(row.poleId || ''),
        normalizeText(row.parcelId || ''),
        normalizeText(row.parcelNumber || ''),
        normalizeText(row.locality || ''),
        normalizeText(row.address || '')
    ].filter(Boolean)

    return parts.join('|') || `manual|${globalThis.crypto?.randomUUID?.() ?? Date.now()}`
}

type PoleAssignmentGroupingCandidate = {
    parcelId?: string | null
    parcelNumber?: string | null
    locality?: string | null
    municipality?: string | null
    county?: string | null
    voivodeship?: string | null
}

type PoleAssignmentGroupedItems<T> = {
    items: T[]
    aliases: string[]
}

const getPoleAssignmentGroupingAliases = (row: PoleAssignmentGroupingCandidate): string[] => {
    const aliases: string[] = []
    const parcelIdKey = normalizeParcelIdentifier(row.parcelId)
    if (parcelIdKey) aliases.push(`parcel:${parcelIdKey}`)

    getParcelContextKeys({
        parcelNumber: row.parcelNumber,
        locality: row.locality,
        municipality: row.municipality,
        county: row.county,
        voivodeship: row.voivodeship
    }).forEach((contextKey) => {
        aliases.push(`context:${contextKey}`)
    })

    return Array.from(new Set(aliases))
}

const groupPoleAssignmentItems = <T extends PoleAssignmentGroupingCandidate>(items: T[]): Array<PoleAssignmentGroupedItems<T>> => {
    const groups = new Map<number, { items: T[]; aliases: Set<string> }>()
    const aliasToGroupId = new Map<string, number>()
    let nextGroupId = 0

    items.forEach((item) => {
        const aliases = getPoleAssignmentGroupingAliases(item)

        if (aliases.length === 0) {
            groups.set(nextGroupId, { items: [item], aliases: new Set() })
            nextGroupId += 1
            return
        }

        const matchedGroupIds = Array.from(
            new Set(aliases.map((alias) => aliasToGroupId.get(alias)).filter((groupId): groupId is number => typeof groupId === 'number'))
        )

        let targetGroupId = matchedGroupIds[0]
        if (typeof targetGroupId !== 'number') {
            targetGroupId = nextGroupId
            groups.set(targetGroupId, { items: [], aliases: new Set() })
            nextGroupId += 1
        }

        const targetGroup = groups.get(targetGroupId)
        if (!targetGroup) return

        targetGroup.items.push(item)
        aliases.forEach((alias) => targetGroup.aliases.add(alias))

        matchedGroupIds.slice(1).forEach((groupId) => {
            const groupToMerge = groups.get(groupId)
            if (!groupToMerge || groupId === targetGroupId) return

            groupToMerge.items.forEach((groupItem) => targetGroup.items.push(groupItem))
            groupToMerge.aliases.forEach((alias) => targetGroup.aliases.add(alias))
            groups.delete(groupId)
        })

        targetGroup.aliases.forEach((alias) => {
            aliasToGroupId.set(alias, targetGroupId!)
        })
    })

    return Array.from(groups.values()).map((group) => ({
        items: group.items,
        aliases: Array.from(group.aliases)
    }))
}

const pickFirstNonEmptyText = (...values: Array<string | null | undefined>): string | null => {
    for (const value of values) {
        const text = toNullableText(value)
        if (text) return text
    }

    return null
}

const pickFirstFiniteNumber = (...values: Array<number | null | undefined>): number | null => {
    for (const value of values) {
        if (Number.isFinite(value)) return Number(value)
    }

    return null
}

const pickFirstBoolean = (...values: Array<boolean | null | undefined>): boolean | null => {
    for (const value of values) {
        if (typeof value === 'boolean') return value
    }

    return null
}

const getPoleIdentityKey = (row: Pick<PoleAssignment, 'pole_id' | 'pole_lat' | 'pole_lng' | 'import_key'>): string | null => {
    const poleId = normalizeText(row.pole_id || '')
    if (poleId) return `id:${poleId}`

    const lat = Number(row.pole_lat)
    const lng = Number(row.pole_lng)
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return `point:${lat.toFixed(6)}:${lng.toFixed(6)}`
    }

    return null
}

const countDistinctPolesInRows = (rows: PoleAssignment[]): number => {
    const identities = new Set<string>()

    rows.forEach((row) => {
        const identity = getPoleIdentityKey(row)
        if (identity) identities.add(identity)
    })

    if (identities.size > 0) return identities.size

    return rows.reduce((sum, row) => {
        const nextCount = Number.isFinite(row.pole_count) ? Number(row.pole_count) : 1
        return sum + Math.max(1, nextCount)
    }, 0)
}

const getPoleAssignmentMergeScore = (row: PoleAssignment): number => {
    let score = 0
    if (typeof row.salesperson_id === 'number') score += 8
    if (row.planned_date) score += 8
    if (row.status_ph) score += 6
    if (row.address) score += 5
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

const choosePrimaryPoleAssignmentRow = (rows: PoleAssignment[]): PoleAssignment | null => {
    if (rows.length === 0) return null

    return [...rows].sort((left, right) => {
        const scoreDiff = getPoleAssignmentMergeScore(right) - getPoleAssignmentMergeScore(left)
        if (scoreDiff !== 0) return scoreDiff

        const leftId = typeof left.id === 'number' ? left.id : Number.MAX_SAFE_INTEGER
        const rightId = typeof right.id === 'number' ? right.id : Number.MAX_SAFE_INTEGER
        return leftId - rightId
    })[0] || null
}


type PoleAssignmentDisplayRowsResult = {
    rows: PoleAssignment[]
    meetingsByAssignmentId: Record<number, SalesMeeting>
}

const buildGroupedPoleAssignmentDisplayRows = (
    sourceRows: PoleAssignment[],
    sourceMeetingsByAssignmentId: Record<number, SalesMeeting>
): PoleAssignmentDisplayRowsResult => {
    const groupedRows: PoleAssignment[] = []
    const groupedMeetingsByAssignmentId: Record<number, SalesMeeting> = {}
    const groupedItems = groupPoleAssignmentItems(
        sourceRows.map((row) => ({
            row,
            parcelId: row.parcel_id,
            parcelNumber: row.parcel_number,
            locality: row.locality,
            municipality: row.municipality,
            county: row.county,
            voivodeship: row.voivodeship
        }))
    )

    groupedItems.forEach((group) => {
        const groupRows = group.items.map((item) => item.row)
        if (groupRows.length === 1) {
            const singleRow = groupRows[0]
            groupedRows.push(singleRow)

            if (typeof singleRow.id === 'number' && sourceMeetingsByAssignmentId[singleRow.id]) {
                groupedMeetingsByAssignmentId[singleRow.id] = sourceMeetingsByAssignmentId[singleRow.id]
            }
            return
        }

        const primaryRow = choosePrimaryPoleAssignmentRow(groupRows) || groupRows[0]
        const rankedRows = [...groupRows].sort((left, right) => getPoleAssignmentMergeScore(right) - getPoleAssignmentMergeScore(left))
        const preferredMeetingRow =
            rankedRows.find((row) => typeof row.id === 'number' && sourceMeetingsByAssignmentId[row.id]) || primaryRow
        const linkedMeeting =
            typeof preferredMeetingRow.id === 'number' ? sourceMeetingsByAssignmentId[preferredMeetingRow.id] || null : null
        const poleCount = countDistinctPolesInRows(groupRows)

        groupedRows.push({
            ...primaryRow,
            pole_id: pickFirstNonEmptyText(...rankedRows.map((row) => row.pole_id)) || primaryRow.pole_id || null,
            pole_lat: pickFirstFiniteNumber(...rankedRows.map((row) => row.pole_lat)),
            pole_lng: pickFirstFiniteNumber(...rankedRows.map((row) => row.pole_lng)),
            voivodeship: pickFirstNonEmptyText(...rankedRows.map((row) => row.voivodeship)),
            county: pickFirstNonEmptyText(...rankedRows.map((row) => row.county)),
            municipality: pickFirstNonEmptyText(...rankedRows.map((row) => row.municipality)),
            locality: pickFirstNonEmptyText(...rankedRows.map((row) => row.locality)),
            address: pickFirstNonEmptyText(...rankedRows.map((row) => row.address)),
            parcel_number: pickFirstNonEmptyText(...rankedRows.map((row) => row.parcel_number)),
            parcel_id: pickFirstNonEmptyText(...rankedRows.map((row) => row.parcel_id)),
            surface_area: pickFirstNonEmptyText(...rankedRows.map((row) => row.surface_area)),
            pole_count: poleCount,
            salesperson_id: rankedRows.find((row) => typeof row.salesperson_id === 'number')?.salesperson_id ?? null,
            salesperson_name: pickFirstNonEmptyText(...rankedRows.map((row) => row.salesperson_name)),
            planned_date: pickFirstNonEmptyText(...rankedRows.map((row) => row.planned_date)),
            status_ph: rankedRows.find((row) => row.status_ph)?.status_ph ?? null,
            kw_mode: rankedRows.find((row) => row.kw_mode)?.kw_mode ?? null,
            kw_value: pickFirstNonEmptyText(...rankedRows.map((row) => row.kw_value)),
            pge_servitude_status: rankedRows.find((row) => row.pge_servitude_status)?.pge_servitude_status ?? null,
            owner_details: pickFirstNonEmptyText(...rankedRows.map((row) => row.owner_details)),
            can_proceed: pickFirstBoolean(...rankedRows.map((row) => row.can_proceed)),
            notes: pickFirstNonEmptyText(...rankedRows.map((row) => row.notes)),
            travel_minutes: pickFirstFiniteNumber(...rankedRows.map((row) => row.travel_minutes)),
            result_status: pickFirstNonEmptyText(...rankedRows.map((row) => row.result_status)),
            worker_notes: pickFirstNonEmptyText(...rankedRows.map((row) => row.worker_notes)),
            imported_at: pickFirstNonEmptyText(...rankedRows.map((row) => row.imported_at)) || primaryRow.imported_at || new Date().toISOString()
        })

        if (typeof primaryRow.id === 'number' && linkedMeeting) {
            groupedMeetingsByAssignmentId[primaryRow.id] = linkedMeeting
        }
    })

    return {
        rows: groupedRows,
        meetingsByAssignmentId: groupedMeetingsByAssignmentId
    }
}

const toNullableText = (value: unknown): string | null => {
    const text = cleanDisplayText(`${value ?? ''}`)
    return text || null
}

const OFFLINE_SCOPE_PLACEHOLDER_RE = /^(?:offline[\s_-]*gap[\s_-]*clusters?(?:[\s_-]*round\s*\d+)?|gap[\s_-]*clusters?(?:[\s_-]*round\s*\d+)?)$/i

const sanitizeAdminUnitLabel = (value?: string | null): string | null => {
    const cleaned = cleanDisplayText(value)
    if (!cleaned) return null

    const normalized = normalizeText(cleaned).replace(/\s+/g, ' ').trim()
    if (!normalized || OFFLINE_SCOPE_PLACEHOLDER_RE.test(normalized)) return null
    return cleaned
}

const stripPrecinctSuffix = (value?: string | null): string | null => {
    const cleaned = sanitizeAdminUnitLabel(value)
    if (!cleaned) return null

    const stripped = cleaned
        .replace(/^\d{1,3}\s*[-–]\s*/u, '')
        .replace(/^\d{1,3}\s+(?=[A-Za-zĄąĆćĘęŁłŃńÓóŚśŹźŻż])/u, '')
        .replace(/\s+obr\.?\s*\d+[A-Za-z0-9/-]*$/i, '')
        .replace(/\s+obreb\s*\d+[A-Za-z0-9/-]*$/i, '')
        .replace(/\s+\d{1,3}[A-Za-z]?$/u, '')
        .trim()

    return sanitizeAdminUnitLabel(stripped) || cleaned
}

const buildFallbackPoleAssignmentAddress = (row: {
    address?: string | null
    locality?: string | null
    municipality?: string | null
    county?: string | null
    voivodeship?: string | null
    parcelNumber?: string | null
    parcelId?: string | null
}): string | null => {
    const locality = normalizeSalesMeetingInlineText(row.locality)
    const localityWithoutPrecinct = normalizeSalesMeetingInlineText(stripPrecinctSuffix(locality))
    const municipality = normalizeSalesMeetingInlineText(row.municipality)
    return localityWithoutPrecinct || locality || municipality || null
}

const pickPreferredExactPoleAssignmentAddress = (
    locality: string | null | undefined,
    ...candidates: Array<string | null | undefined>
): string | null => {
    const displayLocality = stripPrecinctSuffix(locality) || locality || null
    const normalizedLocality = normalizeText(displayLocality || '')

    for (const candidate of candidates) {
        const normalized = normalizeSalesMeetingAddress(candidate)
        if (!normalized) continue
        if (OFFLINE_SCOPE_PLACEHOLDER_RE.test(normalizeText(normalized))) continue
        if (/\bobr\.?\b|\bobreb\b/i.test(normalized)) continue

        const strippedCandidate = stripPrecinctSuffix(normalized)
        const normalizedCandidate = normalizeText(strippedCandidate || normalized)
        if (normalizedLocality && normalizedCandidate === normalizedLocality) {
            continue
        }

        const displayAddress = buildDisplayCivicAddress(strippedCandidate || normalized, displayLocality)
        if (getCivicAddressQuality(displayAddress) === 'full') {
            return displayAddress
        }
    }

    return null
}

const resolvePoleAssignmentDisplayAddress = (row: {
    address?: string | null
    linkedAddress?: string | null
    locality?: string | null
    municipality?: string | null
    county?: string | null
    voivodeship?: string | null
    parcelNumber?: string | null
    parcelId?: string | null
}): string | null =>
    pickPreferredExactPoleAssignmentAddress(row.locality, row.address, row.linkedAddress) ||
    buildFallbackPoleAssignmentAddress({
        locality: row.locality,
        municipality: row.municipality,
        county: row.county,
        voivodeship: row.voivodeship,
        parcelNumber: row.parcelNumber,
        parcelId: row.parcelId
    })

const getPoleAssignmentAddressStatusLabel = (
    row: {
        address?: string | null
        linkedAddress?: string | null
        locality?: string | null
    },
    displayAddress?: string | null
): string | null => {
    if (pickPreferredExactPoleAssignmentAddress(row.locality, row.address, row.linkedAddress)) return null
    return displayAddress ? 'Brak dokladnego adresu' : 'Brak adresu'
}

const normalizeSurfaceAreaStorageValue = (value?: string | null): string | null => {
    const squareMeters = parseSurfaceAreaSqm(value)
    return toParcelSurfaceAreaStorageValue(squareMeters)
}

const getParcelSurfaceAreaValue = async (
    row: Pick<PoleAssignment, 'parcel_id' | 'pole_lat' | 'pole_lng'>
): Promise<string | null> => {
    const squareMeters = await resolveParcelSurfaceAreaSqmByLookup({
        parcelId: row.parcel_id,
        lat: row.pole_lat,
        lng: row.pole_lng
    })

    return toParcelSurfaceAreaStorageValue(squareMeters)
}

const getParcelSurfaceAreaFromProperties = (props: Record<string, unknown>): string | null => {
    const candidates: Array<{ value: unknown; unit?: 'sqm' | 'ha' }> = [
        { value: props['powierzchnia_m2'], unit: 'sqm' },
        { value: props['surface_area'], unit: 'sqm' },
        { value: props['surfaceArea'], unit: 'sqm' },
        { value: props['powierzchnia'], unit: 'sqm' },
        { value: props['powierzchnia_ha'], unit: 'ha' },
        { value: props['area_ha'], unit: 'ha' },
        { value: props['ha'], unit: 'ha' }
    ]

    for (const candidate of candidates) {
        if (candidate.value === null || candidate.value === undefined) continue
        const rawValue = `${candidate.value}`.trim()
        if (!rawValue) continue

        const normalized = normalizeSurfaceAreaStorageValue(candidate.unit === 'ha' ? `${rawValue} ha` : rawValue)
        if (normalized) return normalized
    }

    return null
}

const normalizeParcelIdentifier = (value?: string | null): string =>
    `${value || ''}`
        .toLowerCase()
        .replace(/\s+/g, '')
        .trim()

const buildParcelContextKey = (
    parcelNumber?: string | null,
    segments: Array<string | null | undefined> = []
): string | null => {
    const parcel = normalizeParcelIdentifier(parcelNumber)
    if (!parcel) return null

    const normalizedSegments = segments.map((value) => normalizeText(value || '')).filter(Boolean)
    if (normalizedSegments.length === 0) return null
    return [parcel, ...normalizedSegments].join('|')
}

const getParcelContextKeys = (row: {
    parcelNumber?: string | null
    locality?: string | null
    municipality?: string | null
    county?: string | null
    voivodeship?: string | null
}): string[] => {
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

const getParcelImportMetaScore = (meta: ParcelImportMeta): number =>
    [
        meta.parcelId,
        meta.parcelNumber,
        meta.locality,
        meta.municipality,
        meta.county,
        meta.voivodeship,
        meta.surfaceArea
    ].filter((value) => `${value || ''}`.trim().length > 0).length

const chooseBetterParcelImportMeta = (current: ParcelImportMeta | undefined, next: ParcelImportMeta): ParcelImportMeta => {
    if (!current) return next

    const currentScore = getParcelImportMetaScore(current)
    const nextScore = getParcelImportMetaScore(next)
    if (nextScore > currentScore) return next
    if (next.surfaceArea && !current.surfaceArea) return next
    return current
}

const setParcelImportMeta = (lookup: Map<string, ParcelImportMeta>, key: string, meta: ParcelImportMeta) => {
    if (!key) return
    lookup.set(key, chooseBetterParcelImportMeta(lookup.get(key), meta))
}

const getParcelImportMeta = (
    metadata: ParcelImportMetadata,
    row: {
        parcelId?: string | null
        parcelNumber?: string | null
        locality?: string | null
        municipality?: string | null
        county?: string | null
        voivodeship?: string | null
    }
): ParcelImportMeta | null => {
    const parcelIdKey = normalizeParcelIdentifier(row.parcelId)
    if (parcelIdKey) {
        const direct = metadata.byParcelId.get(parcelIdKey)
        if (direct) return direct
    }

    for (const key of getParcelContextKeys(row)) {
        const matched = metadata.byContextKey.get(key)
        if (matched) return matched
    }

    return null
}

async function fetchJsonFile<T>(url: string): Promise<T> {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status} dla ${url}`)
    return response.json() as Promise<T>
}

async function loadParcelImportMetadata(): Promise<ParcelImportMetadata> {
    if (!parcelImportMetadataPromise) {
        parcelImportMetadataPromise = (async () => {
            const metadata: ParcelImportMetadata = {
                byParcelId: new Map<string, ParcelImportMeta>(),
                byContextKey: new Map<string, ParcelImportMeta>()
            }

            const [collections, localParcels, cachedUldkEntries] = await Promise.all([
                Promise.allSettled(
                    PARCEL_METADATA_GEOJSON_URLS.map((url) => fetchJsonFile<ParcelAreaFeatureCollection>(url))
                ),
                fetchAllLocalParcels().catch(() => []),
                fetchJsonFile<Record<string, CachedUldkParcelEntry | null>>('/power_tiles/uldk_cache.json').catch(() => ({}))
            ])

            collections.forEach((result) => {
                if (result.status !== 'fulfilled') return

                ;(result.value.features || []).forEach((feature) => {
                    const props = feature.properties || {}
                    const meta: ParcelImportMeta = {
                        parcelId:
                            toNullableText(props['ID_DZIALKI']) ||
                            toNullableText(props['id']) ||
                            toNullableText(props['teryt']) ||
                            toNullableText(props['id_uldk']),
                        parcelNumber: toNullableText(props['numer_dzialki']) || toNullableText(props['parcel']),
                        locality: stripPrecinctSuffix(toNullableText(props['region'])),
                        municipality: sanitizeAdminUnitLabel(toNullableText(props['gmina']) || toNullableText(props['commune'])),
                        county: sanitizeAdminUnitLabel(toNullableText(props['powiat'])),
                        voivodeship: sanitizeAdminUnitLabel(toNullableText(props['wojewodztwo'])) || 'mazowieckie',
                        surfaceArea: getParcelSurfaceAreaFromProperties(props)
                    }

                    const parcelIdKey = normalizeParcelIdentifier(meta.parcelId)
                    if (parcelIdKey) setParcelImportMeta(metadata.byParcelId, parcelIdKey, meta)

                    getParcelContextKeys(meta).forEach((key) => {
                        setParcelImportMeta(metadata.byContextKey, key, meta)
                    })
                })
            })

            localParcels.forEach((parcel) => {
                const meta: ParcelImportMeta = {
                    parcelId: toNullableText(parcel.id),
                    parcelNumber: toNullableText(parcel.parcelNumber),
                    locality: stripPrecinctSuffix(parcel.localityLabel || parcel.precinct),
                    municipality: sanitizeAdminUnitLabel(parcel.municipality),
                    county: sanitizeAdminUnitLabel(parcel.county),
                    voivodeship: sanitizeAdminUnitLabel(parcel.voivodeship),
                    surfaceArea: toParcelSurfaceAreaStorageValue(calculateParcelSurfaceAreaSqmFromGeometry(parcel))
                }

                const parcelIdKey = normalizeParcelIdentifier(meta.parcelId)
                if (parcelIdKey) setParcelImportMeta(metadata.byParcelId, parcelIdKey, meta)

                getParcelContextKeys(meta).forEach((key) => {
                    setParcelImportMeta(metadata.byContextKey, key, meta)
                })
            })

            const bestCachedMetaByParcelId = new Map<string, ParcelImportMeta>()
            Object.values(cachedUldkEntries).forEach((entry) => {
                if (!entry) return

                const meta: ParcelImportMeta = {
                    parcelId: toNullableText(entry.id),
                    parcelNumber: toNullableText(entry.number),
                    locality: stripPrecinctSuffix(entry.localityLabel),
                    municipality: sanitizeAdminUnitLabel(entry.municipality),
                    county: sanitizeAdminUnitLabel(entry.county),
                    voivodeship: sanitizeAdminUnitLabel(entry.voivodeship),
                    surfaceArea: null
                }

                const parcelIdKey = normalizeParcelIdentifier(meta.parcelId)
                if (!parcelIdKey) return
                bestCachedMetaByParcelId.set(
                    parcelIdKey,
                    chooseBetterParcelImportMeta(bestCachedMetaByParcelId.get(parcelIdKey), meta)
                )
            })

            bestCachedMetaByParcelId.forEach((meta, parcelIdKey) => {
                setParcelImportMeta(metadata.byParcelId, parcelIdKey, meta)
                getParcelContextKeys(meta).forEach((key) => {
                    setParcelImportMeta(metadata.byContextKey, key, meta)
                })
            })

            return metadata
        })()
    }

    try {
        return await parcelImportMetadataPromise
    } catch {
        parcelImportMetadataPromise = Promise.resolve({
            byParcelId: new Map<string, ParcelImportMeta>(),
            byContextKey: new Map<string, ParcelImportMeta>()
        })
        return parcelImportMetadataPromise
    }
}


async function buildPoleAssignmentRowsFromPowerTiles(existingRows: PoleAssignment[]): Promise<PoleAssignment[]> {
    const existingByImportKey = new Map(existingRows.map((row) => [row.import_key, row] as const))
    const [rawPoles, parcelMetadata] = await Promise.all([
        fetchAllLocalPoles(),
        loadParcelImportMetadata()
    ])
    const allPoles = await resolvePowerPolesWithLocalParcels(rawPoles.filter((pole) => pole.type !== 'station'))

    const uniqueRows = new Map<string, PoleAssignment>()
    const importedAt = new Date().toISOString()

    for (const pole of allPoles) {
        const poleId = toNullableText(pole.id)
        const parcelId = toNullableText(pole.parcelId)
        const baseParcelNumber = toNullableText(pole.parcelNumber)
        const baseLocality = stripPrecinctSuffix(pole.localityLabel || pole.precinct)
        const baseMunicipality = sanitizeAdminUnitLabel(pole.municipality)
        const baseCounty = sanitizeAdminUnitLabel(pole.county)
        const baseVoivodeship = sanitizeAdminUnitLabel(pole.voivodeship)
        const parcelMeta = getParcelImportMeta(parcelMetadata, {
            parcelId,
            parcelNumber: baseParcelNumber,
            locality: baseLocality,
            municipality: baseMunicipality,
            county: baseCounty,
            voivodeship: baseVoivodeship
        })
        const parcelNumber = baseParcelNumber || parcelMeta?.parcelNumber || null
        if (!parcelId && !parcelNumber) continue

        const locality = stripPrecinctSuffix(baseLocality || parcelMeta?.locality) || null
        const municipality = sanitizeAdminUnitLabel(baseMunicipality || parcelMeta?.municipality) || null
        const county = sanitizeAdminUnitLabel(baseCounty || parcelMeta?.county) || null
        const voivodeship = sanitizeAdminUnitLabel(baseVoivodeship || parcelMeta?.voivodeship) || null

        const importKey = buildImportKey({
            poleId,
            parcelId,
            parcelNumber,
            locality,
            address: ''
        })
        const existingRow = existingByImportKey.get(importKey)
        const exactPoleAddress = pickPreferredExactPoleAssignmentAddress(
            getPowerPoleDisplayAddress(pole),
            existingRow?.address
        )
        const normalizedExistingSurfaceArea = normalizeSurfaceAreaStorageValue(existingRow?.surface_area)
        const normalizedMetadataSurfaceArea = normalizeSurfaceAreaStorageValue(parcelMeta?.surfaceArea)
        const resolvedSurfaceArea =
            normalizedExistingSurfaceArea ||
            normalizedMetadataSurfaceArea ||
            null
        const fallbackAddress = buildFallbackPoleAssignmentAddress({
            locality,
            municipality,
            county,
            voivodeship,
            parcelNumber,
            parcelId
        })
        const previousResolvedRow = uniqueRows.get(importKey)

        uniqueRows.set(importKey, {
            import_key: importKey,
            pole_id: previousResolvedRow?.pole_id || poleId || existingRow?.pole_id || null,
            pole_lat: previousResolvedRow?.pole_lat ?? (typeof pole.lat === 'number' ? pole.lat : existingRow?.pole_lat ?? null),
            pole_lng: previousResolvedRow?.pole_lng ?? (typeof pole.lng === 'number' ? pole.lng : existingRow?.pole_lng ?? null),
            voivodeship: previousResolvedRow?.voivodeship || voivodeship || existingRow?.voivodeship || null,
            county: previousResolvedRow?.county || county || existingRow?.county || null,
            municipality: previousResolvedRow?.municipality || municipality || existingRow?.municipality || null,
            locality: previousResolvedRow?.locality || locality || existingRow?.locality || null,
            address: previousResolvedRow?.address || exactPoleAddress || fallbackAddress,
            parcel_number: previousResolvedRow?.parcel_number || parcelNumber || existingRow?.parcel_number || null,
            parcel_id: previousResolvedRow?.parcel_id || parcelId || existingRow?.parcel_id || null,
            surface_area: resolvedSurfaceArea,
            pole_count: Math.max(1, Number(previousResolvedRow?.pole_count || 0) + 1),
            imported_at: importedAt
        })
    }

    const groupedRows = Array.from(uniqueRows.values())
    return Promise.all(groupedRows.map(async (row) => ({
        ...row,
        surface_area: row.surface_area || await getParcelSurfaceAreaValue(row)
    })))
}

async function loadCachedOfflinePowerTileRows(): Promise<PoleAssignment[]> {
    if (!cachedOfflinePowerTileRowsPromise) {
        cachedOfflinePowerTileRowsPromise = buildPoleAssignmentRowsFromPowerTiles([]).catch((error) => {
            cachedOfflinePowerTileRowsPromise = null
            throw error
        })
    }

    return cachedOfflinePowerTileRowsPromise
}

async function mergePoleAssignmentRowsWithPowerTiles(existingRows: PoleAssignment[]): Promise<PoleAssignment[]> {
    const localRows = await loadCachedOfflinePowerTileRows()
    const mergedRows = new Map<string, PoleAssignment>()

    localRows.forEach((row) => {
        mergedRows.set(row.import_key, row)
    })

    existingRows.forEach((row) => {
        if (!mergedRows.has(row.import_key)) {
            mergedRows.set(row.import_key, row)
        }
    })

    return Array.from(mergedRows.values())
}

async function loadAllPoleAssignmentsFromDb(): Promise<PoleAssignment[]> {
    const allRows: PoleAssignment[] = []

    for (let from = 0; ; from += TABLE_FETCH_BATCH_SIZE) {
        const { data, error } = await supabase
            .from('pole_assignments')
            .select('*')
            .order('locality', { ascending: true })
            .order('address', { ascending: true })
            .range(from, from + TABLE_FETCH_BATCH_SIZE - 1)

        if (error) throw error

        const batch = (data || []) as PoleAssignment[]
        allRows.push(...batch)
        if (batch.length < TABLE_FETCH_BATCH_SIZE) break
    }

    return allRows
}

async function loadAllMeetingsForAssignments(): Promise<SalesMeeting[]> {
    const allMeetings: SalesMeeting[] = []

    for (let from = 0; ; from += TABLE_FETCH_BATCH_SIZE) {
        const { data, error } = await supabase
            .from('sales_meetings')
            .select('*')
            .not('pole_assignment_id', 'is', null)
            .range(from, from + TABLE_FETCH_BATCH_SIZE - 1)

        if (error) throw error

        const batch = (data || []) as SalesMeeting[]
        allMeetings.push(...batch)
        if (batch.length < TABLE_FETCH_BATCH_SIZE) break
    }

    return allMeetings
}


const getScheduledAtForDate = (datePart: string, currentValue?: string | null): string => {
    const timePart = getScheduledTimePart(currentValue)
    const [year, month, day] = datePart.split('-').map(Number)
    const [hours, minutes] = timePart.split(':').map(Number)
    return new Date(year, month - 1, day, hours, minutes, 0, 0).toISOString()
}

const getCanProceedSelectValue = (value: boolean | null | undefined): '' | 'yes' | 'no' =>
    value === true ? 'yes' : value === false ? 'no' : ''

const getKwModeSelectValue = (value: PoleAssignmentKwMode | null | undefined): '' | PoleAssignmentKwMode =>
    value || ''

const getPgeSelectValue = (value: PoleAssignmentPgeServitudeStatus | null | undefined): '' | PoleAssignmentPgeServitudeStatus =>
    value || ''

const getStatusSelectValue = (
    row: PoleAssignment,
    linkedMeeting?: SalesMeeting | null
): '' | SalesMeetingStatus =>
    row.status_ph ||
    linkedMeeting?.status ||
    parsePoleAssignmentStatus(row.result_status) ||
    parsePoleAssignmentStatus(linkedMeeting?.result_status) ||
    ''

const getPoleAssignmentsSchemaIssueMessage = (error: unknown): string | null => {
    const message = mapSalesMeetingsMutationError(error)
    const normalized = message.toLowerCase()

    if (
        normalized.includes('public.pole_assignments') &&
        (normalized.includes('could not find the table') || normalized.includes('does not exist') || normalized.includes('relation'))
    ) {
        return 'Dane słupów i działek na mapie są, ale brakuje osobnej tabeli pole_assignments do przypisań, statusów i notatek. Najpierw odpal migrację SQL dla tabeli działek.'
    }

    if (
        normalized.includes('pole_assignment_id') &&
        (normalized.includes('schema cache') || normalized.includes('does not exist') || normalized.includes('column'))
    ) {
        return 'Brakuje kolumny pole_assignment_id w sales_meetings. Najpierw odpal migrację SQL dla spotkań i tabeli działek.'
    }

    return null
}

const isMissingSalesMeetingExtendedAssignmentColumnError = (error: unknown): boolean => {
    const normalized = mapSalesMeetingsMutationError(error).toLowerCase()
    return (
        normalized.includes('sales_meetings') &&
        EXTENDED_SALES_MEETING_ASSIGNMENT_KEYS.some((key) => normalized.includes(key)) &&
        (normalized.includes('schema cache') || normalized.includes('column') || normalized.includes('does not exist'))
    )
}

const omitExtendedSalesMeetingAssignmentFields = <T extends Record<string, unknown>>(payload: T): T => {
    const next = { ...payload }
    EXTENDED_SALES_MEETING_ASSIGNMENT_KEYS.forEach((key) => {
        delete (next as Record<string, unknown>)[key]
    })
    return next
}

type PoleAssignmentColumnId =
    | 'voivodeship'
    | 'county'
    | 'municipality'
    | 'locality'
    | 'address'
    | 'parcel_number'
    | 'parcel_id'
    | 'surface_area'
    | 'pole_count'
    | 'salesperson'
    | 'planned_date'
    | 'status_ph'
    | 'kw'
    | 'pge'
    | 'owner_details'
    | 'can_proceed'
    | 'notes'
    | 'travel_minutes'
    | 'worker_notes'
    | 'actions'

type SortDirection = 'asc' | 'desc'
type PoleAssignmentSortableColumnId = Exclude<PoleAssignmentColumnId, 'actions'>

const LOCATION_COLUMN_IDS: PoleAssignmentColumnId[] = [
    'voivodeship',
    'county',
    'municipality',
    'locality',
    'address',
    'parcel_number',
    'parcel_id',
    'surface_area'
]

const ASSIGNMENT_COLUMN_IDS: PoleAssignmentColumnId[] = ['salesperson', 'planned_date']

const ADMIN_COMPLETION_COLUMN_IDS: PoleAssignmentColumnId[] = ['pole_count', 'kw', 'pge', 'owner_details', 'can_proceed', 'notes']

const WORKER_MEETING_COLUMN_IDS: PoleAssignmentColumnId[] = ['worker_notes', 'status_ph', 'travel_minutes']

const ALL_COLUMN_IDS: PoleAssignmentColumnId[] = [
    ...LOCATION_COLUMN_IDS,
    ...ASSIGNMENT_COLUMN_IDS,
    ...ADMIN_COMPLETION_COLUMN_IDS,
    ...WORKER_MEETING_COLUMN_IDS,
    'actions'
]

const PoleAssignmentsPanel = memo(function PoleAssignmentsPanel() {
    const [rows, setRows] = useState<PoleAssignment[]>([])
    const [workers, setWorkers] = useState<User[]>([])
    const [meetingsByAssignmentId, setMeetingsByAssignmentId] = useState<Record<number, SalesMeeting>>({})
    const [loading, setLoading] = useState(true)
    const [savingId, setSavingId] = useState<number | null>(null)

    const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set())
    const [search, setSearch] = useState('')
    const [salespersonFilter, setSalespersonFilter] = useState('all')
    const [countyFilter, setCountyFilter] = useState('all')
    const [localityFilter, setLocalityFilter] = useState('all')
    const [localitySearch, setLocalitySearch] = useState('')
    const [addressFilter, setAddressFilter] = useState<AddressFilter>('all')
    const [rowsPerPage, setRowsPerPage] = useState<number>(PAGE_SIZE_OPTIONS[0])
    const [currentPage, setCurrentPage] = useState(1)
    const [sortConfig, setSortConfig] = useState<{ columnId: PoleAssignmentSortableColumnId; direction: SortDirection } | null>(null)
    const [schemaIssueMessage, setSchemaIssueMessage] = useState<string | null>(null)
    const [columnPickerOpen, setColumnPickerOpen] = useState(false)
    const [columnFilter, setColumnFilter] = useState('')
    const [visibleColumnIds, setVisibleColumnIds] = useState<PoleAssignmentColumnId[]>(ALL_COLUMN_IDS)
    const tableViewportRef = useRef<HTMLDivElement | null>(null)
    const loadRequestIdRef = useRef(0)

    const workersById = useMemo(
        () =>
            new Map(
                workers
                    .filter((worker): worker is User & { id: number } => typeof worker.id === 'number')
                    .map((worker) => [worker.id, worker] as const)
            ),
        [workers]
    )
    const assignableWorkers = useMemo(
        () => workers.filter((worker): worker is User & { id: number } => typeof worker.id === 'number'),
        [workers]
    )
    const columns = useMemo<Array<{ id: PoleAssignmentColumnId; label: string; widthPx: number }>>(
        () => [
            { id: 'voivodeship', label: 'WOJEWÓDZTWO', widthPx: 140 },
            { id: 'county', label: 'POWIAT', widthPx: 120 },
            { id: 'municipality', label: 'GMINA', widthPx: 130 },
            { id: 'locality', label: 'MIEJSCOWOŚĆ', widthPx: 150 },
            { id: 'address', label: 'ADRES', widthPx: 220 },
            { id: 'parcel_number', label: 'NR DZIAŁKI', widthPx: 120 },
            { id: 'parcel_id', label: 'IDENTYFIKATOR DZIAŁKI', widthPx: 170 },
            { id: 'surface_area', label: 'POWIERZCHNIA [ha]', widthPx: 140 },
            { id: 'salesperson', label: 'PRZYPISANE', widthPx: 190 },
            { id: 'planned_date', label: 'DATA', widthPx: 180 },
            { id: 'pole_count', label: 'ILOŚĆ SŁUPÓW', widthPx: 95 },
            { id: 'kw', label: 'KW', widthPx: 190 },
            { id: 'pge', label: 'SŁUŻEBNOŚĆ PGE', widthPx: 150 },
            { id: 'owner_details', label: 'WŁAŚCICIEL', widthPx: 220 },
            { id: 'can_proceed', label: 'CZY MOŻEMY DZIAŁAĆ', widthPx: 155 },
            { id: 'notes', label: 'UWAGI SPOTKANIA', widthPx: 220 },
            { id: 'worker_notes', label: 'UWAGI PH', widthPx: 240 },
            { id: 'status_ph', label: 'STATUS PH', widthPx: 170 },
            { id: 'travel_minutes', label: 'CZAS DOJAZDU', widthPx: 115 },
            { id: 'actions', label: 'AKCJE', widthPx: 130 }
        ],
        []
    )
    const tableMinWidthPx = useMemo(
        () => columns.reduce((sum, column) => sum + column.widthPx, 0),
        [columns]
    )
    const filteredColumnOptions = useMemo(() => {
        const needle = normalizeText(columnFilter)
        if (!needle) return columns
        return columns.filter((column) => normalizeText(column.label).includes(needle))
    }, [columnFilter, columns])
    const hiddenColumnClasses = useMemo(
        () =>
            ALL_COLUMN_IDS.map((columnId, index) => (visibleColumnIds.includes(columnId) ? '' : `pa-hide-col-${index + 1}`))
                .filter(Boolean)
                .join(' '),
        [visibleColumnIds]
    )
    const displayRowsResult = useMemo(
        () => buildGroupedPoleAssignmentDisplayRows(rows, meetingsByAssignmentId),
        [meetingsByAssignmentId, rows]
    )
    const displayRows = displayRowsResult.rows
    const effectiveMeetingsByAssignmentId = displayRowsResult.meetingsByAssignmentId
    const isColumnVisible = useCallback(
        (columnId: PoleAssignmentColumnId) => visibleColumnIds.includes(columnId),
        [visibleColumnIds]
    )

    const rowKey = useCallback((row: PoleAssignment) => String(row.id ?? row.import_key), [])
    const getEffectiveRowAddress = useCallback((row: PoleAssignment, linkedMeeting?: SalesMeeting | null): string => resolvePoleAssignmentDisplayAddress({
        address: row.address,
        linkedAddress: linkedMeeting?.address || null,
        locality: row.locality || linkedMeeting?.locality_label || linkedMeeting?.precinct || null,
        municipality: row.municipality || null,
        county: row.county || linkedMeeting?.county || null,
        voivodeship: row.voivodeship || linkedMeeting?.region || null,
        parcelNumber: row.parcel_number || linkedMeeting?.parcel_number || null,
        parcelId: row.parcel_id || linkedMeeting?.parcel_id || null
    }) || '', [])
    const rowNeedsAddressClarification = useCallback(
        (row: PoleAssignment, linkedMeeting?: SalesMeeting | null): boolean =>
            Boolean(getPoleAssignmentAddressStatusLabel({
                address: row.address,
                linkedAddress: linkedMeeting?.address || null,
                locality: row.locality || linkedMeeting?.locality_label || linkedMeeting?.precinct || null
            }, getEffectiveRowAddress(row, linkedMeeting))),
        [getEffectiveRowAddress]
    )
    const getRowPlannedDateInputValue = useCallback(
        (row: PoleAssignment, linkedMeeting?: SalesMeeting | null): string => {
            if (row.planned_date) return row.planned_date
            return getDatePartFromIsoValue(linkedMeeting?.scheduled_at)
        },
        []
    )

    const markDirty = useCallback((key: string) => {
        setDirtyKeys((prev) => {
            const next = new Set(prev)
            next.add(key)
            return next
        })
    }, [])

    const clearDirty = useCallback((key: string) => {
        setDirtyKeys((prev) => {
            if (!prev.has(key)) return prev
            const next = new Set(prev)
            next.delete(key)
            return next
        })
    }, [])

    const loadData = useCallback(async (options?: { silent?: boolean }) => {
        const silent = options?.silent === true
        const loadRequestId = loadRequestIdRef.current + 1
        loadRequestIdRef.current = loadRequestId
        if (!silent) {
            setLoading(true)
        }

        try {
            const workersResp = await supabase.from('users').select('*').eq('role', 'worker').order('name', { ascending: true })
            if (workersResp.error) throw workersResp.error
            setWorkers(workersResp.data || [])

            let loadedRows: PoleAssignment[] = []
            try {
                loadedRows = await loadAllPoleAssignmentsFromDb()
            } catch (error) {
                const schemaIssue = getPoleAssignmentsSchemaIssueMessage(error)
                if (schemaIssue) {
                    setSchemaIssueMessage(schemaIssue)
                    setRows([])
                    setMeetingsByAssignmentId({})
                    if (!silent && loadRequestIdRef.current === loadRequestId) {
                        setLoading(false)
                    }
                    return
                }
                throw error
            }

            let loadedMeetings: SalesMeeting[] = []
            try {
                loadedMeetings = await loadAllMeetingsForAssignments()
            } catch (error) {
                const schemaIssue = getPoleAssignmentsSchemaIssueMessage(error)
                if (schemaIssue) {
                    setSchemaIssueMessage(schemaIssue)
                    setRows(loadedRows)
                    setMeetingsByAssignmentId({})
                    if (!silent && loadRequestIdRef.current === loadRequestId) {
                        setLoading(false)
                    }
                    return
                }
                throw error
            }

            const parcelMetadata = await loadParcelImportMetadata()

            const meetingMap: Record<number, SalesMeeting> = {}
            loadedMeetings.forEach((meeting) => {
                if (typeof meeting.pole_assignment_id === 'number') {
                    meetingMap[meeting.pole_assignment_id] = meeting
                }
            })

            const hydratedRows = await Promise.all(loadedRows.map(async (row) => {
                if (typeof row.id !== 'number') return row
                const linkedMeeting = meetingMap[row.id]
                const parcelMeta = getParcelImportMeta(parcelMetadata, {
                    parcelId: row.parcel_id,
                    parcelNumber: row.parcel_number,
                    locality: row.locality,
                    municipality: row.municipality,
                    county: row.county,
                    voivodeship: row.voivodeship
                })

                const locality = stripPrecinctSuffix(row.locality || parcelMeta?.locality || linkedMeeting?.locality_label || linkedMeeting?.precinct) || null
                const municipality = sanitizeAdminUnitLabel(row.municipality || parcelMeta?.municipality) || null
                const county = sanitizeAdminUnitLabel(row.county || parcelMeta?.county) || null
                const voivodeship = sanitizeAdminUnitLabel(row.voivodeship || parcelMeta?.voivodeship) || null
                const effectiveAddress = resolvePoleAssignmentDisplayAddress({
                    address: row.address,
                    linkedAddress: linkedMeeting?.address || null,
                    locality,
                    municipality,
                    county,
                    voivodeship,
                    parcelNumber: row.parcel_number || linkedMeeting?.parcel_number || parcelMeta?.parcelNumber || null,
                    parcelId: row.parcel_id || linkedMeeting?.parcel_id || null
                })
                const normalizedRowSurfaceArea = normalizeSurfaceAreaStorageValue(row.surface_area)
                const normalizedMetadataSurfaceArea = normalizeSurfaceAreaStorageValue(parcelMeta?.surfaceArea)
                const resolvedSurfaceArea =
                    normalizedRowSurfaceArea ||
                    normalizedMetadataSurfaceArea ||
                    await getParcelSurfaceAreaValue(row)
                const enrichedRow = {
                    ...row,
                    address: effectiveAddress,
                    parcel_number: row.parcel_number || parcelMeta?.parcelNumber || null,
                    locality,
                    municipality,
                    county,
                    voivodeship,
                    surface_area: resolvedSurfaceArea
                }
                if (!linkedMeeting) return enrichedRow

                return {
                    ...enrichedRow,
                    status_ph: row.status_ph || linkedMeeting.status || null,
                    travel_minutes: row.travel_minutes ?? linkedMeeting.travel_minutes ?? null,
                    result_status: row.result_status || linkedMeeting.result_status || null,
                    worker_notes: row.worker_notes || linkedMeeting.worker_notes || null
                }
            }))

            setRows(hydratedRows)
            setMeetingsByAssignmentId(meetingMap)
            setSchemaIssueMessage(null)

            if (!silent && loadRequestIdRef.current === loadRequestId) {
                setLoading(false)
            }

            void mergePoleAssignmentRowsWithPowerTiles(hydratedRows)
                .then((finalRows) => {
                    if (loadRequestIdRef.current !== loadRequestId) return
                    setRows(finalRows)
                })
                .catch((error) => {
                    console.warn('Failed to merge pole assignment rows with offline power tiles:', error)
                })
        } catch (error) {
            toast.error(`Nie udało się pobrać tabeli działek: ${mapSalesMeetingsMutationError(error)}`)
        } finally {
            if (!silent && loadRequestIdRef.current === loadRequestId) {
                setLoading(false)
            }
        }
    }, [getEffectiveRowAddress])

    useEffect(() => {
        void loadData()
    }, [loadData])

    const countyOptions = useMemo(
        () => Array.from(new Set(displayRows.map((row) => `${row.county || ''}`.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'pl')),
        [displayRows]
    )
    const localityOptions = useMemo(
        () =>
            Array.from(
                new Set(
                    displayRows
                        .filter((row) => countyFilter === 'all' || `${row.county || ''}`.trim() === countyFilter)
                        .map((row) => `${row.locality || ''}`.trim())
                        .filter(Boolean)
                )
            ).sort((a, b) => a.localeCompare(b, 'pl')),
        [countyFilter, displayRows]
    )

    const filteredRows = useMemo(() => {
        const needle = normalizeText(search)
        const localityNeedle = normalizeText(localitySearch)

        return displayRows.filter((row) => {
            const linkedMeeting = row.id ? effectiveMeetingsByAssignmentId[row.id] : null
            if (salespersonFilter !== 'all' && String(row.salesperson_id ?? '') !== salespersonFilter) return false
            if (countyFilter !== 'all' && `${row.county || ''}`.trim() !== countyFilter) return false
            if (localityFilter !== 'all' && `${row.locality || ''}`.trim() !== localityFilter) return false
            if (localityNeedle && !normalizeText(`${row.locality || ''}`).includes(localityNeedle)) return false
            const effectiveAddress = getEffectiveRowAddress(row, linkedMeeting)
            const requiresClarification = rowNeedsAddressClarification(row, linkedMeeting)
            if (addressFilter === 'exact' && requiresClarification) return false
            if (addressFilter === 'needs_clarification' && !requiresClarification) return false
            if (!needle) return true

            const haystack = [
                row.voivodeship,
                row.county,
                row.municipality,
                row.locality,
                effectiveAddress,
                row.parcel_number,
                row.parcel_id,
                row.owner_details,
                row.notes,
                row.salesperson_name,
                getPoleAssignmentStatusLabel(row, linkedMeeting)
            ]
                .map((value) => normalizeText(`${value || ''}`))
                .join(' ')

            return haystack.includes(needle)
        })
    }, [addressFilter, countyFilter, displayRows, effectiveMeetingsByAssignmentId, getEffectiveRowAddress, localityFilter, localitySearch, salespersonFilter, search])

    const getSortableValue = useCallback(
        (row: PoleAssignment, columnId: PoleAssignmentSortableColumnId): string | number => {
            const linkedMeeting = row.id ? effectiveMeetingsByAssignmentId[row.id] : null

            switch (columnId) {
                case 'voivodeship':
                    return normalizeText(row.voivodeship || '')
                case 'county':
                    return normalizeText(row.county || '')
                case 'municipality':
                    return normalizeText(row.municipality || '')
                case 'locality':
                    return normalizeText(row.locality || '')
                case 'address':
                    return normalizeText(row.address || '')
                case 'parcel_number':
                    return normalizeText(row.parcel_number || '')
                case 'parcel_id':
                    return normalizeText(row.parcel_id || '')
                case 'surface_area':
                    return parseSurfaceAreaSqm(row.surface_area) ?? Number.NEGATIVE_INFINITY
                case 'pole_count':
                    return row.pole_count ?? Number.NEGATIVE_INFINITY
                case 'salesperson':
                    return normalizeText(row.salesperson_name || '')
                case 'planned_date':
                    return linkedMeeting?.scheduled_at || row.planned_date || ''
                case 'kw':
                    return normalizeText(row.kw_mode === 'manual' ? row.kw_value || '' : row.kw_mode || '')
                case 'pge':
                    return normalizeText(getPoleAssignmentPgeLabel(row.pge_servitude_status))
                case 'owner_details':
                    return normalizeText(row.owner_details || '')
                case 'can_proceed':
                    return normalizeText(getPoleAssignmentCanProceedLabel(row.can_proceed))
                case 'notes':
                    return normalizeText(row.notes || '')
                case 'worker_notes':
                    return normalizeText(getPoleAssignmentWorkerNotes(row, linkedMeeting))
                case 'travel_minutes':
                    return row.travel_minutes ?? Number.NEGATIVE_INFINITY
                case 'status_ph':
                    return normalizeText(getPoleAssignmentStatusLabel(row, linkedMeeting))
            }
        },
        [effectiveMeetingsByAssignmentId]
    )

    const sortedRows = useMemo(() => {
        if (!sortConfig) return filteredRows

        const directionFactor = sortConfig.direction === 'asc' ? 1 : -1
        return [...filteredRows].sort((left, right) => {
            const leftValue = getSortableValue(left, sortConfig.columnId)
            const rightValue = getSortableValue(right, sortConfig.columnId)

            const leftEmpty =
                leftValue === '' ||
                leftValue === null ||
                leftValue === undefined ||
                leftValue === Number.NEGATIVE_INFINITY
            const rightEmpty =
                rightValue === '' ||
                rightValue === null ||
                rightValue === undefined ||
                rightValue === Number.NEGATIVE_INFINITY

            if (leftEmpty && rightEmpty) return 0
            if (leftEmpty) return 1
            if (rightEmpty) return -1

            if (typeof leftValue === 'number' && typeof rightValue === 'number') {
                return (leftValue - rightValue) * directionFactor
            }

            return `${leftValue}`.localeCompare(`${rightValue}`, 'pl', { numeric: true, sensitivity: 'base' }) * directionFactor
        })
    }, [filteredRows, getSortableValue, sortConfig])

    const totalPages = useMemo(() => Math.max(1, Math.ceil(sortedRows.length / rowsPerPage)), [rowsPerPage, sortedRows.length])
    const paginatedRows = useMemo(() => {
        const safePage = Math.min(currentPage, totalPages)
        const start = (safePage - 1) * rowsPerPage
        return sortedRows.slice(start, start + rowsPerPage)
    }, [currentPage, rowsPerPage, sortedRows, totalPages])
    const visibleRangeLabel = useMemo(() => {
        if (sortedRows.length === 0) return '0 z 0'
        const safePage = Math.min(currentPage, totalPages)
        const start = (safePage - 1) * rowsPerPage + 1
        const end = Math.min(start + rowsPerPage - 1, sortedRows.length)
        return `${start}-${end} z ${sortedRows.length}`
    }, [currentPage, rowsPerPage, sortedRows.length, totalPages])

    const stats = useMemo(() => {
        const total = displayRows.length
        const assigned = displayRows.filter((row) => typeof row.salesperson_id === 'number').length
        const dated = displayRows.filter((row) => Boolean(row.planned_date)).length
        const clarification = displayRows.filter((row) => {
            const linkedMeeting = typeof row.id === 'number' ? effectiveMeetingsByAssignmentId[row.id] : null
            return rowNeedsAddressClarification(row, linkedMeeting)
        }).length
        return { total, assigned, dated, clarification }
    }, [displayRows, effectiveMeetingsByAssignmentId, rowNeedsAddressClarification])
    const hasPendingEdits = dirtyKeys.size > 0

    useEffect(() => {
        setCurrentPage(1)
    }, [addressFilter, countyFilter, localityFilter, localitySearch, rowsPerPage, salespersonFilter, search, sortConfig])

    useEffect(() => {
        setLocalityFilter((current) => (current === 'all' || localityOptions.includes(current) ? current : 'all'))
    }, [localityOptions])

    useEffect(() => {
        setCurrentPage((page) => Math.min(page, totalPages))
    }, [totalPages])

    const toggleSort = useCallback((columnId: PoleAssignmentSortableColumnId) => {
        setSortConfig((current) => {
            if (!current || current.columnId !== columnId) {
                return { columnId, direction: 'asc' }
            }

            if (current.direction === 'asc') {
                return { columnId, direction: 'desc' }
            }

            return null
        })
    }, [])

    const handleTableViewportWheelCapture = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
        const viewport = tableViewportRef.current
        if (!viewport) return

        const hasVerticalOverflow = viewport.scrollHeight > viewport.clientHeight + 1
        const hasHorizontalOverflow = viewport.scrollWidth > viewport.clientWidth + 1
        if (!hasVerticalOverflow && !hasHorizontalOverflow) return

        const horizontalDelta = event.shiftKey && Math.abs(event.deltaX) < 0.1 ? event.deltaY : event.deltaX
        const prefersHorizontal = hasHorizontalOverflow && (event.shiftKey || Math.abs(horizontalDelta) > Math.abs(event.deltaY))

        if (prefersHorizontal) {
            event.preventDefault()
            event.stopPropagation()
            viewport.scrollLeft += horizontalDelta || event.deltaY
            return
        }

        if (hasVerticalOverflow) {
            event.preventDefault()
            event.stopPropagation()
            viewport.scrollTop += event.deltaY
        }
    }, [])

    const updateRow = useCallback((key: string, updater: (row: PoleAssignment) => PoleAssignment) => {
        setRows((prev) => prev.map((row) => (String(row.id ?? row.import_key) === key ? updater(row) : row)))
        markDirty(key)
    }, [markDirty])
    const openNativeDatePicker = useCallback((input: HTMLInputElement | null) => {
        if (!input) return

        if (typeof input.showPicker === 'function') {
            try {
                input.showPicker()
                return
            } catch (e) {
                // ignore
            }
        }

        input.focus()
    }, [])

    const toggleColumnVisibility = useCallback((columnId: PoleAssignmentColumnId) => {
        setVisibleColumnIds((prev) => {
            if (prev.includes(columnId)) {
                if (prev.length === 1) return prev
                return prev.filter((id) => id !== columnId)
            }

            const next = new Set(prev)
            next.add(columnId)
            return ALL_COLUMN_IDS.filter((id) => next.has(id))
        })
    }, [])

    const syncMeetingForAssignment = useCallback(
        async (row: PoleAssignment) => {
            if (!row.id) return

            const existingMeeting = effectiveMeetingsByAssignmentId[row.id] || null
            if (!row.salesperson_id || !row.planned_date) {
                if (existingMeeting?.id) {
                    const shouldCancelMeeting =
                        !existingMeeting.linked_survey_id &&
                        (existingMeeting.status === 'planned' || existingMeeting.status === 'follow_up')
                    const { error } = await supabase
                        .from('sales_meetings')
                        .update({
                            pole_assignment_id: null,
                            status: shouldCancelMeeting ? 'cancelled' : existingMeeting.status,
                            cancelled_reason: shouldCancelMeeting
                                ? existingMeeting.cancelled_reason || 'Usunięto przypisanie z tabeli działek.'
                                : existingMeeting.cancelled_reason ?? null,
                            status_updated_at: shouldCancelMeeting
                                ? new Date().toISOString()
                                : existingMeeting.status_updated_at ?? null
                        })
                        .eq('id', existingMeeting.id)
                    if (error) throw error
                }
                return
            }

            const worker = workersById.get(row.salesperson_id)
            const salespersonName = worker?.name || row.salesperson_name || 'Nieprzypisany'
            const parsedResultStatus = parsePoleAssignmentStatus(row.result_status)
            const status = row.status_ph || parsedResultStatus || existingMeeting?.status || 'planned'

            const meetingPayload: Partial<SalesMeeting> & {
                import_key: string
                scheduled_at: string
                client_name: string
                address: string
                salesperson_name: string
                status: SalesMeetingStatus
            } = {
                import_key: `pole-assignment|${row.id}`,
                pole_assignment_id: row.id,
                salesperson_id: row.salesperson_id,
                salesperson_name: salespersonName,
                lead_source: 'Tabela działek',
                scheduled_at: getScheduledAtForDate(row.planned_date, existingMeeting?.scheduled_at),
                phone: null,
                client_name: getPoleAssignmentClientName(row),
                region: row.voivodeship || null,
                county: row.county || null,
                address: getPoleAssignmentLocationLabel(row),
                note: normalizeSalesMeetingInlineText(row.notes) || null,
                status,
                pole_id: row.pole_id || null,
                pole_lat: row.pole_lat ?? null,
                pole_lng: row.pole_lng ?? null,
                parcel_id: row.parcel_id || null,
                parcel_number: row.parcel_number || null,
                surface_area: row.surface_area || null,
                locality_label: row.locality || null,
                municipality: row.municipality || null,
                precinct: null,
                kw_mode: row.kw_mode || null,
                kw_value: row.kw_mode === 'manual' ? row.kw_value?.trim() || null : null,
                pge_servitude_status: row.pge_servitude_status || null,
                owner_details: row.owner_details?.trim() || null,
                can_proceed: typeof row.can_proceed === 'boolean' ? row.can_proceed : null,
                travel_minutes: Number.isFinite(row.travel_minutes) ? row.travel_minutes : null,
                result_status: row.result_status?.trim() || null,
                worker_notes: row.worker_notes?.trim() || null
            }

            let error = null
            if (existingMeeting?.id) {
                ;({ error } = await supabase.from('sales_meetings').update(meetingPayload).eq('id', existingMeeting.id))
                if (error && isMissingSalesMeetingExtendedAssignmentColumnError(error)) {
                    ;({ error } = await supabase
                        .from('sales_meetings')
                        .update(omitExtendedSalesMeetingAssignmentFields(meetingPayload))
                        .eq('id', existingMeeting.id))
                }
            } else {
                ;({ error } = await supabase.from('sales_meetings').upsert(meetingPayload, { onConflict: 'import_key' }))
                if (error && isMissingSalesMeetingExtendedAssignmentColumnError(error)) {
                    ;({ error } = await supabase
                        .from('sales_meetings')
                        .upsert(omitExtendedSalesMeetingAssignmentFields(meetingPayload), { onConflict: 'import_key' }))
                }
            }
            if (error) throw error
        },
        [effectiveMeetingsByAssignmentId, workersById]
    )

    const saveRow = useCallback(
        async (row: PoleAssignment) => {
            const key = rowKey(row)
            setSavingId(row.id || -1) // Use -1 as temporary saving indicator for phantom rows

            try {
                const payload = {
                    pole_id: row.pole_id || null,
                    pole_lat: row.pole_lat ?? null,
                    pole_lng: row.pole_lng ?? null,
                    voivodeship: row.voivodeship || null,
                    county: row.county || null,
                    municipality: row.municipality || null,
                    locality: row.locality || null,
                    address: row.address || null,
                    parcel_number: row.parcel_number || null,
                    parcel_id: row.parcel_id || null,
                    surface_area: row.surface_area || null,
                    pole_count: row.pole_count || 1,
                    salesperson_id: row.salesperson_id ?? null,
                    salesperson_name: row.salesperson_name?.trim() || null,
                    planned_date: row.planned_date || null,
                    status_ph: row.status_ph || null,
                    kw_mode: row.kw_mode || null,
                    kw_value: row.kw_mode === 'manual' ? row.kw_value?.trim() || null : null,
                    pge_servitude_status: row.pge_servitude_status || null,
                    owner_details: row.owner_details?.trim() || null,
                    can_proceed: typeof row.can_proceed === 'boolean' ? row.can_proceed : null,
                    notes: row.notes?.trim() || null,
                    travel_minutes: Number.isFinite(row.travel_minutes) ? row.travel_minutes : null,
                    result_status: row.result_status?.trim() || null,
                    worker_notes: row.worker_notes?.trim() || null,
                    import_key: row.import_key
                }

                let effectiveId = row.id
                if (!effectiveId) {
                    const { data, error } = await supabase.from('pole_assignments').insert(payload).select('id').single()
                    if (error) throw error
                    effectiveId = data.id
                } else {
                    const { error } = await supabase.from('pole_assignments').update(payload).eq('id', effectiveId)
                    if (error) throw error
                }

                if (effectiveId) {
                    await syncMeetingForAssignment({ ...row, ...payload, id: effectiveId })
                }
                clearDirty(key)
                toast.success('Wiersz zapisany.')
                await loadData({ silent: true })
            } catch (error) {
                toast.error(`Nie udało się zapisać wiersza: ${mapSalesMeetingsMutationError(error)}`)
            } finally {
                setSavingId(null)
            }
        },
        [clearDirty, loadData, rowKey, syncMeetingForAssignment]
    )

    return (
        <div className="space-y-4">
            <div className={`${card} p-4 space-y-4`}>
                <div className="flex flex-wrap items-center gap-3">
                    <div>
                        <h3 className="text-sm font-black uppercase tracking-widest text-slate-800 dark:text-white">Tabela działek i słupów</h3>
                        <p className="mt-1 text-xs font-semibold text-slate-500 dark:text-slate-300">
                            Planowanie przypisań po działkach, słupach i rezultatach handlowców.
                        </p>
                    </div>
                    <div className="ml-auto flex flex-wrap gap-2">
                        <span className="rounded-full border border-cyan-300/60 bg-cyan-50 px-3 py-1 text-[11px] font-black uppercase tracking-wider text-cyan-700 dark:border-cyan-400/20 dark:bg-cyan-500/10 dark:text-cyan-200">
                            Wiersze: {stats.total}
                        </span>
                        <span className="rounded-full border border-emerald-300/60 bg-emerald-50 px-3 py-1 text-[11px] font-black uppercase tracking-wider text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-500/10 dark:text-emerald-200">
                            Przypisane: {stats.assigned}
                        </span>
                        <span className="rounded-full border border-violet-300/60 bg-violet-50 px-3 py-1 text-[11px] font-black uppercase tracking-wider text-violet-700 dark:border-violet-400/20 dark:bg-violet-500/10 dark:text-violet-200">
                            Z datą: {stats.dated}
                        </span>
                        <span className="rounded-full border border-rose-300/60 bg-rose-50 px-3 py-1 text-[11px] font-black uppercase tracking-wider text-rose-700 dark:border-rose-400/20 dark:bg-rose-500/10 dark:text-rose-200">
                            Do doprecyzowania: {stats.clarification}
                        </span>
                    </div>
                </div>
            </div>

            <div className={`${card} p-4 space-y-4`}>
                <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-5">
                    <input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Szukaj po adresie, działce, właścicielu..."
                        className={inputClass}
                    />
                    <select value={salespersonFilter} onChange={(event) => setSalespersonFilter(event.target.value)} className={selectClass}>
                        <option value="all">Wszyscy handlowcy</option>
                        {assignableWorkers.map((worker) => (
                            <option key={worker.id} value={String(worker.id)}>
                                {worker.name}
                            </option>
                        ))}
                    </select>
                    <select value={countyFilter} onChange={(event) => setCountyFilter(event.target.value)} className={selectClass}>
                        <option value="all">Wszystkie powiaty</option>
                        {countyOptions.map((county) => (
                            <option key={county} value={county}>
                                {county}
                            </option>
                        ))}
                    </select>
                    <select value={localityFilter} onChange={(event) => setLocalityFilter(event.target.value)} className={selectClass}>
                        <option value="all">Wszystkie miejscowości</option>
                        {localityOptions.map((locality) => (
                            <option key={locality} value={locality}>
                                {locality}
                            </option>
                        ))}
                    </select>
                    <input
                        value={localitySearch}
                        onChange={(event) => setLocalitySearch(event.target.value)}
                        placeholder="Wpisz miejscowość..."
                        list="pole-assignment-locality-options"
                        className={inputClass}
                    />
                    <datalist id="pole-assignment-locality-options">
                        {localityOptions.map((locality) => (
                            <option key={locality} value={locality} />
                        ))}
                    </datalist>
                    <select value={addressFilter} onChange={(event) => setAddressFilter(event.target.value as AddressFilter)} className={selectClass}>
                        <option value="all">Wszystkie adresy</option>
                        <option value="needs_clarification">Do doprecyzowania</option>
                        <option value="exact">Dokładne</option>
                    </select>
                </div>

                <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50/80 px-3 py-3 dark:border-slate-700 dark:bg-slate-900/40 lg:flex-row lg:items-center lg:justify-between">
                    <div className="space-y-1">
                        <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500 dark:text-slate-300">
                            Widok tabeli
                        </p>
                        <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                            Pokazujesz {visibleRangeLabel} działek.
                        </p>
                        <p className="text-[11px] font-semibold text-slate-400 dark:text-slate-500">
                            Status PH ustawia handlowiec podczas pracy, a tutaj admin może go tylko skorygować.
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={() => void loadData()}
                            disabled={loading || savingId !== null || hasPendingEdits}
                            className="ui-pressable rounded-xl border border-slate-300 bg-white px-3 py-2 text-[10px] font-black uppercase tracking-widest text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-40 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
                        >
                            {loading ? 'Odświeżam...' : 'Odśwież'}
                        </button>
                        <button
                            type="button"
                            onClick={() => setColumnPickerOpen((current) => !current)}
                            className="ui-pressable rounded-xl border border-slate-300 bg-white px-3 py-2 text-[10px] font-black uppercase tracking-widest text-slate-700 shadow-sm hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
                        >
                            {columnPickerOpen ? 'Ukryj kolumny' : 'Kolumny'}
                        </button>
                        <select
                            value={String(rowsPerPage)}
                            onChange={(event) => setRowsPerPage(Number(event.target.value))}
                            className="min-w-[150px] rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/20 dark:border-slate-600 dark:bg-slate-900/60 dark:text-slate-100"
                        >
                            {PAGE_SIZE_OPTIONS.map((size) => (
                                <option key={size} value={size}>
                                    {size} wierszy
                                </option>
                            ))}
                        </select>
                        <button
                            type="button"
                            onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                            disabled={currentPage <= 1}
                            className="ui-pressable rounded-xl border border-slate-300 bg-white px-3 py-2 text-[10px] font-black uppercase tracking-widest text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-40 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
                        >
                            Poprzednia
                        </button>
                        <span className="text-[11px] font-black uppercase tracking-wider text-slate-500 dark:text-slate-300">
                            Strona {Math.min(currentPage, totalPages)} / {totalPages}
                        </span>
                        <button
                            type="button"
                            onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                            disabled={currentPage >= totalPages}
                            className="ui-pressable rounded-xl border border-slate-300 bg-white px-3 py-2 text-[10px] font-black uppercase tracking-widest text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-40 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
                        >
                            Następna
                        </button>
                    </div>
                </div>
                {columnPickerOpen && (
                    <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-3 dark:border-slate-700 dark:bg-slate-900/40">
                        <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500 dark:text-slate-300">
                            Układ kolumn
                        </p>
                        <div className="mt-3 space-y-3 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-950/40">
                            <input
                                value={columnFilter}
                                onChange={(event) => setColumnFilter(event.target.value)}
                                placeholder="Filtruj nazwy kolumn..."
                                className={inputClass}
                            />

                            {filteredColumnOptions.length === 0 ? (
                                <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                                    Brak kolumn dla podanego filtra.
                                </p>
                            ) : (
                                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                                    {filteredColumnOptions.map((column) => {
                                        const checked = visibleColumnIds.includes(column.id)
                                        const isLastVisible = checked && visibleColumnIds.length === 1

                                        return (
                                            <label
                                                key={column.id}
                                                className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-200"
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    disabled={isLastVisible}
                                                    onChange={() => toggleColumnVisibility(column.id)}
                                                    className="h-4 w-4 rounded border-slate-300 text-cyan-500 focus:ring-cyan-500"
                                                />
                                                <span className="whitespace-normal break-normal">{column.label}</span>
                                            </label>
                                        )
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {schemaIssueMessage ? (
                    <div className="rounded-2xl border border-rose-300/70 bg-rose-50 px-4 py-4 text-rose-900 dark:border-rose-400/30 dark:bg-rose-500/10 dark:text-rose-100">
                        <p className="text-[11px] font-black uppercase tracking-[0.18em] text-rose-700 dark:text-rose-200">
                            Tabela działek nie jest jeszcze gotowa
                        </p>
                        <p className="mt-2 text-sm font-semibold leading-6">
                            {schemaIssueMessage}
                        </p>
                        <p className="mt-2 text-xs font-semibold leading-5 text-rose-700/90 dark:text-rose-200/90">
                            To nie jest brak bazy słupów, tylko brak tabeli roboczej pod przypisania handlowców. Po odpaleniu migracji z `src/appointments_table.sql` odśwież stronę i zakładka ruszy bez zmian po stronie frontu.
                        </p>
                    </div>
                ) : loading ? (
                    <p className="py-10 text-center text-xs font-black uppercase tracking-widest text-slate-400">Ładowanie tabeli...</p>
                ) : (
                    <div className="space-y-2">
                        <div
                            ref={tableViewportRef}
                            onWheelCapture={handleTableViewportWheelCapture}
                            className={`pole-assignments-table max-h-[72vh] overflow-y-auto overflow-x-auto overscroll-contain rounded-2xl border border-slate-200 dark:border-slate-700 ${hiddenColumnClasses}`}
                        >
                        <table
                            className="w-max min-w-full table-fixed border-separate border-spacing-0 text-center"
                            style={{ minWidth: `${tableMinWidthPx}px` }}
                        >
                            <colgroup>
                                {columns.map((column) => (
                                    <col
                                        key={column.id}
                                        style={{ width: `${column.widthPx}px` }}
                                        className={isColumnVisible(column.id) ? '' : 'hidden'}
                                    />
                                ))}
                            </colgroup>
                            <thead className="sticky top-0 z-20">
                                <tr>
                                    {columns.map((column, index) => {
                                        const label = column.label
                                        const isSingleWordLabel = !label.includes(' ')
                                        const isSortable = column.id !== 'actions'
                                        const sortState = isSortable && sortConfig?.columnId === column.id ? sortConfig.direction : null

                                        return (
                                            <th
                                                key={column.id}
                                                style={{ width: `${column.widthPx}px`, minWidth: `${column.widthPx}px`, maxWidth: `${column.widthPx}px` }}
                                                className={`border-b border-r border-slate-200 bg-slate-100 px-3 py-3 text-[10px] font-black uppercase tracking-[0.12em] text-center text-slate-500 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300 leading-4 align-middle ${isSingleWordLabel ? 'whitespace-nowrap' : 'whitespace-normal break-normal'} ${index === 0 ? 'border-l' : ''} ${isColumnVisible(column.id) ? '' : 'hidden'}`}
                                            >
                                                {isSortable ? (
                                                    <button
                                                        type="button"
                                                        onClick={() => toggleSort(column.id as PoleAssignmentSortableColumnId)}
                                                        className={`w-full flex items-center justify-center gap-1 text-center leading-4 transition-colors hover:text-cyan-600 dark:hover:text-cyan-300 ${isSingleWordLabel ? 'whitespace-nowrap' : 'whitespace-normal break-normal'}`}
                                                    >
                                                        <span>{label}</span>
                                                        <span className={`text-[9px] ${sortState ? 'text-cyan-500 dark:text-cyan-300' : 'text-slate-300 dark:text-slate-600'}`}>
                                                            {sortState === 'asc' ? '▲' : sortState === 'desc' ? '▼' : '↕'}
                                                        </span>
                                                    </button>
                                                ) : (
                                                    <span className={`mx-auto block text-center leading-4 ${isSingleWordLabel ? 'whitespace-nowrap' : 'whitespace-normal break-normal'}`}>{label}</span>
                                                )}
                                            </th>
                                        )
                                    })}
                                </tr>
                            </thead>
                            <tbody>
                                {paginatedRows.map((row) => {
                                    const key = rowKey(row)
                                    const linkedMeeting = row.id ? effectiveMeetingsByAssignmentId[row.id] : null
                                    const plannedDateValue = getRowPlannedDateInputValue(row, linkedMeeting)
                                    const statusValue = getStatusSelectValue(row, linkedMeeting)
                                    const linkedMeetingWorkerNote = linkedMeeting ? getPoleAssignmentWorkerNotes({ worker_notes: null }, linkedMeeting) : ''
                                    const resolvedWorkerNote = `${row.worker_notes || ''}`.trim() || linkedMeetingWorkerNote || ''
                                    const meetingStatusMeta = linkedMeeting ? getSalesMeetingDisplayMeta(linkedMeeting) : null
                                    const resolvedTravelLabel = Number.isFinite(row.travel_minutes) ? formatPoleAssignmentTravel(row.travel_minutes) : '-'
                                    const effectiveAddress = getEffectiveRowAddress(row, linkedMeeting)
                                    const addressStatusLabel = getPoleAssignmentAddressStatusLabel(
                                        {
                                            address: row.address,
                                            linkedAddress: linkedMeeting?.address || null,
                                            locality: row.locality || linkedMeeting?.locality_label || linkedMeeting?.precinct || null
                                        },
                                        effectiveAddress
                                    )
                                    const requiresClarification = Boolean(addressStatusLabel)
                                    const isDirty = dirtyKeys.has(key)
                                    const isSaving = savingId === row.id

                                    return (
                                        <tr
                                            key={key}
                                            className={requiresClarification ? 'bg-rose-50/70 dark:bg-rose-500/8' : 'bg-white dark:bg-slate-800/30'}
                                        >
                                            <td className="border-b border-slate-200 px-3 py-3 text-xs font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-100">{row.voivodeship || '-'}</td>
                                            <td className="border-b border-slate-200 px-3 py-3 text-xs font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-100">{row.county || '-'}</td>
                                            <td className="border-b border-slate-200 px-3 py-3 text-xs font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-100">{row.municipality || '-'}</td>
                                            <td className="border-b border-slate-200 px-3 py-3 text-xs font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-100">{row.locality || '-'}</td>
                                            <td className="border-b border-slate-200 px-3 py-3 align-middle dark:border-slate-700">
                                                <div className="space-y-2">
                                                    <p className="text-xs font-semibold text-slate-700 dark:text-slate-100">{effectiveAddress || '-'}</p>
                                                    {addressStatusLabel && (
                                                        <span className="inline-flex rounded-full border border-rose-300 bg-rose-100 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-rose-700 dark:border-rose-400/25 dark:bg-rose-500/10 dark:text-rose-200">
                                                            {addressStatusLabel}
                                                        </span>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="border-b border-slate-200 px-3 py-3 text-xs font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-100">{row.parcel_number || '-'}</td>
                                            <td className="border-b border-slate-200 px-3 py-3 text-xs font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-100">{row.parcel_id || '-'}</td>
                                            <td className="border-b border-slate-200 px-3 py-3 text-xs font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-100">{formatSurfaceArea(row.surface_area) || '-'}</td>
                                            <td className="border-b border-slate-200 px-3 py-3 align-middle dark:border-slate-700">
                                                <div className="min-w-0 max-w-full space-y-2">
                                                    <select
                                                        value={row.salesperson_id ? String(row.salesperson_id) : ''}
                                                        onChange={(event) => {
                                                            const nextId = event.target.value ? Number(event.target.value) : null
                                                            const nextWorker = nextId ? workersById.get(nextId) : null
                                                            updateRow(key, (current) => ({
                                                                ...current,
                                                                salesperson_id: nextId,
                                                                salesperson_name: nextWorker?.name || null
                                                            }))
                                                        }}
                                                        className={selectClass}
                                                    >
                                                        <option value="">Nieprzypisany</option>
                                                        {workers
                                                            .filter((worker): worker is User & { id: number } => typeof worker.id === 'number')
                                                            .map((worker) => (
                                                                <option key={worker.id} value={String(worker.id)}>
                                                                    {worker.name}
                                                                </option>
                                                            ))}
                                                    </select>
                                                    {row.salesperson_name && !row.salesperson_id && (
                                                        <p className="text-[10px] font-black uppercase tracking-wider text-amber-600 dark:text-amber-300">
                                                            Import: {row.salesperson_name}
                                                        </p>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="border-b border-slate-200 px-3 py-3 align-middle dark:border-slate-700">
                                                <div className="min-w-0 max-w-full space-y-2">
                                                    <input
                                                        type="date"
                                                        value={plannedDateValue}
                                                        onClick={(event) => openNativeDatePicker(event.currentTarget)}
                                                        onFocus={(event) => openNativeDatePicker(event.currentTarget)}
                                                        onChange={(event) => {
                                                            updateRow(key, (current) => ({
                                                                ...current,
                                                                planned_date: event.target.value || null
                                                            }))
                                                        }}
                                                        className={`${inputClass} pole-assignments-date-input w-full cursor-pointer`}
                                                    />
                                                    {linkedMeeting?.scheduled_at && (
                                                        <div className="space-y-2">
                                                            <div className="flex flex-wrap gap-1.5">
                                                                <span className="rounded-full border border-cyan-300/70 bg-cyan-50 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-cyan-700 dark:border-cyan-400/25 dark:bg-cyan-500/10 dark:text-cyan-200">
                                                                    W grafiku
                                                                </span>
                                                                {meetingStatusMeta && (
                                                                    <span className={`rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wider ${meetingStatusMeta.badgeClass}`}>
                                                                        {meetingStatusMeta.label}
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400 dark:text-slate-500">
                                                                Spotkanie: {new Date(linkedMeeting.scheduled_at).toLocaleDateString('pl-PL')} · {new Date(linkedMeeting.scheduled_at).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}
                                                            </p>
                                                        </div>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="border-b border-slate-200 px-3 py-3 text-xs font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-100">{row.pole_count ?? '-'}</td>
                                            <td className="border-b border-slate-200 px-3 py-3 align-middle dark:border-slate-700">
                                                <div className="min-w-0 max-w-full space-y-2">
                                                    <select
                                                        value={getKwModeSelectValue(row.kw_mode)}
                                                        onChange={(event) => {
                                                            const nextMode = (event.target.value || null) as PoleAssignmentKwMode | null
                                                            updateRow(key, (current) => ({
                                                                ...current,
                                                                kw_mode: nextMode,
                                                                kw_value: nextMode === 'manual' ? current.kw_value || '' : null
                                                            }))
                                                        }}
                                                        className={selectClass}
                                                    >
                                                        <option value="">Puste</option>
                                                        {POLE_ASSIGNMENT_KW_OPTIONS.map((option) => (
                                                            <option key={option.value} value={option.value}>
                                                                {option.label}
                                                            </option>
                                                        ))}
                                                    </select>
                                                    {row.kw_mode === 'manual' && (
                                                        <input
                                                            value={row.kw_value || ''}
                                                            onChange={(event) => updateRow(key, (current) => ({ ...current, kw_value: event.target.value }))}
                                                            placeholder="Wpisz ręcznie"
                                                            className={inputClass}
                                                        />
                                                    )}
                                                </div>
                                            </td>
                                            <td className="border-b border-slate-200 px-3 py-3 align-middle dark:border-slate-700">
                                                <select
                                                    value={getPgeSelectValue(row.pge_servitude_status)}
                                                    onChange={(event) =>
                                                        updateRow(key, (current) => ({
                                                            ...current,
                                                            pge_servitude_status: (event.target.value || null) as PoleAssignmentPgeServitudeStatus | null
                                                        }))
                                                    }
                                                    className={`${selectClass} w-full`}
                                                >
                                                    <option value="">Puste</option>
                                                    {POLE_ASSIGNMENT_PGE_OPTIONS.map((option) => (
                                                        <option key={option.value} value={option.value}>
                                                            {option.label}
                                                        </option>
                                                    ))}
                                                </select>
                                            </td>
                                            <td className="border-b border-slate-200 px-3 py-3 align-middle dark:border-slate-700">
                                                <textarea
                                                    value={row.owner_details || ''}
                                                    onChange={(event) => updateRow(key, (current) => ({ ...current, owner_details: event.target.value }))}
                                                    rows={2}
                                                    className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-700 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/20 dark:border-slate-600 dark:bg-slate-900/60 dark:text-slate-100"
                                                />
                                            </td>
                                            <td className="border-b border-slate-200 px-3 py-3 align-middle dark:border-slate-700">
                                                <select
                                                    value={getCanProceedSelectValue(row.can_proceed)}
                                                    onChange={(event) =>
                                                        updateRow(key, (current) => ({
                                                            ...current,
                                                            can_proceed: event.target.value === '' ? null : event.target.value === 'yes'
                                                        }))
                                                    }
                                                    className={`${selectClass} w-full`}
                                                >
                                                    {POLE_ASSIGNMENT_CAN_PROCEED_OPTIONS.map((option) => (
                                                        <option key={option.value || 'empty'} value={option.value}>
                                                            {option.label}
                                                        </option>
                                                    ))}
                                                </select>
                                            </td>
                                            <td className="border-b border-slate-200 px-3 py-3 align-middle dark:border-slate-700">
                                                <textarea
                                                    value={row.notes || ''}
                                                    onChange={(event) => updateRow(key, (current) => ({ ...current, notes: event.target.value }))}
                                                    placeholder="Uwagi do spotkania"
                                                    rows={2}
                                                    className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-700 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/20 dark:border-slate-600 dark:bg-slate-900/60 dark:text-slate-100"
                                                />
                                            </td>
                                            <td className="border-b border-slate-200 px-3 py-3 align-middle dark:border-slate-700">
                                                <div className="min-w-0 max-w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs font-semibold leading-relaxed text-slate-700 dark:border-slate-600 dark:bg-slate-900/60 dark:text-slate-200">
                                                    {resolvedWorkerNote || '-'}
                                                </div>
                                            </td>
                                            <td className="border-b border-slate-200 px-3 py-3 align-middle dark:border-slate-700">
                                                <select
                                                    value={statusValue}
                                                    onChange={(event) => updateRow(key, (current) => ({ ...current, status_ph: (event.target.value || null) as SalesMeetingStatus | null }))}
                                                    className={`${selectClass} w-full`}
                                                >
                                                    <option value="">Brak</option>
                                                    {SALES_MEETING_STATUSES.map((status) => (
                                                        <option key={status.key} value={status.key}>
                                                            {status.label}
                                                        </option>
                                                    ))}
                                                </select>
                                            </td>
                                            <td className="border-b border-slate-200 px-3 py-3 align-middle dark:border-slate-700">
                                                <div className="min-w-0 max-w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-black text-slate-700 dark:border-slate-600 dark:bg-slate-900/50 dark:text-slate-100">
                                                    {resolvedTravelLabel}
                                                </div>
                                            </td>
                                            <td className="border-b border-slate-200 px-3 py-3 align-middle dark:border-slate-700">
                                                <div className="min-w-0 max-w-full space-y-2">
                                                    <button
                                                        type="button"
                                                        disabled={isSaving || !isDirty}
                                                        onClick={() => void saveRow(row)}
                                                        className="ui-pressable w-full rounded-xl border border-cyan-400/35 bg-cyan-500 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white shadow-lg shadow-cyan-500/20 hover:bg-cyan-400 disabled:opacity-40"
                                                    >
                                                        {isSaving ? 'Wysyłanie...' : 'Wyślij'}
                                                    </button>
                                                    {linkedMeeting?.scheduled_at && !plannedDateValue && (
                                                        <p className="text-[10px] font-black uppercase tracking-wider text-slate-400 dark:text-slate-500">
                                                            Spotkanie: {new Date(linkedMeeting.scheduled_at).toLocaleDateString('pl-PL')}
                                                        </p>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                        </div>
                    </div>
                )}


                {!loading && rows.length > 0 && filteredRows.length === 0 && (
                    <p className="py-8 text-center text-xs font-black uppercase tracking-widest text-slate-400">
                        Brak wierszy dla wybranych filtrów.
                    </p>
                )}
            </div>
        </div>
    )
})

export default PoleAssignmentsPanel

