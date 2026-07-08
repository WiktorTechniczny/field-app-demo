import { useState, useEffect, useRef, useMemo, useCallback } from 'react'

import { motion, AnimatePresence } from 'framer-motion'

import { useAuth } from '../hooks/useAuth'

import { useMediaQuery } from '../hooks/useMediaQuery'

import { useTheme } from '../ThemeContext'

import { supabase } from '../supabase'

import MeetingImportsPanel from './MeetingImportsPanel'

import PoleAssignmentsPanel from './PoleAssignmentsPanel'

import type { User, Shift, Survey, GpsLog, SalesMeeting, SalesMeetingStatus } from '../db'

import { QS } from '../questions'

import { fetchAllLocalPoles, fetchPowerData, distanceMeters, calculatePathDistance, getPowerPoleDisplayAddress, getPowerPoleGoogleMapsUrl, getPowerPoleSuggestedLocation, hasPowerPoleParcelAssignment, resolvePowerPoleDetails, type PowerPole } from '../powerPoles'

import { buildPowerPoleDetailsHtml, getPowerVoltageLabel, renderPowerInfrastructure } from '../powerInfrastructureMap'

import { createParcelNumbersLayer, syncOverlayLayer } from '../mapLayers'

import { getSurveyRefusalStage, getSurveyStatus } from '../surveyStatus'

import { getSalesMeetingCleanStatusNote, getSalesMeetingDisplayMeta, getSalesMeetingStatusMeta } from '../salesMeetingStatus'

import {

    buildMeetingAddressQueries,

    geocodeMeetingAddress,

    getMeetingAddressCacheKey,

    type GeocodedMeetingAddress

} from '../meetingAddressGeocoding'

import { normalizeSalesMeetingInlineText } from '../salesMeetingText'

import { getSalesMeetingMapLocation, getSalesMeetingPrimaryLocationLabel } from '../salesMeetingLocation'

import AudioPlayer from '../components/AudioPlayer'

import DateRangePicker from '../components/DateRangePicker'

import { buildTranscriptText, downloadSurveyAudioAsMp3, downloadText, getTranscriptFilename } from '../audioUtils'

import { APP_VERSION } from '../appMeta'

import { formatSurveyDateTime, getSurveyTimingMeta } from '../surveyTiming'

import {

    getPoleAssignmentCanProceedLabel,

    getPoleAssignmentPgeLabel,

    getPoleAssignmentResultLabel,

    getSalesMeetingKwLabel

} from '../poleAssignments'

import { getLocalityCodeFromParcelId } from '../localityCatalog'

import { fetchAllLocalParcels, fetchParcelLocalities, filterParcelsByQuery, type ParcelLocalitySummary, type PiekoszowParcel } from '../piekoszowParcels'
import { fetchParcelTileIndex, scopeHasOfflineParcelGeometry, type ParcelTileIndex } from '../parcelCoverage'

import { COUNTY_MAP_SCOPE_PRESETS } from '../mapScopePresets'
import { boundaryPolygonContainsPoint, fetchCountyScopeBoundaries, fetchLocalityScopeBoundaries, fetchMunicipalityScopeBoundaries, type BoundaryPolygon, type LocalityScopeBoundary, type MapScopeBoundary, type MunicipalityScopeBoundary } from '../mapScopeBoundaries'
import { fetchOfflineScopeIndex, type OfflineScopeIndex, type OfflineScopeStats } from '../mapScopeIndex'
import { cleanDisplayText, normalizeNameKey } from '../textNormalization'

import { syncPoleAssignmentsFromScope } from '../poleAssignmentAutoSync'

import L from 'leaflet'

import 'leaflet/dist/leaflet.css'

import hotToast from 'react-hot-toast'



import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'

import markerIcon from 'leaflet/dist/images/marker-icon.png'

import markerShadow from 'leaflet/dist/images/marker-shadow.png'

delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: string })._getIconUrl

L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIcon, shadowUrl: markerShadow })



const todayISO = new Date().toISOString().split('T')[0]



type Tab = 'workers' | 'surveys' | 'map' | 'team' | 'imports' | 'parcels'

interface WS { 

    user: User; 

    todaySurveys: number; 

    todayCompleted: number;

    todayAttempted: number;

    todayRefused: number; 

    todayRefusedBefore: number;

    todayRefusedAfter: number;

    todayNotHome: number;

    todayNoCooperation: number;

    totalSurveys: number; 

    todayDistance: number;

    activeShift: Shift | null; 

    lastGps: GpsLog | null; 

    lastStartedAt?: string | null;

    lastFinishedAt?: string | null;

    dateStartedAt?: string | null;

    dateFinishedAt?: string | null;

    lastSurveyAt?: string | null;

    rangeMeetings: SalesMeeting[];

}



const card = "bg-white dark:bg-slate-800 rounded-xl border border-gray-200/60 dark:border-slate-700 shadow-md"

const innerCard = "bg-white shadow-sm border border-slate-200 dark:bg-slate-600/60 rounded-lg dark:border-slate-500"

const adminPrimaryButtonClass =

    "ui-pressable inline-flex items-center justify-center rounded-xl border border-cyan-400/35 bg-cyan-500 text-white shadow-lg shadow-cyan-500/20 hover:bg-cyan-400 font-black uppercase tracking-widest"

const adminSuccessButtonClass =

    "ui-pressable inline-flex items-center justify-center rounded-xl border border-emerald-400/35 bg-emerald-500 text-white shadow-lg shadow-emerald-500/20 hover:bg-emerald-400 font-black uppercase tracking-widest"

const adminDangerButtonClass =

    "ui-pressable inline-flex items-center justify-center rounded-xl border border-red-400/35 bg-red-500 text-white shadow-lg shadow-red-500/20 hover:bg-red-400 font-black uppercase tracking-widest"

const adminSecondaryButtonClass =

    "ui-pressable inline-flex items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-700 shadow-sm hover:bg-gray-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600 font-black uppercase tracking-widest"

const adminInfoButtonClass =

    "ui-pressable inline-flex items-center justify-center rounded-xl border border-blue-400/35 bg-blue-500 text-white shadow-lg shadow-blue-500/20 hover:bg-blue-400 font-black uppercase tracking-widest"

const MAP_VISIBLE_MEETING_STATUSES: SalesMeetingStatus[] = ['planned', 'follow_up', 'signed', 'refused', 'no_cooperation', 'not_home', 'cancelled']

const MAP_MEETING_MARKERS: Record<SalesMeetingStatus, { color: string; glyph: string }> = {

    planned: { color: '#7c3aed', glyph: '●' },

    follow_up: { color: '#f59e0b', glyph: '↻' },

    signed: { color: '#10b981', glyph: '✓' },

    refused: { color: '#ef4444', glyph: '×' },

    no_cooperation: { color: '#e11d48', glyph: 'F' },

    not_home: { color: '#3b82f6', glyph: '⌂' },

    cancelled: { color: '#94a3b8', glyph: '!' }

}



type MapMeetingLegendKey = SalesMeetingStatus | 'in_progress' | 'missed'



const MAP_MEETING_LEGEND_BADGE_CLASS: Record<MapMeetingLegendKey, string> = {

    planned: 'bg-violet-100 dark:bg-violet-500/12 border border-violet-200 dark:border-violet-500/20 text-violet-700 dark:text-violet-200',

    follow_up: 'bg-amber-100 dark:bg-amber-500/12 border border-amber-200 dark:border-amber-500/20 text-amber-700 dark:text-amber-200',

    signed: 'bg-green-100 dark:bg-green-500/12 border border-green-200 dark:border-green-500/20 text-green-700 dark:text-green-200',

    refused: 'bg-red-100 dark:bg-red-500/12 border border-red-200 dark:border-red-500/20 text-red-700 dark:text-red-200',

    no_cooperation: 'bg-rose-100 dark:bg-rose-500/12 border border-rose-200 dark:border-rose-500/20 text-rose-700 dark:text-rose-200',

    not_home: 'bg-blue-100 dark:bg-blue-500/12 border border-blue-200 dark:border-blue-500/20 text-blue-700 dark:text-blue-200',

    cancelled: 'bg-slate-100 dark:bg-slate-500/12 border border-slate-200 dark:border-slate-500/20 text-slate-700 dark:text-slate-200',

    in_progress: 'bg-cyan-100 dark:bg-cyan-500/12 border border-cyan-200 dark:border-cyan-500/20 text-cyan-700 dark:text-cyan-200',

    missed: 'bg-amber-100 dark:bg-amber-500/12 border border-amber-200 dark:border-amber-500/20 text-amber-700 dark:text-amber-200'

}



const MAP_MEETING_LEGEND_ITEMS = [

    {

        key: 'planned',

        label: getSalesMeetingStatusMeta('planned').label,

        glyph: MAP_MEETING_MARKERS.planned.glyph,

        className: MAP_MEETING_LEGEND_BADGE_CLASS.planned

    },

    {

        key: 'follow_up',

        label: getSalesMeetingStatusMeta('follow_up').label,

        glyph: MAP_MEETING_MARKERS.follow_up.glyph,

        className: MAP_MEETING_LEGEND_BADGE_CLASS.follow_up

    },

    {

        key: 'signed',

        label: getSalesMeetingStatusMeta('signed').label,

        glyph: MAP_MEETING_MARKERS.signed.glyph,

        className: MAP_MEETING_LEGEND_BADGE_CLASS.signed

    },

    {

        key: 'refused_before',

        label: 'Odmowa przed spotkaniem',

        glyph: MAP_MEETING_MARKERS.refused.glyph,

        className: MAP_MEETING_LEGEND_BADGE_CLASS.refused

    },

    {

        key: 'refused_after',

        label: 'Odmowa po spotkaniu',

        glyph: MAP_MEETING_MARKERS.refused.glyph,

        className: MAP_MEETING_LEGEND_BADGE_CLASS.refused

    },

    {

        key: 'no_cooperation',

        label: getSalesMeetingStatusMeta('no_cooperation').label,

        glyph: MAP_MEETING_MARKERS.no_cooperation.glyph,

        className: MAP_MEETING_LEGEND_BADGE_CLASS.no_cooperation

    },

    {

        key: 'not_home',

        label: getSalesMeetingStatusMeta('not_home').label,

        glyph: MAP_MEETING_MARKERS.not_home.glyph,

        className: MAP_MEETING_LEGEND_BADGE_CLASS.not_home

    },

    {

        key: 'cancelled',

        label: getSalesMeetingStatusMeta('cancelled').label,

        glyph: MAP_MEETING_MARKERS.cancelled.glyph,

        className: MAP_MEETING_LEGEND_BADGE_CLASS.cancelled

    },

    {

        key: 'in_progress' as const,

        label: 'W trakcie wizyty',

        glyph: '\u25b6',

        className: MAP_MEETING_LEGEND_BADGE_CLASS.in_progress

    },

    {

        key: 'missed' as const,

        label: 'Nieodbyte',

        glyph: '!',

        className: MAP_MEETING_LEGEND_BADGE_CLASS.missed

    }

]



const getMapMeetingMarkerMeta = (meeting: Pick<SalesMeeting, 'status' | 'status_note'>) => {

    const displayMeta = getSalesMeetingDisplayMeta(meeting)

    if (displayMeta.isInProgress) {

        return {

            color: '#06b6d4',

            glyph: '\u25b6'

        }

    }

    if (displayMeta.isMissed) {

        return {

            color: '#f59e0b',

            glyph: '!'

        }

    }

    return MAP_MEETING_MARKERS[displayMeta.baseKey] || MAP_MEETING_MARKERS.planned

}

type MapLocalitySummary = ParcelLocalitySummary & {
    boundaryPolygons?: BoundaryPolygon[]
    offlineStats?: OfflineScopeStats
}

type MapMunicipalitySummary = BoundsLike & {
    code: string
    label: string
    displayCode: string
    badgeLabel?: string
    scopeKind: 'municipality'
    localityCodes: string[]
    countyLabels: string[]
    municipalityLabels?: string[]
    boundaryPolygons?: BoundaryPolygon[]
    precincts: string[]
    count: number
    offlineStats?: OfflineScopeStats
    offlineSummary?: string
    offlineDataReady?: boolean
    parcelGeometryOffline?: boolean
}

type ParcelSearchResult = Pick<PiekoszowParcel, 'id' | 'parcelNumber' | 'south' | 'west' | 'north' | 'east' | 'localityLabel' | 'municipality' | 'precinct' | 'county'>



const resolveMeetingWorkerId = (meeting: SalesMeeting, workers: WS[]): number | null => {

    if (typeof meeting.salesperson_id === 'number') return meeting.salesperson_id

    const meetingName = normalizeNameKey(meeting.salesperson_name)

    if (!meetingName) return null

    const matchedWorker = workers.find((worker) => normalizeNameKey(worker.user.name) === meetingName)

    return matchedWorker?.user.id ?? null

}



function dedupeSurveys(rawSurveys: Survey[]): Survey[] {

    const byKey = new Map<string, Survey>()

    rawSurveys.forEach((survey) => {

        const key = survey.id

            ? `id:${survey.id}`

            : `tmp:${survey.user_id}:${survey.created_at}:${survey.address || ''}:${survey.respondent_name || ''}`



        const existing = byKey.get(key)

        if (!existing || new Date(survey.created_at).getTime() > new Date(existing.created_at).getTime()) {

            byKey.set(key, survey)

        }

    })



    return Array.from(byKey.values()).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

}



function spreadOverlappingMarkers<T extends { lat: number; lng: number }>(

    points: T[],

    radiusMeters = 9

): Array<T & { renderLat: number; renderLng: number }> {

    const grouped = new Map<string, T[]>()

    points.forEach((point) => {

        const key = `${point.lat.toFixed(6)}|${point.lng.toFixed(6)}`

        const arr = grouped.get(key)

        if (arr) arr.push(point)

        else grouped.set(key, [point])

    })



    const spread: Array<T & { renderLat: number; renderLng: number }> = []

    grouped.forEach((group) => {

        if (group.length === 1) {

            const p = group[0]

            spread.push({ ...p, renderLat: p.lat, renderLng: p.lng })

            return

        }



        group.forEach((p, idx) => {

            const angle = (idx / group.length) * 2 * Math.PI

            const dLat = (radiusMeters * Math.sin(angle)) / 111111

            const safeCos = Math.max(0.2, Math.cos((p.lat * Math.PI) / 180))

            const dLng = (radiusMeters * Math.cos(angle)) / (111111 * safeCos)

            spread.push({ ...p, renderLat: p.lat + dLat, renderLng: p.lng + dLng })

        })

    })



    return spread

}



function snapToNearestAvailablePole<T extends { lat: number; lng: number }>(

    points: T[],

    poles: Array<{ lat: number; lng: number }>,

    maxDistanceMeters = 30

): T[] {

    const occupiedPoles = new Set<string>()



    return points.map((point) => {

        let nearestPole: { lat: number; lng: number } | null = null

        let nearestDistance = Number.POSITIVE_INFINITY



        for (const pole of poles) {

            const d = distanceMeters(point.lat, point.lng, pole.lat, pole.lng)

            if (d <= maxDistanceMeters && d < nearestDistance) {

                nearestDistance = d

                nearestPole = pole

            }

        }



        if (!nearestPole) return point



        const poleKey = `${nearestPole.lat.toFixed(6)}|${nearestPole.lng.toFixed(6)}`

        if (occupiedPoles.has(poleKey)) return point



        occupiedPoles.add(poleKey)

        return { ...point, lat: nearestPole.lat, lng: nearestPole.lng }

    })

}



const getAttemptedNote = (survey: Survey): string => {

    const raw = survey.answers?.notatka_z_kontaktu

    if (typeof raw === 'string') return raw.trim()

    if (Array.isArray(raw)) return raw.map((item) => String(item)).join(', ').trim()

    return ''

}



const getSurveyAnswerDisplayValue = (survey: Survey, questionId: string): string => {

    const raw = survey.answers?.[questionId]

    if (typeof raw === 'string') return raw.trim()

    if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean).join(', ')

    if (raw === null || raw === undefined) return ''

    return String(raw).trim()

}



const getSurveyMeetingId = (survey: Survey): string => {

    const rawMeetingId = Array.isArray(survey.answers?.meeting_id) ? survey.answers.meeting_id[0] : survey.answers?.meeting_id

    return typeof rawMeetingId === 'string' ? rawMeetingId.trim() : ''

}



const getLinkedMeetingForSurvey = (survey: Survey, meetings: SalesMeeting[]): SalesMeeting | null => {

    const surveyMeetingId = getSurveyMeetingId(survey)

    if (surveyMeetingId) {

        const byId = meetings.find((meeting) => String(meeting.id) === surveyMeetingId)

        if (byId) return byId

    }



    if (typeof survey.id === 'number') {

        const byLinkedSurvey = meetings.find((meeting) => meeting.linked_survey_id === survey.id)

        if (byLinkedSurvey) return byLinkedSurvey

    }



    return null

}



const escapeCsvCell = (value: unknown): string => {

    const normalized = value === null || value === undefined ? '' : String(value)

    return `"${normalized.replace(/"/g, '""')}"`

}



const escapeHtml = (value: string): string =>

    value

        .replace(/&/g, '&amp;')

        .replace(/</g, '&lt;')

        .replace(/>/g, '&gt;')

        .replace(/"/g, '&quot;')

        .replace(/'/g, '&#39;')



const MAP_LOCALITY_PADDING_DEGREES = 0.0025



type BoundsLike = {

    south: number

    west: number

    north: number

    east: number

}



type MapScopeOption = BoundsLike & {

    code: string

    displayCode: string

    label: string

    count: number

    badgeLabel?: string

    scopeKind: 'locality' | 'county' | 'municipality'

    localityCodes: string[]

    countyLabels: string[]

    municipalityLabels?: string[]

    boundaryPolygons?: BoundaryPolygon[]

    precincts: string[]

    offlineStats?: OfflineScopeStats

    offlineSummary?: string

    offlineDataReady?: boolean

    parcelGeometryOffline?: boolean

}

const formatOfflineScopeSummary = (stats?: OfflineScopeStats | null): string | undefined => {

    if (!stats) return undefined

    const parts = [`S ${stats.poles}`, `SN ${stats.byVoltage.sn}`, `WN ${stats.byVoltage.wn}`, `L ${stats.lines}`, `D ${stats.resolvedPoles}`]

    return parts.join(' | ')

}


const getMapScopeTypeLabel = (scope: Pick<MapScopeOption, 'scopeKind'>): string =>

    scope.scopeKind === 'county' ? 'powiat' : scope.scopeKind === 'municipality' ? 'gmina' : 'miejscowo\u015B\u0107'

type AddressPresenceFilter = 'all' | 'exact' | 'missing'

const EMPTY_OFFLINE_SCOPE_STATS: OfflineScopeStats = {
    code: '',
    label: '',
    kind: 'locality',
    poles: 0,
    lines: 0,
    resolvedPoles: 0,
    exactAddresses: 0,
    assignmentAddresses: 0,
    byVoltage: { nn: 0, sn: 0, wn: 0, unknown: 0 }
}

const buildOfflineScopeNameKeys = (label?: string | null, precincts?: string[]): string[] =>
    Array.from(
        new Set(
            [label || '', ...(precincts || [])]
                .map((value) => normalizeNameKey(cleanDisplayText(value).trim()))
                .filter(Boolean)
        )
    )

const mergeOfflineScopeStats = (statsList: Array<OfflineScopeStats | undefined>): OfflineScopeStats | undefined => {
    const resolved = statsList.filter(Boolean) as OfflineScopeStats[]
    if (resolved.length === 0) return undefined

    return resolved.reduce<OfflineScopeStats>((accumulator, stats, index) => {
        if (index === 0) {
            return {
                ...stats,
                byVoltage: { ...stats.byVoltage },
                precincts: [...(stats.precincts || [])],
                localityCodes: [...(stats.localityCodes || [])]
            }
        }

        accumulator.poles += stats.poles
        accumulator.lines += stats.lines
        accumulator.resolvedPoles += stats.resolvedPoles
        accumulator.exactAddresses += stats.exactAddresses
        accumulator.assignmentAddresses += stats.assignmentAddresses
        accumulator.byVoltage.nn += stats.byVoltage.nn
        accumulator.byVoltage.sn += stats.byVoltage.sn
        accumulator.byVoltage.wn += stats.byVoltage.wn
        accumulator.byVoltage.unknown += stats.byVoltage.unknown
        accumulator.parcelCount = (accumulator.parcelCount || 0) + (stats.parcelCount || 0)
        accumulator.precincts = Array.from(new Set([...(accumulator.precincts || []), ...(stats.precincts || [])]))
        accumulator.localityCodes = Array.from(new Set([...(accumulator.localityCodes || []), ...(stats.localityCodes || [])]))
        return accumulator
    }, {
        ...EMPTY_OFFLINE_SCOPE_STATS,
        byVoltage: { ...EMPTY_OFFLINE_SCOPE_STATS.byVoltage }
    })
}

const isTechnicalLocalityLabel = (label?: string | null): boolean => {

    const normalized = cleanDisplayText(label || '').trim()

    if (!normalized) return true

    return /^obr\.?\s*\d+/i.test(normalized) || /^bez obszaru$/i.test(normalized)

}

const shouldHideMapScopeOption = (scope: Pick<MapScopeOption, 'scopeKind' | 'code' | 'label'>): boolean => {

    if (scope.scopeKind !== 'locality') return false

    if (scope.code.startsWith('unknown::')) return true

    return isTechnicalLocalityLabel(scope.label)

}

const getBoundsArea = (bounds: BoundsLike): number =>
    Math.max(0, bounds.north - bounds.south) * Math.max(0, bounds.east - bounds.west)

const isSuspiciousLocalityBoundary = (boundary: LocalityScopeBoundary, locality?: ParcelLocalitySummary | null): boolean => {
    const boundaryArea = getBoundsArea(boundary)
    if (boundaryArea > 0.12) return true
    if (boundary.localityCodes.length <= 1 && (boundary.east - boundary.west > 0.4 || boundary.north - boundary.south > 0.4)) return true
    if (!locality) return false

    const localityArea = getBoundsArea(locality)
    if (localityArea <= 0) return false

    return boundaryArea > localityArea * 12
}

const shouldDrawMapScopeBoundary = (scope: Pick<MapScopeOption, 'scopeKind' | 'code' | 'label'>): boolean => {
    if (scope.scopeKind === 'county') return true
    return !scope.code.startsWith('unknown::') && !isTechnicalLocalityLabel(scope.label)
}

const shouldUseStrictPolygonScope = (scope: Pick<MapScopeOption, 'code' | 'label' | 'boundaryPolygons'>): boolean =>
    !scope.code.startsWith('unknown::') &&
    !isTechnicalLocalityLabel(scope.label) &&
    Boolean(scope.boundaryPolygons && scope.boundaryPolygons.length > 0)

const boundsContainPoint = (bounds: BoundsLike, lat: number, lng: number, paddingDegrees = 0): boolean =>

    lat >= bounds.south - paddingDegrees &&

    lat <= bounds.north + paddingDegrees &&

    lng >= bounds.west - paddingDegrees &&

    lng <= bounds.east + paddingDegrees



const pointMatchesLocalityBounds = (

    lat: number,

    lng: number,

    localities: BoundsLike[],

    paddingDegrees = MAP_LOCALITY_PADDING_DEGREES

): boolean => localities.length === 0 || localities.some((locality) => boundsContainPoint(locality, lat, lng, paddingDegrees))

const pointMatchesSelectedScopes = (

    lat: number,

    lng: number,

    scopes: Array<Pick<MapScopeOption, 'code' | 'label' | 'south' | 'west' | 'north' | 'east' | 'boundaryPolygons'>>,

    paddingDegrees = MAP_LOCALITY_PADDING_DEGREES

): boolean => {
    if (scopes.length === 0) return true

    return scopes.some((scope) => {
        if (shouldUseStrictPolygonScope(scope)) {
            return boundaryPolygonContainsPoint(scope.boundaryPolygons, lat, lng)
        }

        return boundsContainPoint(scope, lat, lng, paddingDegrees)
    })
}



const findMatchingLocalitySummary = (

    lat: number,

    lng: number,

    localities: Array<ParcelLocalitySummary & { boundaryPolygons?: BoundaryPolygon[] }>,

    paddingDegrees = MAP_LOCALITY_PADDING_DEGREES

): ParcelLocalitySummary | null =>
    localities.find((locality) => {
        if (locality.boundaryPolygons && locality.boundaryPolygons.length > 0 && !locality.code.startsWith('unknown::') && !isTechnicalLocalityLabel(locality.label)) {
            return boundaryPolygonContainsPoint(locality.boundaryPolygons, lat, lng)
        }

        return boundsContainPoint(locality, lat, lng, paddingDegrees)
    }) || null



const mergeBounds = (items: BoundsLike[]): BoundsLike | null => {

    if (items.length === 0) return null



    return items.reduce<BoundsLike>(

        (acc, item) => ({

            south: Math.min(acc.south, item.south),

            west: Math.min(acc.west, item.west),

            north: Math.max(acc.north, item.north),

            east: Math.max(acc.east, item.east)

        }),

        { ...items[0] }

    )

}

const localityDedupeBucketKey = (locality: Pick<MapLocalitySummary, 'label' | 'south' | 'west' | 'north' | 'east' | 'municipalities'>): string => {

    const centerLat = Math.round((((locality.south + locality.north) / 2) * 10)) / 10

    const centerLng = Math.round((((locality.west + locality.east) / 2) * 10)) / 10

    return `${normalizeNameKey(locality.label)}::${normalizeNameKey(locality.municipalities?.[0] || '')}::${centerLat.toFixed(1)}::${centerLng.toFixed(1)}`

}

const dedupeMapLocalities = (items: MapLocalitySummary[]): MapLocalitySummary[] => {

    const deduped = new Map<string, MapLocalitySummary>()

    items.forEach((locality) => {

        const bucketKey = localityDedupeBucketKey(locality)

        const existing = deduped.get(bucketKey)

        if (!existing) {

            deduped.set(bucketKey, {
                ...locality,
                localityCodes: [...locality.localityCodes],
                precincts: [...locality.precincts],
                boundaryPolygons: locality.boundaryPolygons ? [...locality.boundaryPolygons] : undefined
            })

            return

        }

        const preferred =
            (locality.localityCodes.length > 0 && existing.localityCodes.length === 0) ||
            (!locality.code.startsWith('unknown::') && existing.code.startsWith('unknown::'))
                ? locality
                : existing

        deduped.set(bucketKey, {
            ...preferred,
            south: preferred.south,
            west: preferred.west,
            north: preferred.north,
            east: preferred.east,
            count: Math.max(existing.count, locality.count),
            localityCodes: Array.from(new Set([...existing.localityCodes, ...locality.localityCodes])),
            precincts: Array.from(new Set([...existing.precincts, ...locality.precincts])),
            municipalities: Array.from(new Set([...(existing.municipalities || []), ...(locality.municipalities || [])])),
            countyLabels: Array.from(new Set([...(existing.countyLabels || []), ...(locality.countyLabels || [])])),
            boundaryPolygons:
                (preferred.boundaryPolygons && preferred.boundaryPolygons.length > 0)
                    ? preferred.boundaryPolygons
                    : (existing.boundaryPolygons && existing.boundaryPolygons.length > 0)
                        ? existing.boundaryPolygons
                        : locality.boundaryPolygons
        })

    })

    return Array.from(deduped.values())

}



const slugifyFilenamePart = (value: string): string =>

    normalizeNameKey(value)

        .replace(/[^a-z0-9]+/g, '_')

        .replace(/^_+|_+$/g, '') || 'obszar'



const downloadCsvFile = (filename: string, content: string): void => {

    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })

    const url = URL.createObjectURL(blob)

    const link = document.createElement('a')

    link.href = url

    link.download = filename

    document.body.appendChild(link)

    link.click()

    document.body.removeChild(link)

    URL.revokeObjectURL(url)

}



type TimedRoutePoint = { lat: number; lng: number; at: number }



function sanitizeRoutePoints(points: TimedRoutePoint[]): TimedRoutePoint[] {

    if (points.length <= 1) return points



    const sorted = [...points].sort((a, b) => a.at - b.at)

    const out: TimedRoutePoint[] = [sorted[0]]



    for (let i = 1; i < sorted.length; i += 1) {

        const prev = out[out.length - 1]

        const curr = sorted[i]

        const dist = distanceMeters(prev.lat, prev.lng, curr.lat, curr.lng)

        const dtSec = (curr.at - prev.at) / 1000



        // Ignore tiny GPS jitter duplicates.

        if (dist < 4 && dtSec < 20) continue

        // Ignore impossible jumps caused by bad GPS fixes.

        if (dtSec > 0 && dist > 200) {

            const speed = dist / dtSec

            if (speed > 55) continue

        }

        if (dtSec <= 0 && dist > 150) continue



        out.push(curr)

    }



    return out

}



function buildDisplayRoute(gpsPoints: GpsLog[], surveyPoints: Survey[]): [number, number][] {

    const gpsTimed: TimedRoutePoint[] = gpsPoints

        .map((g) => ({ lat: g.latitude, lng: g.longitude, at: Date.parse(g.timestamp) }))

        .filter((p) => Number.isFinite(p.at) && Number.isFinite(p.lat) && Number.isFinite(p.lng))



    const surveyTimed: TimedRoutePoint[] = surveyPoints

        .filter((s) => typeof s.latitude === 'number' && typeof s.longitude === 'number')

        .map((s) => ({ lat: Number(s.latitude), lng: Number(s.longitude), at: Date.parse(s.created_at) }))

        .filter((p) => Number.isFinite(p.at) && Number.isFinite(p.lat) && Number.isFinite(p.lng))



    // Add survey points only where GPS did not capture nearby position in similar time window.

    const surveyFallback = surveyTimed.filter((sv) => {

        return !gpsTimed.some((gp) => {

            const nearInTime = Math.abs(gp.at - sv.at) <= 20 * 60 * 1000

            const nearInSpace = distanceMeters(gp.lat, gp.lng, sv.lat, sv.lng) <= 45

            return nearInTime && nearInSpace

        })

    })



    const merged = sanitizeRoutePoints([...gpsTimed, ...surveyFallback])

    return merged.map((p) => [p.lat, p.lng] as [number, number])

}



interface WorkerActivitySummary {

    statusLabel: string

    timeLabel: string

    badgeClass: string

    detailTag: string

    detailLabel: string

    detailClass: string

}



const WORKER_FRESH_GPS_MINUTES = 15

const WORKER_SOON_MEETING_MINUTES = 45

const WORKER_JUST_STARTED_MEETING_MINUTES = 15

const WORKER_RECENT_RESULT_MINUTES = 25

const WORKER_OPEN_MEETING_STATUSES: SalesMeetingStatus[] = ['planned', 'follow_up']



const formatWorkerClock = (value?: string | null): string => {

    if (!value) return ''

    const parsed = new Date(value)

    if (Number.isNaN(parsed.getTime())) return ''

    return parsed.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })

}



const formatWorkerMinutes = (minutes: number): string => {

    const safeMinutes = Math.max(0, Math.round(minutes))

    if (safeMinutes < 1) return 'mniej niż 1 min'

    const hours = Math.floor(safeMinutes / 60)

    const mins = safeMinutes % 60

    if (hours > 0 && mins > 0) return `${hours}h ${mins} min`

    if (hours > 0) return `${hours}h`

    return `${mins} min`

}



const getWorkerMeetingLabel = (meeting?: Pick<SalesMeeting, 'client_name' | 'address'> | null): string => {

    if (!meeting) return 'klient'

    return normalizeSalesMeetingInlineText(meeting.client_name) || getSalesMeetingPrimaryLocationLabel(meeting) || 'klient'

}



function getWorkerActivitySummary(worker: WS, dateFrom: string, dateTo: string): WorkerActivitySummary {

    const todayIso = new Date().toISOString().split('T')[0]

    const now = new Date()

    const nowMs = now.getTime()

    const isTodayInRange = dateTo === todayIso && dateFrom <= todayIso

    const isActiveInRange = worker.todaySurveys > 0 || (worker.activeShift && isTodayInRange)

    const isFinishedInRange = !!worker.dateFinishedAt && worker.dateFinishedAt >= `${dateFrom}T00:00:00` && worker.dateFinishedAt <= `${dateTo}T23:59:59`

    const hasStartedInRange = !!worker.dateStartedAt && worker.dateStartedAt >= `${dateFrom}T00:00:00` && worker.dateStartedAt <= `${dateTo}T23:59:59`



    const todayMeetings = worker.rangeMeetings

        .filter((meeting) => meeting.scheduled_at >= `${todayIso}T00:00:00` && meeting.scheduled_at <= `${todayIso}T23:59:59`)

        .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime())



    const inProgressMeeting = isTodayInRange

        ? todayMeetings.find((meeting) => getSalesMeetingDisplayMeta(meeting, now).isInProgress) || null

        : null



    const dueMeeting = isTodayInRange

        ? todayMeetings.find((meeting) => {

            if (!WORKER_OPEN_MEETING_STATUSES.includes(meeting.status)) return false

            if (getSalesMeetingDisplayMeta(meeting, now).isMissed) return false

            const scheduledAtMs = new Date(meeting.scheduled_at).getTime()

            if (Number.isNaN(scheduledAtMs)) return false

            const diffMinutes = (nowMs - scheduledAtMs) / 60000

            return diffMinutes >= 0 && diffMinutes <= WORKER_JUST_STARTED_MEETING_MINUTES

        }) || null

        : null



    const nextMeeting = isTodayInRange

        ? todayMeetings.find((meeting) => {

            if (!WORKER_OPEN_MEETING_STATUSES.includes(meeting.status)) return false

            if (getSalesMeetingDisplayMeta(meeting, now).isMissed) return false

            const scheduledAtMs = new Date(meeting.scheduled_at).getTime()

            return !Number.isNaN(scheduledAtMs) && scheduledAtMs > nowMs

        }) || null

        : null



    const recentResolvedMeeting = isTodayInRange

        ? [...todayMeetings]

            .filter((meeting) => {

                const displayMeta = getSalesMeetingDisplayMeta(meeting, now)

                if ((WORKER_OPEN_MEETING_STATUSES.includes(meeting.status) || displayMeta.isInProgress) && !displayMeta.isMissed) return false

                if (meeting.status === 'cancelled') return false

                const updatedAtMs = meeting.status_updated_at ? new Date(meeting.status_updated_at).getTime() : NaN

                return !Number.isNaN(updatedAtMs) && (nowMs - updatedAtMs) / 60000 <= WORKER_RECENT_RESULT_MINUTES

            })

            .sort((a, b) => new Date(b.status_updated_at || b.scheduled_at).getTime() - new Date(a.status_updated_at || a.scheduled_at).getTime())[0] || null

        : null



    const lastGpsMs = worker.lastGps ? new Date(worker.lastGps.timestamp).getTime() : NaN

    const lastSurveyMs = worker.lastSurveyAt ? new Date(worker.lastSurveyAt).getTime() : NaN

    const gpsAgeMinutes = Number.isNaN(lastGpsMs) ? null : (nowMs - lastGpsMs) / 60000

    const surveyAgeMinutes = Number.isNaN(lastSurveyMs) ? null : (nowMs - lastSurveyMs) / 60000

    const hasFreshGps = gpsAgeMinutes !== null && gpsAgeMinutes >= 0 && gpsAgeMinutes <= WORKER_FRESH_GPS_MINUTES



    let statusLabel = worker.activeShift && isTodayInRange ? 'Na zmianie' : isActiveInRange ? 'Aktywny w zakresie' : 'Brak aktywności'

    let timeLabel = ''

    let detailTag = 'Status'

    let detailLabel = ''

    let badgeClass = worker.activeShift

        ? 'bg-green-500 text-white border-green-400 animate-pulse ring-2 ring-green-500/20'

        : (isActiveInRange || isFinishedInRange)

            ? 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-500 border-cyan-500/20 dark:border-cyan-500/30'

            : 'bg-slate-100 text-slate-500 dark:bg-slate-800/50 dark:text-slate-400 border-slate-200 dark:border-slate-700/50'

    let detailClass = worker.activeShift

        ? 'border-green-200/70 bg-green-50 text-green-700 dark:border-green-400/20 dark:bg-green-500/10 dark:text-green-200'

        : 'border-slate-200/70 bg-slate-50 text-slate-600 dark:border-slate-600/50 dark:bg-slate-800/40 dark:text-slate-300'



    const effectiveStartAt = worker.activeShift && isTodayInRange

        ? worker.activeShift.start_time

        : worker.dateStartedAt



    if (hasStartedInRange && effectiveStartAt) {

        const start = new Date(effectiveStartAt)

        const end = worker.activeShift && isTodayInRange ? new Date() : (worker.dateFinishedAt ? new Date(worker.dateFinishedAt) : null)

        const sH = String(start.getHours()).padStart(2, '0')

        const sM = String(start.getMinutes()).padStart(2, '0')

        timeLabel = `${sH}:${sM}`



        if (end) {

            const eH = String(end.getHours()).padStart(2, '0')

            const eM = String(end.getMinutes()).padStart(2, '0')

            const diff = end.getTime() - start.getTime()

            const hours = Math.floor(diff / 3600000)

            const mins = Math.floor((diff % 3600000) / 60000)

            timeLabel = `${sH}:${sM} - ${worker.activeShift && isTodayInRange ? 'TERAZ' : `${eH}:${eM}`} (${hours}h ${mins}m)`



            if (!(worker.activeShift && isTodayInRange) && isFinishedInRange) {

                statusLabel = 'Po zmianie'

                detailTag = 'Zmiana'

                detailLabel = `Zmianę zakończył o ${eH}:${eM}`

            }

        }

    }



    if (worker.activeShift && isTodayInRange) {

        if (inProgressMeeting) {

            statusLabel = 'Na spotkaniu'

            detailTag = 'Spotkanie'

            badgeClass = 'bg-cyan-500 text-white border-cyan-400 ring-2 ring-cyan-500/20'

            detailClass = 'border-cyan-200/80 bg-cyan-50 text-cyan-700 dark:border-cyan-400/20 dark:bg-cyan-500/10 dark:text-cyan-200'

            detailLabel = `${getWorkerMeetingLabel(inProgressMeeting)} · od ${formatWorkerClock(inProgressMeeting.scheduled_at)}`

        } else if (dueMeeting) {

            const diffMinutes = Math.max(0, Math.round((nowMs - new Date(dueMeeting.scheduled_at).getTime()) / 60000))

            statusLabel = 'Termin trwa'

            detailTag = 'Spotkanie'

            badgeClass = 'bg-amber-500 text-white border-amber-400 ring-2 ring-amber-500/20'

            detailClass = 'border-amber-200/80 bg-amber-50 text-amber-700 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-200'

            detailLabel = `${getWorkerMeetingLabel(dueMeeting)} · start ${formatWorkerClock(dueMeeting.scheduled_at)}${diffMinutes > 0 ? ` · ${formatWorkerMinutes(diffMinutes)} temu` : ''}`

        } else if (nextMeeting) {

            const nextMeetingMinutes = Math.max(0, Math.round((new Date(nextMeeting.scheduled_at).getTime() - nowMs) / 60000))

            const nextMeetingClock = formatWorkerClock(nextMeeting.scheduled_at)

            const nextMeetingLabel = getWorkerMeetingLabel(nextMeeting)

            if (nextMeetingMinutes <= WORKER_SOON_MEETING_MINUTES) {

                statusLabel = hasFreshGps ? 'W drodze' : 'Przed spotkaniem'

                detailTag = hasFreshGps ? 'Dojazd' : 'Plan'

                badgeClass = hasFreshGps

                    ? 'bg-violet-500 text-white border-violet-400 ring-2 ring-violet-500/20'

                    : 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-400/30 dark:border-amber-400/20'

                detailClass = hasFreshGps

                    ? 'border-violet-200/80 bg-violet-50 text-violet-700 dark:border-violet-400/20 dark:bg-violet-500/10 dark:text-violet-200'

                    : 'border-amber-200/80 bg-amber-50 text-amber-700 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-200'

                detailLabel = `${nextMeetingLabel} · start za ${formatWorkerMinutes(nextMeetingMinutes)} (${nextMeetingClock})`

            } else {

                statusLabel = 'Między spotkaniami'

                detailTag = 'Plan'

                detailClass = 'border-green-200/70 bg-green-50 text-green-700 dark:border-green-400/20 dark:bg-green-500/10 dark:text-green-200'

                detailLabel = `Następne ${nextMeetingClock} · ${nextMeetingLabel}`

            }

        } else if (recentResolvedMeeting) {

            const resolvedMeta = getSalesMeetingDisplayMeta(recentResolvedMeeting, now)

            statusLabel = 'Po spotkaniu'

            detailTag = 'Wynik'

            badgeClass = 'bg-emerald-500 text-white border-emerald-400 ring-2 ring-emerald-500/20'

            detailClass = 'border-emerald-200/80 bg-emerald-50 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-500/10 dark:text-emerald-200'

            detailLabel = `${getWorkerMeetingLabel(recentResolvedMeeting)} · ${resolvedMeta.label.toLowerCase()} o ${formatWorkerClock(recentResolvedMeeting.status_updated_at || recentResolvedMeeting.scheduled_at)}`

        } else if (surveyAgeMinutes !== null && surveyAgeMinutes >= 0 && surveyAgeMinutes <= WORKER_RECENT_RESULT_MINUTES) {

            statusLabel = 'Po spotkaniu'

            detailTag = 'Wynik'

            badgeClass = 'bg-emerald-500 text-white border-emerald-400 ring-2 ring-emerald-500/20'

            detailClass = 'border-emerald-200/80 bg-emerald-50 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-500/10 dark:text-emerald-200'

            detailLabel = `Ostatni formularz zapisany o ${formatWorkerClock(worker.lastSurveyAt)}`

        } else if (hasFreshGps) {

            statusLabel = 'W terenie'

            detailTag = 'Teren'

            detailLabel = `Pozycja potwierdzona o ${formatWorkerClock(worker.lastGps?.timestamp)}`

        } else {

            statusLabel = 'Na zmianie'

            detailTag = 'Pozycja'

            detailLabel = worker.lastGps

                ? `Ostatnia pozycja z ${formatWorkerClock(worker.lastGps.timestamp)}`

                : 'Brak świeżej pozycji z terenu'

        }

    } else if (!worker.activeShift && isTodayInRange) {

        if (nextMeeting) {

            statusLabel = 'Przed startem'

            detailTag = 'Start'

            badgeClass = 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200 border-slate-300 dark:border-slate-600'

            detailClass = 'border-slate-200/80 bg-slate-50 text-slate-600 dark:border-slate-600/50 dark:bg-slate-800/40 dark:text-slate-300'

            detailLabel = `Pierwsze spotkanie ${formatWorkerClock(nextMeeting.scheduled_at)} · ${getWorkerMeetingLabel(nextMeeting)}`

        } else if (isFinishedInRange && !detailLabel) {

            detailTag = 'Zmiana'

            detailLabel = worker.dateFinishedAt

                ? `Zmianę zakończył o ${formatWorkerClock(worker.dateFinishedAt)}`

                : 'Zmiana zakończona'

        }

    } else if (!detailLabel) {

        if (hasStartedInRange) {

            detailTag = 'Zakres'

            detailLabel = worker.todaySurveys > 0

                ? `Wizyty w zakresie: ${worker.todaySurveys}`

                : 'Pracował w wybranym zakresie dat'

        } else if (worker.rangeMeetings.length > 0) {

            detailTag = 'Plan'

            detailLabel = `Zaplanowane spotkania w zakresie: ${worker.rangeMeetings.length}`

        } else {

            detailTag = 'Zakres'

            detailLabel = 'Brak zmiany i spotkań w wybranym zakresie'

        }

    }



    return { statusLabel, timeLabel, badgeClass, detailTag, detailLabel, detailClass }

}



function WorkerStatsOverview({ worker, className = '', variant = 'compact' }: { worker: WS; className?: string; variant?: 'compact' | 'details' }) {

    const completionRate = worker.todaySurveys > 0 ? Math.round(((worker.todayCompleted || 0) / worker.todaySurveys) * 100) : 0



    const stats = [

        { label: 'Umowa', compactLabel: 'UMOWA', title: 'Umowa podpisana', value: worker.todayCompleted || 0, tone: 'text-teal-600 dark:text-teal-400', shell: 'bg-teal-500/10 ring-teal-500/20', accent: 'text-teal-500' },

        { label: 'Odm. przed', compactLabel: 'ODM.PRZ', title: 'Odmowa przed spotkaniem', value: worker.todayRefusedBefore || 0, tone: 'text-red-600 dark:text-red-400', shell: 'bg-red-500/10 ring-red-500/20', accent: 'text-red-500' },

        { label: 'Odm. po', compactLabel: 'ODM.PO', title: 'Odmowa po spotkaniu', value: worker.todayRefusedAfter || 0, tone: 'text-orange-600 dark:text-orange-400', shell: 'bg-orange-500/10 ring-orange-500/20', accent: 'text-orange-500' },

        { label: 'Kontakt pon.', compactLabel: 'K.PON', title: 'Kontakt ponowny', value: worker.todayAttempted || 0, tone: 'text-cyan-600 dark:text-cyan-400', shell: 'bg-cyan-500/10 ring-cyan-500/20', accent: 'text-cyan-500' },

        { label: 'Brak wsp.', compactLabel: 'INNE', title: 'Brak wspolpracy', value: worker.todayNoCooperation || 0, tone: 'text-rose-600 dark:text-rose-400', shell: 'bg-rose-500/10 ring-rose-500/20', accent: 'text-rose-500' },

        { label: 'Nie było', compactLabel: 'N.BYL', title: 'Nie było nikogo', value: worker.todayNotHome || 0, tone: 'text-blue-600 dark:text-blue-400', shell: 'bg-blue-500/10 ring-blue-500/20', accent: 'text-blue-500' }

    ]



    if (variant === 'compact') {

        return (

            <div className={`flex w-full flex-col gap-2.5 shrink-0 sm:w-auto sm:flex-row sm:justify-center ${className}`.trim()}>

                <div className="w-full min-w-0 bg-white dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700/50 rounded-2xl px-3 py-2.5 shadow-xs sm:min-w-70 sm:w-auto">

                    <div className="flex items-center gap-2.5 mb-2">

                        <span className="text-2xl font-black text-slate-700 dark:text-white leading-none">{worker.todaySurveys}</span>

                        <span className="text-[9px] text-gray-400 font-black uppercase tracking-widest">wizyt</span>

                        <span className="ml-auto text-lg font-black text-indigo-500 leading-none">{worker.todayDistance.toFixed(1)}<span className="text-[9px] text-indigo-400/70 font-black ml-0.5">km</span></span>

                    </div>

                    <div className="grid grid-cols-6 gap-1.5 sm:gap-2">

                        {stats.map((stat) => (

                            <div key={stat.title} className={`${stat.shell} rounded-xl px-1 py-1.5 text-center ring-1 ring-inset shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] sm:px-1.5 sm:py-2`} title={stat.title}>

                                <p className={`text-[8px] font-black uppercase leading-none tracking-[0.03em] mb-1 whitespace-nowrap sm:text-[9.5px] sm:tracking-[0.04em] ${stat.accent}`}>{stat.compactLabel}</p>

                                <p className={`text-[15px] font-black leading-none sm:text-[17px] ${stat.tone}`}>{stat.value}</p>

                            </div>

                        ))}

                    </div>

                </div>



                <div className="w-full min-w-0 bg-white dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700/50 rounded-2xl px-3.5 py-2.5 text-center flex flex-col justify-center shadow-xs sm:w-auto sm:min-w-[96px] lg:shrink-0">

                    <p className="text-[10px] text-violet-500 dark:text-violet-300 font-black uppercase tracking-widest mb-1">Skut.</p>

                    <p className="text-2xl font-black text-violet-600 dark:text-violet-400 leading-none">{completionRate}%</p>

                </div>

            </div>

        )

    }



    return (

        <div className={`w-full space-y-4 ${className}`.trim()}>

            <div className="grid grid-cols-3 gap-4">

                <div className="min-w-0 border-r border-slate-700/60 pr-4">

                    <p className="text-[9px] text-gray-500 font-black uppercase tracking-[0.18em]">Dzisiaj</p>

                    <div className="mt-1.5 flex items-end gap-2">

                        <span className="text-3xl font-black leading-none text-white">{worker.todaySurveys}</span>

                        <span className="pb-0.5 text-[9px] text-gray-500 font-black uppercase tracking-widest">Wizyt</span>

                    </div>

                </div>

                <div className="min-w-0 border-r border-slate-700/60 pr-4">

                    <p className="text-[9px] text-gray-500 font-black uppercase tracking-[0.18em]">Trasa</p>

                    <div className="mt-1.5 flex items-end gap-2">

                        <span className="text-3xl font-black leading-none text-indigo-400">{worker.todayDistance.toFixed(1)}</span>

                        <span className="pb-0.5 text-[9px] text-gray-500 font-black uppercase tracking-widest">km</span>

                    </div>

                </div>

                <div className="min-w-0">

                    <p className="text-[9px] text-gray-500 font-black uppercase tracking-[0.18em]">Skuteczność</p>

                    <div className="mt-1.5 flex items-end gap-2">

                        <span className="text-3xl font-black leading-none text-violet-400">{completionRate}%</span>

                    </div>

                </div>

            </div>



            <div className="border-t border-slate-700/60 pt-4">

                <div className="mb-3 flex items-center justify-between">

                    <p className="text-[9px] text-gray-500 font-black uppercase tracking-[0.18em]">Rozbicie statusów</p>

                </div>

                <div className="grid grid-cols-3 gap-3 xl:grid-cols-6">

                    {stats.map((stat) => (

                        <div key={stat.title} className={`${stat.shell} rounded-2xl px-2.5 py-3 text-center ring-1 ring-inset`} title={stat.title}>

                            <p className={`text-[8px] font-black uppercase leading-none tracking-wider mb-2 ${stat.accent}`}>{stat.label}</p>

                            <p className={`text-lg font-black leading-none ${stat.tone}`}>{stat.value}</p>

                        </div>

                    ))}

                </div>

            </div>

        </div>

    )

}



export default function AdminPanel() {

    const { logout } = useAuth()

    const { dark, toggle } = useTheme()

    const [tab, setTab] = useState<Tab>('workers')

    const [workers, setWorkers] = useState<WS[]>([])

    const [surveys, setSurveys] = useState<Survey[]>([])

    const [salesMeetings, setSalesMeetings] = useState<SalesMeeting[]>([])

    const [allGps, setAllGps] = useState<GpsLog[]>([])

    const [allShifts, setAllShifts] = useState<Shift[]>([])

    const [expanded, setExpanded] = useState<string | null>(null)

    const [reload, setReload] = useState(0)

    const [dateFrom, setDateFrom] = useState(new Date().toISOString().split('T')[0])

    const [dateTo, setDateTo] = useState(new Date().toISOString().split('T')[0])



    const [selectedWorkerId, setSelectedWorkerId] = useState<number | null>(null)

    const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)



    // Add worker form

    const [showAddForm, setShowAddForm] = useState(false)

    const [newName, setNewName] = useState('')

    const [newLogin, setNewLogin] = useState('')

    const [newPassword, setNewPassword] = useState('')



    // Modal states

    const [confirmDelete, setConfirmDelete] = useState<{ id: number; name: string } | null>(null)

    const [surveyToDelete, setSurveyToDelete] = useState<{ id: number | string; label: string } | null>(null)

    const [showOnlySuccessful, setShowOnlySuccessful] = useState(false)

    const [editingWorker, setEditingWorker] = useState<User | null>(null)

    const [editData, setEditData] = useState({ name: '', login: '', password: '', role: 'worker' as 'worker' | 'admin' })



    const deleteSurvey = async (id: number | string) => {

        try {

            // First delete associated appointment so limits are released

            const { error: appError } = await supabase.from('appointments').delete().eq('survey_id', id)

            if (appError) console.warn('Błąd podczas usuwania powiązanego spotkania:', appError.message)

            

            const { error } = await supabase.from('surveys').delete().eq('id', id)

            if (error) throw error



            setSurveyToDelete(null)

            setExpanded(null)

            setReload(r => r + 1)

            showToast('Wpis zostal usuniety')

        } catch (error) {

            console.error('Błąd usuwania:', error)

            showToast('Blad podczas usuwania wpisu!', 'error')

        }

    }



    const showToast = (msg: string, type: 'success' | 'error' = 'success') => {

        setToast({ msg, type })

        setTimeout(() => setToast(null), 3000)

    }



    const closeAddForm = () => {

        setNewName('')

        setNewLogin('')

        setNewPassword('')

        setShowAddForm(false)

    }



    const addWorker = async () => {

        if (!newName.trim() || !newLogin.trim() || !newPassword.trim()) return

        const { data: exists } = await supabase.from('users').select('id').eq('login', newLogin.trim()).maybeSingle()

        if (exists) { showToast('Login już istnieje!', 'error'); return }

        await supabase.from('users').insert({ login: newLogin.trim(), password: newPassword.trim(), name: newName.trim(), role: 'worker' })

        closeAddForm()

        setReload((r) => r + 1)

        showToast('Utworzono konto pracownika')

    }



    const deleteWorker = async (userId: number) => {

        await supabase.from('users').delete().eq('id', userId)

        setConfirmDelete(null)

        setReload((r) => r + 1)

        showToast('Usunięto pracownika')

    }



    const saveEdit = async () => {

        if (!editingWorker) return

        await supabase.from('users').update(editData).eq('id', editingWorker.id)

        setEditingWorker(null)

        setReload((r) => r + 1)

        showToast('Zaktualizowano dane')

    }





    useEffect(() => {

        const load = async () => {

            const [uResp, svResp, shResp, recentGpsResp, rangeGpsResp, meetingsResp] = await Promise.all([

                supabase.from('users').select('*').eq('role', 'worker'),

                supabase.from('surveys').select('*'),

                supabase.from('shifts').select('*'),

                supabase.from('gps_logs').select('*').order('timestamp', { ascending: false }).limit(200),

                supabase.from('gps_logs').select('*').gte('timestamp', `${dateFrom}T00:00:00`).lte('timestamp', `${dateTo}T23:59:59`),

                supabase

                    .from('sales_meetings')

                    .select('*')

                    .gte('scheduled_at', `${dateFrom}T00:00:00`)

                    .lte('scheduled_at', `${dateTo}T23:59:59`)

            ])

            const users = uResp.data || []

            const rawSv = svResp.data || []

            const sv = dedupeSurveys(rawSv)

            const sh = shResp.data || []

            const meetings = (meetingsResp.data || []) as SalesMeeting[]

            const gps = [...(recentGpsResp.data || []), ...(rangeGpsResp.data || [])];

            const uniqueGpsMap = new Map();

            gps.forEach(g => uniqueGpsMap.set(g.id, g));

            const uniqueGps = Array.from(uniqueGpsMap.values());



            setWorkers(users.map((u) => {

                const us = sv.filter((s) => s.user_id === u.id)

                // Filter surveys within the selected [dateFrom, dateTo] range

                const rangeSurveys = us.filter((s) => s.created_at >= `${dateFrom}T00:00:00` && s.created_at <= `${dateTo}T23:59:59`)

                const workerMeetings = meetings

                    .filter((meeting) => {

                        if (typeof meeting.salesperson_id === 'number') return meeting.salesperson_id === u.id

                        const meetingName = normalizeNameKey(meeting.salesperson_name)

                        return meetingName.length > 0 && meetingName === normalizeNameKey(u.name)

                    })

                    .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime())

                

                const userShifts = sh.filter((s) => s.user_id === u.id).sort((a,b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime())

                const statusCounts = rangeSurveys.reduce((acc, survey) => {

                    const statusMeta = getSurveyStatus(survey)

                    acc[statusMeta.key] += 1

                    if (statusMeta.key === 'refused') {

                        const refusalStage = getSurveyRefusalStage(survey)

                        if (refusalStage === 'before_meeting') acc.refusedBefore += 1

                        else if (refusalStage === 'after_meeting') acc.refusedAfter += 1

                    }

                    return acc

                }, {

                    completed: 0,

                    attempted: 0,

                    refused: 0,

                    refusedBefore: 0,

                    refusedAfter: 0,

                    not_home: 0,

                    no_cooperation: 0

                })

                

                const userGpsRange = uniqueGps.filter(g => g.user_id === u.id && g.timestamp >= `${dateFrom}T00:00:00` && g.timestamp <= `${dateTo}T23:59:59`).sort((a,b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

                const rangeDist = calculatePathDistance(userGpsRange)

                

                const dateShifts = userShifts.filter(s => {

                    const shiftStart = s.start_time;

                    const shiftEnd = s.end_time || `${dateTo}T23:59:59`;

                    return shiftStart <= `${dateTo}T23:59:59` && shiftEnd >= `${dateFrom}T00:00:00`;

                })



                return {

                    user: u,

                    todaySurveys: rangeSurveys.length,

                    todayCompleted: statusCounts.completed,

                    todayAttempted: statusCounts.attempted,

                    todayRefused: statusCounts.refused,

                    todayRefusedBefore: statusCounts.refusedBefore,

                    todayRefusedAfter: statusCounts.refusedAfter,

                    todayNotHome: statusCounts.not_home,

                    todayNoCooperation: statusCounts.no_cooperation,

                    totalSurveys: rangeSurveys.length,

                    todayDistance: rangeDist,

                    activeShift: userShifts.find((s) => !s.end_time),

                    lastGps: uniqueGps.filter((g) => g.user_id === u.id && g.timestamp <= `${dateTo}T23:59:59`).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()).pop() || null,

                    dateStartedAt: dateShifts.length > 0 ? dateShifts[dateShifts.length - 1].start_time : null,

                    dateFinishedAt: dateShifts.length > 0 ? dateShifts[0].end_time : null,

                    lastSurveyAt: rangeSurveys[0]?.created_at || null,

                    rangeMeetings: workerMeetings

                }

            }))

            setSurveys(sv.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()))

            setSalesMeetings(meetings.sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime()))

            setAllGps(uniqueGps.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()))

            setAllShifts(sh)

        }

        load(); const i = setInterval(load, 5000); return () => clearInterval(i)

    }, [reload, dateFrom, dateTo])



    // Simplified main states since maps are now isolated

    const totalToday = workers.reduce((s, w) => s + w.todaySurveys, 0)

    const totalTodayCompleted = workers.reduce((s, w) => s + (w.todayCompleted || 0), 0)

    const totalTodayAttempted = workers.reduce((s, w) => s + (w.todayAttempted || 0), 0)

    const totalTodayRefusedBefore = workers.reduce((s, w) => s + (w.todayRefusedBefore || 0), 0)

    const totalTodayRefusedAfter = workers.reduce((s, w) => s + (w.todayRefusedAfter || 0), 0)

    const totalTodayNotHome = workers.reduce((s, w) => s + (w.todayNotHome || 0), 0)

    const totalTodayNoCooperation = workers.reduce((s, w) => s + (w.todayNoCooperation || 0), 0)

    const todayCompletionRate = totalToday > 0 ? Math.round((totalTodayCompleted / totalToday) * 100) : 0

    const active = workers.filter((w) => w.activeShift).length

    const teamAdminCount = workers.filter((worker) => worker.user.role === 'admin').length

    const teamWorkerCount = workers.length - teamAdminCount

    const selectedWorker = useMemo(

        () => (selectedWorkerId ? workers.find((worker) => worker.user.id === selectedWorkerId) ?? null : null),

        [selectedWorkerId, workers]

    )

    const isDesktopAdminLayout = useMediaQuery('(min-width: 1280px)')

    const tabs: { id: Tab; label: string; shortLabel: string; icon: string }[] = [

        { id: 'workers', label: 'Pracownicy / Przegląd', shortLabel: 'Pracownicy / Przegląd', icon: '\u{1F465}' },

        { id: 'surveys', label: 'Historia spotkań', shortLabel: 'Historia spotkań', icon: '\u{1F4C4}' },

        { id: 'parcels', label: 'Tabela działek', shortLabel: 'Tabela działek', icon: '\u{1F5C2}' },

        { id: 'imports', label: 'Zaplanowane spotkania', shortLabel: 'Zaplanowane spotkania', icon: '\u{1F4E5}' },

        { id: 'map', label: 'Globalna mapa', shortLabel: 'Globalna mapa', icon: '\u{1F4CD}' }

    ]

    const panelMetaByTab: Record<Tab, { title: string; description: string }> = {

        workers: {

            title: 'Pracownicy / Przegląd',

            description: 'Podgląd aktywności handlowców i szybkie wejście w szczegóły pracy.'

        },

        surveys: {

            title: 'Historia spotkań',

            description: 'Lista raportów, eksport CSV i filtrowanie spotkań z wybranego zakresu.'

        },

        parcels: {

            title: 'Tabela działek i słupów',

            description: 'Planowanie przypisań, adresów i statusów pracy na działkach.'

        },

        imports: {

            title: 'Zaplanowane spotkania',

            description: 'Import CSV, ręczne dodawanie oraz obsługa grafiku spotkań.'

        },

        map: {

            title: 'Globalna mapa',

            description: 'Mapa terenu z aktywnością zespołu, trasami i punktami spotkań.'

        },

        team: {

            title: 'Konta',

            description: 'Zarządzanie kontami administratorów i handlowców.'

        }

    }

    const activePanelMeta = selectedWorker

        ? {

            title: selectedWorker.user.name,

            description: 'Szczegóły aktywności wybranego pracownika w zaznaczonym zakresie.'

        }

        : panelMetaByTab[tab]



    const downloadCsv = async () => {

        const { data: rawSurveys } = await supabase

            .from('surveys')

            .select('*')

            .gte('created_at', `${dateFrom}T00:00:00`)

            .lte('created_at', `${dateTo}T23:59:59`);

        const svRange = rawSurveys || [];

        const filteredSurveys = svRange.filter(s => showOnlySuccessful ? (s.status === 'completed' && s.respondent_name !== 'ODMOWA / PRZERWANO' && s.answers?.pole_status !== 'Odmowa' && s.answers?.pole_status !== 'Odmowa/Przerwanie') : true);

        if (filteredSurveys.length === 0) {

            setToast({ msg: 'Brak spotkań do eksportu z wybranego okresu', type: 'error' });

            setTimeout(() => setToast(null), 3000);

            return;

        }



        const headers = [

            'Ankieta ID',

            'Shift ID',

            'Data zapisu',

            'Godzina zapisu',

            'Status ankiety',

            'Start formularza',

            'Koniec formularza',

            'Czas spotkania',

            'Respondent',

            'Telefon respondenta',

            'Adres ankiety',

            'Pracownik',

            'Umówiona data',

            'Umówiona godzina',

            'GPS szer.',

            'GPS dł.',

            'Nagranie audio',

            'Transkrypcja',

            'Spotkanie ID',

            'Termin spotkania',

            'Status spotkania',

            'Notatka statusu',

            'Powód anulowania',

            'Źródło leada',

            'Handlowiec z grafiku',

            'Klient z grafiku',

            'Telefon z grafiku',

            'Adres z grafiku',

            'Region',

            'Notatka spotkania',

            'Powiat',

            'Powierzchnia dzialki',

            'KW dzialki',

            'Sluzebnosc PGE',

            'Wlasciciel',

            'Czy mozemy dzialac',

            'Czas dojazdu',

            'Rezultat PH',

            'Uwagi PH',

            ...QS.map((q) => `${q.num}. ${q.text}`)

        ]



        const rows = filteredSurveys.map((survey) => {

            const surveyStatusMeta = getSurveyStatus(survey)

            const surveyTiming = getSurveyTimingMeta(survey)

            const linkedMeeting = getLinkedMeetingForSurvey(survey, salesMeetings)

            const meetingDisplayMeta = linkedMeeting ? getSalesMeetingDisplayMeta(linkedMeeting) : null

            const cleanStatusNote = linkedMeeting ? getSalesMeetingCleanStatusNote(linkedMeeting.status_note) : ''



            const row = [

                survey.id ?? '',

                survey.shift_id ?? '',

                new Date(survey.created_at).toLocaleDateString('pl-PL'),

                new Date(survey.created_at).toLocaleTimeString('pl-PL'),

                surveyStatusMeta.label,

                formatSurveyDateTime(surveyTiming.startedAt),

                formatSurveyDateTime(surveyTiming.finishedAt),

                surveyTiming.durationLabel || '',

                survey.respondent_name || '',

                survey.respondent_phone || '',

                survey.address || '',

                survey.user_name || '',

                survey.respondent_preferred_date || '',

                survey.respondent_preferred_time || '',

                typeof survey.latitude === 'number' ? survey.latitude.toFixed(6) : '',

                typeof survey.longitude === 'number' ? survey.longitude.toFixed(6) : '',

                survey.audio_url ? 'Tak' : 'Nie',

                survey.audio_transcript?.trim() || '',

                linkedMeeting?.id ?? getSurveyMeetingId(survey),

                linkedMeeting?.scheduled_at ? new Date(linkedMeeting.scheduled_at).toLocaleString('pl-PL') : '',

                meetingDisplayMeta?.label || '',

                cleanStatusNote || '',

                linkedMeeting?.cancelled_reason || '',

                linkedMeeting?.lead_source || '',

                linkedMeeting?.salesperson_name || '',

                linkedMeeting?.client_name || '',

                linkedMeeting?.phone || '',

                linkedMeeting?.address || '',

                linkedMeeting?.region || '',

                linkedMeeting?.note || '',

                linkedMeeting?.county || '',

                linkedMeeting?.surface_area || '',

                linkedMeeting ? getSalesMeetingKwLabel(linkedMeeting) : '',

                linkedMeeting ? getPoleAssignmentPgeLabel(linkedMeeting.pge_servitude_status) : '',

                linkedMeeting?.owner_details || '',

                linkedMeeting ? getPoleAssignmentCanProceedLabel(linkedMeeting.can_proceed) : '',

                Number.isFinite(linkedMeeting?.travel_minutes) ? `${linkedMeeting?.travel_minutes} min` : '',

                linkedMeeting ? getPoleAssignmentResultLabel(linkedMeeting.result_status) : '',

                linkedMeeting?.worker_notes || '',

                ...QS.map((q) => getSurveyAnswerDisplayValue(survey, q.id))

            ]



            return row.map(escapeCsvCell).join(';')

        })



        const csvContent = "\uFEFF" + [headers.join(';'), ...rows].join('\n');

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });

        const url = URL.createObjectURL(blob);

        const link = document.createElement('a');

        link.href = url;

        link.setAttribute('download', `spotkania_${dateFrom}_do_${dateTo}.csv`);

        document.body.appendChild(link);

        link.click();

        document.body.removeChild(link);

        URL.revokeObjectURL(url);

    };



    const dateRangeControl = (

        <DateRangePicker

            dateFrom={dateFrom}

            dateTo={dateTo}

            onChange={(nextFrom, nextTo) => {

                setDateFrom(nextFrom)

                setDateTo(nextTo)

            }}

        />

    )



    const adminShellClassName = isDesktopAdminLayout

        ? 'mx-auto w-full max-w-[1680px] px-4 py-6 md:px-6 xl:px-8'

        : 'mx-auto max-w-lg px-4 py-6 md:max-w-4xl lg:max-w-6xl'



    return (

        <div className={adminShellClassName}>

            <div className={`mb-4 flex flex-col gap-3 ${isDesktopAdminLayout ? 'xl:flex-row xl:items-center xl:justify-between' : ''}`}>

                <div className="min-w-0 flex-1">

                    <div className="flex flex-wrap items-center gap-2.5">

                        <h1 className="text-2xl font-black tracking-tight text-slate-800 dark:text-white">{activePanelMeta.title}</h1>

                        <span className="rounded-full border border-teal-300/60 bg-teal-50 px-3 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-teal-600 dark:border-teal-400/20 dark:bg-teal-500/10 dark:text-teal-300">

                            v{APP_VERSION}

                        </span>

                    </div>

                    <p className="mt-1 text-sm font-semibold leading-relaxed text-slate-500 dark:text-slate-300">

                        {activePanelMeta.description}

                    </p>

                </div>

                <div className="flex flex-wrap items-center gap-2">

                    <button

                        type="button"

                        onClick={toggle}

                        className="ui-pressable inline-flex items-center gap-2 rounded-2xl border border-slate-300 bg-slate-100 px-4 py-3 text-[10px] font-black uppercase tracking-[0.18em] text-slate-700 shadow-sm transition-colors hover:bg-white dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"

                    >

                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="h-4 w-4 shrink-0" strokeWidth="2">

                            {dark ? (

                                <>

                                    <circle cx="12" cy="12" r="4" />

                                    <path d="M12 2v2.2M12 19.8V22M4.93 4.93l1.56 1.56M17.51 17.51l1.56 1.56M2 12h2.2M19.8 12H22M4.93 19.07l1.56-1.56M17.51 6.49l1.56-1.56" />

                                </>

                            ) : (

                                <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" />

                            )}

                        </svg>

                        {dark ? 'Jasny' : 'Ciemny'}

                    </button>

                    <button

                        type="button"

                        onClick={() => {

                            setSelectedWorkerId(null)

                            setTab('team')

                        }}

                        className={`ui-pressable inline-flex items-center gap-2 rounded-2xl border px-4 py-3 text-[10px] font-black uppercase tracking-[0.18em] shadow-sm transition-colors ${

                            tab === 'team'

                                ? 'border-cyan-400/35 bg-cyan-500 text-white'

                                : 'border-slate-300 bg-slate-100 text-slate-700 hover:bg-white dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700'

                        }`}

                    >

                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="h-4 w-4 shrink-0" strokeWidth="2">

                            <path d="M4 19a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4" />

                            <circle cx="12" cy="7" r="4" />

                        </svg>

                        Konta

                    </button>

                    <button

                        type="button"

                        onClick={() => logout()}

                        className="ui-pressable inline-flex items-center gap-2 rounded-2xl border border-red-400/35 bg-red-500 px-4 py-3 text-[10px] font-black uppercase tracking-[0.18em] text-white shadow-sm transition-colors hover:bg-red-400 dark:border-red-400/30 dark:bg-red-500 dark:text-white dark:hover:bg-red-400"

                    >

                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="h-4 w-4 shrink-0" strokeWidth="2">

                            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />

                            <path d="M16 17l5-5-5-5" />

                            <path d="M21 12H9" />

                        </svg>

                        Wyloguj

                    </button>

                </div>

            </div>



            <div className={`mb-6 grid gap-3 ${isDesktopAdminLayout ? 'xl:grid-cols-[minmax(0,1fr)_17.75rem] xl:items-center' : ''}`}>

                <div className={`min-w-0 ${isDesktopAdminLayout ? 'grid w-full grid-cols-5 gap-2' : 'flex flex-nowrap gap-1.5 overflow-x-auto pb-2 pr-2 scrollbar-hide'}`}>

                    {tabs.map((t) => (

                        <button

                            key={t.id}

                            onClick={() => setTab(t.id)}

                            title={t.label}

                            aria-label={t.label}

                            className={`ui-pressable shrink-0 inline-flex min-h-[3.1rem] items-center justify-center gap-2 rounded-xl border px-2.5 text-center text-[12.5px] font-black tracking-normal whitespace-nowrap transition-all sm:px-3 sm:text-[13px] xl:w-full xl:px-3.5 xl:text-[13.5px] ${

                                tab === t.id

                                    ? 'border-cyan-400/35 bg-cyan-500 text-white shadow-lg shadow-cyan-500/18'

                                    : 'border-gray-200/60 bg-white/95 text-gray-600 shadow-sm hover:bg-gray-50 dark:border-slate-700 dark:bg-slate-800/95 dark:text-gray-300 dark:hover:bg-slate-700'

                            }`}

                        >

                            <span className="shrink-0 text-[12px] xl:text-[13px]">{t.icon}</span>

                            <span className="leading-none">{t.shortLabel}</span>

                        </button>

                    ))}

                </div>

                <div className={`w-full ${isDesktopAdminLayout ? 'xl:w-[17.75rem] xl:justify-self-end' : ''}`}>

                    <div className={`${card} p-2.5`}>

                        {dateRangeControl}

                    </div>

                </div>

            </div>



            {selectedWorker ? (

                <>

                    <WorkerDetailsView

                        worker={selectedWorker}

                        surveys={surveys}

                        allGps={allGps}

                        allShifts={allShifts}

                        dateFrom={dateFrom}

                        dateTo={dateTo}

                        onBack={() => {

                            setSelectedWorkerId(null)

                        }}

                        onDeleteSurvey={(id, label) => setSurveyToDelete({ id, label })}

                    />

                </>

            ) : (

                <>

                    <AnimatePresence mode="wait">

                        {tab === 'workers' && (

                            <motion.div key="w" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">

                                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">

                                    <div className={`${card} p-5 flex items-center gap-4`}>

                                        <div className="w-14 h-14 bg-violet-600 text-white rounded-2xl flex items-center justify-center text-3xl shadow-lg shadow-violet-600/25 shrink-0">👥</div>

                                        <div>

                                            <p className="text-[10px] font-black uppercase tracking-[0.22em] mb-1">Aktywni w terenie</p>

                                            <p className="text-4xl font-black dark:text-white leading-none">

                                                {active}

                                                <span className="text-lg font-bold text-gray-400"> / {workers.length}</span>

                                            </p>

                                        </div>

                                    </div>



                                    <div className={`${card} p-5`}>

                                        <div className="flex items-center justify-between mb-3">

                                            <p className="text-[10px] font-black uppercase tracking-[0.22em]">Łącznie dziś</p>

                                            <span className="text-3xl font-black dark:text-white">{totalToday}</span>

                                        </div>

                                        <div className="grid grid-cols-2 gap-2 min-[560px]:grid-cols-3 xl:grid-cols-4">

                                            <div className="bg-teal-500/10 border border-teal-500/20 rounded-xl p-2 text-center">

                                                <p className="text-[9px] font-black uppercase tracking-[0.16em] mb-1">Umowa podpisana</p>

                                                <p className="text-xl font-black text-teal-600 dark:text-teal-400 leading-none">{totalTodayCompleted}</p>

                                            </div>

                                            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-2 text-center">

                                                <p className="text-[9px] font-black uppercase tracking-[0.16em] mb-1">Odm. przed</p>

                                                <p className="text-xl font-black text-red-600 dark:text-red-400 leading-none">{totalTodayRefusedBefore}</p>

                                            </div>

                                            <div className="bg-orange-500/10 border border-orange-500/20 rounded-xl p-2 text-center">

                                                <p className="text-[9px] font-black uppercase tracking-[0.16em] mb-1">Odm. po</p>

                                                <p className="text-xl font-black text-orange-600 dark:text-orange-400 leading-none">{totalTodayRefusedAfter}</p>

                                            </div>

                                            <div className="bg-cyan-500/10 border border-cyan-500/20 rounded-xl p-2 text-center">

                                                <p className="text-[9px] font-black uppercase tracking-[0.16em] mb-1">Kontakt ponowny</p>

                                                <p className="text-xl font-black text-cyan-600 dark:text-cyan-400 leading-none">{totalTodayAttempted}</p>

                                            </div>

                                            <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl p-2 text-center">

                                                <p className="text-[9px] font-black uppercase tracking-[0.16em] mb-1">Brak wsp.</p>

                                                <p className="text-xl font-black text-rose-600 dark:text-rose-400 leading-none">{totalTodayNoCooperation}</p>

                                            </div>

                                            <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-2 text-center">

                                                <p className="text-[9px] font-black uppercase tracking-[0.16em] mb-1">Nie było</p>

                                                <p className="text-xl font-black text-blue-600 dark:text-blue-400 leading-none">{totalTodayNotHome}</p>

                                            </div>

                                            <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-xl p-2 text-center">

                                                <p className="text-[9px] font-black uppercase tracking-[0.16em] mb-1">Skuteczność</p>

                                                <p className="text-xl font-black text-indigo-600 dark:text-indigo-400 leading-none">{todayCompletionRate}%</p>

                                            </div>

                                        </div>

                                    </div>

                                </div>



                                <div className={`${card} p-4`}>

                                    <h3 className="text-[10px] font-black uppercase tracking-widest mb-4 ml-1">Lista Pracowników ({workers.length})</h3>

                                    <div className="grid grid-cols-1 gap-3">

                                        {workers.map((w) => {

                                            const activitySummary = getWorkerActivitySummary(w, dateFrom, dateTo)



                                            return (

                                            <div key={w.user.id} className={`${innerCard} rounded-xl px-4 py-3 border-l-4 ${w.activeShift ? 'border-l-green-500' : 'border-l-gray-300 dark:border-l-slate-600'}`}>

                                                <div className="flex flex-col xl:flex-row xl:items-center gap-4">

                                                    {/* LEFT: Name & Timeline Info */}

                                                    <div className="flex-1 flex flex-col xl:flex-row xl:items-center gap-3 min-w-0">

                                                        {/* Name Column - fixed enough to align next items */}

                                                        <div className="flex items-center gap-3 min-w-0 xl:min-w-[170px] xl:max-w-[180px]">

                                                            <div className="w-10 h-10 bg-cyan-100 dark:bg-cyan-900/30 text-cyan-600 dark:text-cyan-500 rounded-full flex items-center justify-center text-xs font-black shrink-0 shadow-sm border border-cyan-500/10">

                                                                {w.user.name.split(' ').map(n => n[0]).join('')}

                                                            </div>

                                                            <p className="text-sm font-black dark:text-white truncate pr-2">{w.user.name}</p>

                                                        </div>



                                                        {/* Timing Group with strict label alignment */}

                                                        <div className="w-full xl:flex-1 xl:min-w-0 space-y-2">

                                                            <div className="flex flex-col md:flex-row items-start md:items-center gap-3 w-full xl:min-w-0">

                                                                <div className="w-full md:w-auto xl:min-w-[132px] shrink-0">

                                                                    <span className={`text-[10px] font-black px-2.5 py-1.5 rounded-xl uppercase tracking-wider block text-center shadow-xs border ${activitySummary.badgeClass}`}>

                                                                        {activitySummary.statusLabel}

                                                                    </span>

                                                                </div>



                                                                <div className="w-full md:w-[196px] xl:w-[188px] xl:min-w-0">

                                                                    {activitySummary.timeLabel && (

                                                                        <div className="bg-slate-50 dark:bg-slate-800/40 px-2.5 py-1.5 rounded-xl border border-slate-200/50 dark:border-slate-700/50 flex w-full items-center gap-2 shadow-sm justify-center overflow-hidden">

                                                                            <span className="text-[11px] opacity-60">{'\u{1F553}'}</span>

                                                                            <span className="text-[10px] font-black text-slate-600 dark:text-slate-300 uppercase tracking-tight whitespace-nowrap truncate">

                                                                                {activitySummary.timeLabel}

                                                                            </span>

                                                                        </div>

                                                                    )}

                                                                </div>

                                                            </div>



                                                            {activitySummary.detailLabel && (

                                                                <div className={`flex max-w-full items-center gap-2 rounded-xl border px-2.5 py-1.5 text-[10px] font-black leading-snug tracking-tight ${activitySummary.detailClass}`}>

                                                                    <span className="shrink-0 rounded-full bg-white/70 px-2 py-1 text-[8px] font-black uppercase tracking-[0.16em] text-current dark:bg-slate-950/20">

                                                                        {activitySummary.detailTag}

                                                                    </span>

                                                                    <span className="wrap-break-word">{activitySummary.detailLabel}</span>

                                                                </div>

                                                            )}

                                                        </div>

                                                    </div>



                                                    {/* RIGHT: Stats Islands & Action */}

                                                    <div className="flex flex-col sm:flex-row xl:flex-nowrap items-stretch sm:items-center gap-3 w-full xl:w-auto xl:justify-end xl:shrink-0 xl:border-l xl:border-gray-100 xl:dark:border-slate-700/50 xl:pl-4">

                                                        <WorkerStatsOverview worker={w} />



                                                        <button 

                                                            onClick={() => setSelectedWorkerId(w.user.id!)} 

                                                            className="w-full sm:w-auto xl:min-w-[102px] bg-cyan-500 hover:bg-cyan-600 text-white text-[10px] font-black px-4 py-2.5 rounded-xl transition-all shadow-md shadow-cyan-500/20 uppercase tracking-tighter shrink-0"

                                                        >

                                                            Szczegóły

                                                        </button>

                                                    </div>

                                                </div>

                                            </div>

                                        )})}

                                    </div>

                                </div>

                            </motion.div>

                        )}



                        {tab === 'surveys' && (

                            <motion.div key="s" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>

                                <div className={`${card} p-4`}>

                                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-4 gap-3">

                                        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Historia spotkań ({surveys.filter(s => s.created_at >= `${dateFrom}T00:00:00` && s.created_at <= `${dateTo}T23:59:59`).filter(s => showOnlySuccessful ? (s.status === 'completed' && s.respondent_name !== 'ODMOWA / PRZERWANO' && s.answers?.pole_status !== 'Odmowa' && s.answers?.pole_status !== 'Odmowa/Przerwanie') : true).length})</h3>

                                        <div className="flex max-sm:flex-col sm:items-center gap-3">

                                            <button onClick={downloadCsv} className="flex items-center gap-2 bg-violet-500/10 dark:bg-violet-500/5 px-3 py-1.5 rounded-xl border border-violet-500/20 hover:bg-violet-500/20 transition-colors text-violet-600 dark:text-violet-400">

                                                <span className="text-[10px] font-black uppercase tracking-wider">Pobierz Spotkania CSV</span>

                                            </button>

                                            <label className="flex items-center gap-2 cursor-pointer bg-teal-500/10 dark:bg-teal-500/5 px-3 py-1.5 rounded-xl border border-teal-500/20 hover:bg-teal-500/20 transition-colors">

                                                <input type="checkbox" className="w-3.5 h-3.5 accent-teal-500 bg-white" checked={showOnlySuccessful} onChange={(e) => setShowOnlySuccessful(e.target.checked)} />

                                                <span className="text-[10px] font-black uppercase text-teal-600 dark:text-teal-500 tracking-wider">Tylko Udane</span>

                                            </label>

                                        </div>

                                    </div>

                                        <div className="space-y-2 max-h-[70vh] overflow-y-auto pr-1">

                                        {surveys.filter(s => s.created_at >= `${dateFrom}T00:00:00` && s.created_at <= `${dateTo}T23:59:59`).filter(s => showOnlySuccessful ? (s.status === 'completed' && s.respondent_name !== 'ODMOWA / PRZERWANO' && s.answers?.pole_status !== 'Odmowa' && s.answers?.pole_status !== 'Odmowa/Przerwanie') : true).map((s) => {

                                            const surveyStatus = getSurveyStatus(s)

                                            const surveyTiming = getSurveyTimingMeta(s)

                                            const surveyStatusCornerLabel =

                                                surveyStatus.key === 'completed'

                                                    ? 'UMOWA PODPISANA'

                                                    : surveyStatus.key === 'attempted'

                                                        ? 'KONTAKT PONOWNY'

                                                        : surveyStatus.key === 'refused'

                                                            ? 'ODMOWA KLIENTA'

                                                            : surveyStatus.key === 'no_cooperation'

                                                                ? 'BRAK WSPOLPRACY'

                                                                : 'NIE BYŁO NIKOGO'

                                            const surveyStatusCornerClass =

                                                surveyStatus.key === 'completed'

                                                    ? 'border-emerald-500/80 bg-emerald-600 text-white dark:border-emerald-400/60 dark:bg-emerald-500'

                                                    : surveyStatus.key === 'attempted'

                                                        ? 'border-cyan-500/80 bg-cyan-600 text-white dark:border-cyan-400/60 dark:bg-cyan-500'

                                                        : surveyStatus.key === 'refused'

                                                            ? 'border-red-500/80 bg-red-600 text-white dark:border-red-400/60 dark:bg-red-500'

                                                            : surveyStatus.key === 'no_cooperation'

                                                                ? 'border-rose-500/80 bg-rose-600 text-white dark:border-rose-400/60 dark:bg-rose-500'

                                                                : 'border-blue-500/80 bg-blue-600 text-white dark:border-blue-400/60 dark:bg-blue-500'

                                            const rawMeetingId = Array.isArray(s.answers?.meeting_id) ? s.answers?.meeting_id[0] : s.answers?.meeting_id

                                            const linkedMeeting = typeof rawMeetingId === 'string'

                                                ? salesMeetings.find((meeting) => String(meeting.id) === rawMeetingId)

                                                : undefined

                                            const rawScheduledAt = Array.isArray(s.answers?.meeting_scheduled_at) ? s.answers?.meeting_scheduled_at[0] : s.answers?.meeting_scheduled_at

                                            const scheduledMeetingDate = typeof rawScheduledAt === 'string' && rawScheduledAt.trim().length > 0

                                                ? new Date(rawScheduledAt)

                                                : linkedMeeting?.scheduled_at

                                                    ? new Date(linkedMeeting.scheduled_at)

                                                    : null

                                            const scheduledMeetingLabel = scheduledMeetingDate && !Number.isNaN(scheduledMeetingDate.getTime())

                                                ? scheduledMeetingDate.toLocaleString('pl-PL', {

                                                    day: '2-digit',

                                                    month: '2-digit',

                                                    year: 'numeric',

                                                    hour: '2-digit',

                                                    minute: '2-digit'

                                                })

                                                : 'Brak'



                                            return (

                                            <div key={s.id}>

                                                <button

                                                    onClick={() => setExpanded(expanded === s.id?.toString() ? null : s.id!.toString())}

                                                    className="relative w-full overflow-hidden rounded-2xl border border-gray-200/80 bg-white pr-4 pl-20 py-4 text-left shadow-sm transition-colors hover:bg-gray-50 focus:outline-none focus-visible:outline-none focus:ring-0 dark:border-slate-600 dark:bg-slate-700/40 dark:hover:bg-slate-600/80"

                                                    style={{ WebkitTapHighlightColor: 'transparent' }}

                                                >

                                                    <div className={`pointer-events-none absolute -bottom-px -left-px -top-px flex w-14 items-center justify-center rounded-l-2xl border-r border-white/15 shadow-sm ${surveyStatusCornerClass}`}>

                                                        <span className="-rotate-90 whitespace-nowrap text-[12px] font-black uppercase tracking-[0.03em]">

                                                            {surveyStatusCornerLabel}

                                                        </span>

                                                    </div>



                                                    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(250px,1fr)] lg:items-center">

                                                        <div className="min-w-0 space-y-3">

                                                            <div className="flex flex-wrap items-center gap-2.5">

                                                                <p className="text-lg font-black text-slate-800 dark:text-white">{s.respondent_name || 'Anonim'}</p>

                                                                <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.14em] shadow-sm ${surveyStatus.chipClass}`}>

                                                                    <span className="text-[11px] leading-none">{surveyStatus.markerChar}</span>

                                                                    {surveyStatus.label}

                                                                </span>

                                                            </div>



                                                            <p className="text-base font-semibold leading-snug text-slate-700 dark:text-slate-200">

                                                                {s.address || 'Brak adresu'}

                                                            </p>



                                                            <div className="flex flex-wrap gap-2">

                                                                {s.respondent_phone && (

                                                                    <span className="rounded-lg border border-emerald-300/70 bg-emerald-50 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-500/10 dark:text-emerald-200">

                                                                        Tel. {s.respondent_phone}

                                                                    </span>

                                                                )}

                                                                {surveyTiming.durationLabel && (

                                                                    <span className="rounded-lg border border-violet-300/60 bg-violet-50 px-2.5 py-1 text-[10px] font-black tracking-wide text-violet-700 dark:border-violet-400/20 dark:bg-violet-500/10 dark:text-violet-200">

                                                                        Czas: {surveyTiming.durationLabel}

                                                                    </span>

                                                                )}

                                                                {s.status === 'attempted' && getAttemptedNote(s) ? (

                                                                    <span className="rounded-lg border border-cyan-300/60 bg-cyan-50 px-2.5 py-1 text-[10px] font-black tracking-wide text-cyan-700 dark:border-cyan-400/20 dark:bg-cyan-500/10 dark:text-cyan-200">

                                                                        Notatka: {getAttemptedNote(s)}

                                                                    </span>

                                                                ) : (

                                                                    s.respondent_preferred_date && s.status !== 'refused' && s.status !== 'not_home' && s.status !== 'no_cooperation' && (

                                                                        <span className="rounded-lg border border-blue-300/60 bg-blue-50 px-2.5 py-1 text-[10px] font-black tracking-wide text-blue-700 dark:border-blue-400/20 dark:bg-blue-500/10 dark:text-blue-200">

                                                                            {s.status === 'completed' ? 'Termin eksperta' : 'Kontakt / powrót'}: {s.respondent_preferred_date} {s.respondent_preferred_time || ''}

                                                                        </span>

                                                                    )

                                                                )}

                                                            </div>

                                                        </div>



                                                        <div className="rounded-2xl border border-slate-200/80 bg-slate-50/70 p-2.5 dark:border-slate-600/60 dark:bg-slate-800/45">

                                                            <div className="grid gap-2 sm:grid-cols-2">

                                                                <div className="rounded-xl border border-cyan-300/60 bg-cyan-50/80 px-3 py-2 dark:border-cyan-400/20 dark:bg-cyan-500/10">

                                                                    <p className="text-[9px] font-black uppercase tracking-[0.22em] text-cyan-600 dark:text-cyan-200">Handlowiec</p>

                                                                    <p className="mt-1 truncate text-sm font-black text-cyan-700 dark:text-white">

                                                                        {s.user_name || 'Nieznany'}

                                                                    </p>

                                                                </div>

                                                                <div className="rounded-xl border border-violet-300/60 bg-violet-50/80 px-3 py-2 dark:border-violet-400/20 dark:bg-violet-500/10">

                                                                    <p className="text-[9px] font-black uppercase tracking-[0.22em] text-violet-600 dark:text-violet-200">Termin spotkania</p>

                                                                    <p className="mt-1 text-sm font-black text-slate-700 dark:text-slate-100">

                                                                        {scheduledMeetingLabel}

                                                                    </p>

                                                                </div>

                                                            </div>



                                                            <div className="mt-2 flex justify-end">

                                                                <span className={`inline-flex items-center rounded-xl border px-3 py-1 text-[10px] font-black uppercase tracking-wider ${

                                                                    expanded === s.id?.toString()

                                                                        ? 'border-cyan-400/25 bg-cyan-500/10 text-cyan-500'

                                                                        : 'border-slate-300/70 bg-white/70 text-slate-500 dark:border-slate-600/60 dark:bg-slate-900/20 dark:text-slate-300'

                                                                }`}>

                                                                    {expanded === s.id?.toString() ? 'Zwiń' : 'Szczegóły'}

                                                                </span>

                                                            </div>

                                                        </div>

                                                    </div>

                                                </button>

                                                <AnimatePresence>

                                                    {expanded === s.id?.toString() && (

                                                        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">

                                                            <div className="bg-slate-100 dark:bg-slate-900/60 border-x border-b border-gray-100 dark:border-slate-500 rounded-b-lg px-4 py-4 space-y-4 shadow-inner mx-1 mt-[-4px]">

                                                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pb-4 border-b border-gray-200 dark:border-slate-700">

                                                                    <div><p className="text-gray-400 text-[10px] uppercase tracking-wider">Pracownik</p><p className="text-xs font-medium text-cyan-500">{s.user_name || 'Nieznany'}</p></div>

                                                                    <div><p className="text-gray-400 text-[10px] uppercase tracking-wider">Adres</p><p className="text-xs font-medium">{s.address}</p></div>

                                                                    <div><p className="text-gray-400 text-[10px] uppercase tracking-wider">Respondent</p><p className="text-xs font-medium">{s.respondent_name || 'Brak'} • {s.respondent_phone || 'Brak tel.'}</p></div>

                                                                </div>

                                                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pb-4 border-b border-gray-200 dark:border-slate-700">

                                                                    <div><p className="text-gray-400 text-[10px] uppercase tracking-wider">Start wniosku</p><p className="text-xs font-medium">{formatSurveyDateTime(surveyTiming.startedAt)}</p></div>

                                                                    <div><p className="text-gray-400 text-[10px] uppercase tracking-wider">Koniec wniosku</p><p className="text-xs font-medium">{formatSurveyDateTime(surveyTiming.finishedAt)}</p></div>

                                                                    <div><p className="text-gray-400 text-[10px] uppercase tracking-wider">Czas spotkania</p><p className="text-xs font-medium">{surveyTiming.durationLabel || 'Brak'}</p></div>

                                                                </div>

                                                                {s.status === 'attempted' && getAttemptedNote(s) ? (

                                                                    <div>

                                                                        <p className="text-gray-400 text-[10px] uppercase tracking-wider">Notatka kontaktu</p>

                                                                        <p className="text-xs font-bold">{getAttemptedNote(s)}</p>

                                                                    </div>

                                                                ) : (

                                                                    s.respondent_preferred_date && s.status !== 'refused' && s.status !== 'not_home' && s.status !== 'no_cooperation' && (

                                                                        <div>

                                                                            <p className="text-gray-400 text-[10px] uppercase tracking-wider">

                                                                                {s.status === 'completed' ? 'Termin wizyty eksperta' : 'Planowany powrót / kontakt'}

                                                                            </p>

                                                                            <p className="text-xs font-bold">{s.respondent_preferred_date} {s.respondent_preferred_time || ''}</p>

                                                                        </div>

                                                                    )

                                                                )}

                                                                {s.audio_url && (

                                                                    <div className="space-y-3">

                                                                        <div className="flex items-center justify-between mb-2">

                                                                            <p className="text-gray-400 text-[10px] uppercase tracking-wider">Nagranie audio</p>

                                                                            <button

                                                                                type="button"

                                                                                onClick={() => {

                                                                                    const fileBaseName = `${s.user_name || 'pracownik'}_${new Date(s.created_at).toLocaleDateString('pl-PL').replace(/\./g, '-')}_nagranie`

                                                                                    void downloadSurveyAudioAsMp3(s, fileBaseName).catch((error) => {

                                                                                        console.error('Audio download failed:', error)

                                                                                        alert('Nie udało się pobrać nagrania w formacie MP3.')

                                                                                    })

                                                                                }}

                                                                                className="text-[10px] text-blue-500 hover:underline flex items-center gap-1 font-bold"

                                                                            >

                                                                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg> Pobierz

                                                                            </button>

                                                                        </div>

                                                                        <AudioPlayer url={s.audio_url} />

                                                                        <div>

                                                                            <div className="flex items-center justify-between mb-1">

                                                                                <p className="text-gray-400 text-[10px] uppercase tracking-wider">Transkrypcja</p>

                                                                                <button

                                                                                    type="button"

                                                                                    onClick={() => downloadText(getTranscriptFilename(s.id), buildTranscriptText(s))}

                                                                                    className="text-[10px] text-blue-500 hover:underline flex items-center gap-1 font-bold"

                                                                                >

                                                                                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg> TXT

                                                                                </button>

                                                                            </div>

                                                                            <p className="text-xs max-h-16 overflow-auto whitespace-pre-wrap bg-white dark:bg-slate-800 p-2 rounded border border-gray-200 dark:border-slate-700">

                                                                                {s.audio_transcript?.trim() || 'Brak automatycznej transkrypcji dla tego nagrania.'}

                                                                            </p>

                                                                        </div>

                                                                    </div>

                                                                )}

                                                                {s.latitude && s.longitude && <div><p className="text-gray-400 text-[10px] uppercase tracking-wider">GPS</p><p className="text-xs font-mono">{s.latitude.toFixed(5)}, {s.longitude.toFixed(5)}</p></div>}

                                                                <div>

                                                                    <p className="text-gray-400 text-[10px] uppercase tracking-wider mb-1">Dane umowy</p>

                                                                    {(() => {

                                                                        return QS.map((q) => (

                                                                            <div key={q.id} className="flex items-start justify-between py-1 border-b border-gray-200 dark:border-slate-700/60 last:border-0 gap-2 hover:bg-gray-200 dark:hover:bg-slate-800/40 px-2 rounded-lg transition-colors">

                                                                                <span className="text-gray-600 dark:text-gray-400 text-[11px] flex-1 pr-2">{q.num}. {q.text}</span>

                                                                                <span className={`text-[11px] text-right shrink-0 max-w-[50%] ${getSurveyAnswerDisplayValue(s, q.id) ? 'font-semibold' : 'italic text-gray-400 dark:text-slate-500'}`}>

                                                                                    {getSurveyAnswerDisplayValue(s, q.id) || 'Brak odpowiedzi'}

                                                                                </span>

                                                                            </div>

                                                                        ))

                                                                    })()}

                                                                </div>

                                                                <div className="flex justify-end mt-4 pt-4 border-t border-red-100 dark:border-red-900/30">

                                                                    <button

                                                                        onClick={() => setSurveyToDelete({ id: s.id!, label: s.respondent_name || s.address || 'ten wpis' })}

                                                                        className="text-[10px] font-black uppercase bg-red-50 text-red-600 hover:bg-red-600 hover:text-white dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20 px-4 py-2 rounded-lg transition-colors border border-red-100 dark:border-red-500/20"

                                                                    >

                                                                        Usuń wpis

                                                                    </button>

                                                                </div>

                                                            </div>

                                                        </motion.div>

                                                    )}

                                                </AnimatePresence>

                                            </div>

                                        )})}

                                        {surveys.filter(s => s.created_at >= `${dateFrom}T00:00:00` && s.created_at <= `${dateTo}T23:59:59`).filter(s => showOnlySuccessful ? (s.status === 'completed' && s.respondent_name !== 'ODMOWA / PRZERWANO' && s.answers?.pole_status !== 'Odmowa' && s.answers?.pole_status !== 'Odmowa/Przerwanie') : true).length === 0 && <p className="text-gray-300 text-sm text-center py-6">Brak spotkań z wybranego okresu</p>}

                                    </div>

                                </div>

                            </motion.div>

                        )}



                        {tab === 'parcels' && (

                            <motion.div key="parcels" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>

                                <PoleAssignmentsPanel />

                            </motion.div>

                        )}



                        {tab === 'imports' && (

                            <motion.div key="imports" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>

                                <MeetingImportsPanel selectedDate={dateTo} />

                            </motion.div>

                        )}



                        {tab === 'map' && (

                            <motion.div key="m" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>

                                <GlobalMapView 

                                    workers={workers}

                                    surveys={surveys.filter(s => s.created_at >= `${dateFrom}T00:00:00` && s.created_at <= `${dateTo}T23:59:59`)}

                                    salesMeetings={salesMeetings}

                                    allGps={allGps}

                                    dateFrom={dateFrom}

                                    dateTo={dateTo}

                                />

                            </motion.div>

                        )}



                        {tab === 'team' && (

                            <motion.div

                                key="team-responsive"

                                initial={{ opacity: 0 }}

                                animate={{ opacity: 1 }}

                                exit={{ opacity: 0 }}

                                className={`grid gap-4 ${isDesktopAdminLayout ? 'xl:grid-cols-[320px_minmax(0,1fr)] xl:items-start' : ''}`}

                            >

                                <div className="space-y-4 xl:sticky xl:top-6">

                                    <div className={`${card} p-4 space-y-4`}>

                                        <div>

                                            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-400">Zespol</p>

                                            <h3 className="mt-2 text-lg font-black text-slate-800 dark:text-white">Zarzadzanie kontami</h3>

                                            <p className="mt-1 text-sm font-semibold leading-relaxed text-slate-500 dark:text-slate-300">

                                                Na desktopie lista uklada sie szerzej, a na telefonie zostaje w pionie bez utraty czytelnosci.

                                            </p>

                                        </div>

                                        <div className="grid grid-cols-2 gap-2">

                                            <div className="rounded-2xl border border-cyan-300/70 bg-cyan-50/80 px-3 py-3 text-cyan-700 dark:border-cyan-400/20 dark:bg-cyan-500/10 dark:text-cyan-200">

                                                <p className="text-[10px] font-black uppercase tracking-[0.2em] opacity-75">Handlowcy</p>

                                                <p className="mt-2 text-2xl font-black leading-none">{teamWorkerCount}</p>

                                            </div>

                                            <div className="rounded-2xl border border-violet-300/70 bg-violet-50/80 px-3 py-3 text-violet-700 dark:border-violet-400/20 dark:bg-violet-500/10 dark:text-violet-200">

                                                <p className="text-[10px] font-black uppercase tracking-[0.2em] opacity-75">Admini</p>

                                                <p className="mt-2 text-2xl font-black leading-none">{teamAdminCount}</p>

                                            </div>

                                            <div className="rounded-2xl border border-emerald-300/70 bg-emerald-50/80 px-3 py-3 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-500/10 dark:text-emerald-200">

                                                <p className="text-[10px] font-black uppercase tracking-[0.2em] opacity-75">Aktywni</p>

                                                <p className="mt-2 text-2xl font-black leading-none">{active}</p>

                                            </div>

                                            <div className="rounded-2xl border border-amber-300/70 bg-amber-50/80 px-3 py-3 text-amber-700 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-200">

                                                <p className="text-[10px] font-black uppercase tracking-[0.2em] opacity-75">Raporty</p>

                                                <p className="mt-2 text-2xl font-black leading-none">{totalToday}</p>

                                            </div>

                                        </div>

                                        <button onClick={() => setShowAddForm(true)} className={`${adminPrimaryButtonClass} w-full py-3 text-xs shadow-xl`}>+ Dodaj nowego pracownika</button>

                                    </div>

                                </div>



                                <div className={`${card} p-4`}>

                                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">

                                        <h3 className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Zarzadzanie kontami ({workers.length})</h3>

                                        <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300">

                                            Responsywny widok admina

                                        </span>

                                    </div>

                                    <div className="grid max-h-[72vh] gap-3 overflow-y-auto pr-1 xl:grid-cols-2 2xl:grid-cols-3">

                                        {workers.map((w) => (

                                            <div key={w.user.id} className={`${innerCard} h-full px-4 py-3`}>

                                                <div className="flex h-full flex-col gap-3">

                                                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">

                                                        <div className="flex items-center gap-3 min-w-0">

                                                            <div className="w-10 h-10 bg-cyan-100 dark:bg-cyan-900/30 text-cyan-600 dark:text-cyan-500 rounded-full flex items-center justify-center text-xs font-black shrink-0">

                                                                {w.user.name.split(' ').map((n) => n[0]).join('')}

                                                            </div>

                                                            <div className="min-w-0">

                                                                <p className="text-sm font-bold truncate dark:text-white">{w.user.name}</p>

                                                                <p className="mt-1 text-[10px] font-black uppercase tracking-[0.18em] text-slate-400 dark:text-slate-500">

                                                                    {w.activeShift ? 'Aktywny teraz' : 'Profil offline'}

                                                                </p>

                                                            </div>

                                                        </div>

                                                        <div className="flex gap-2 sm:shrink-0">

                                                            <button onClick={() => {

                                                                setEditingWorker(w.user)

                                                                setEditData({ name: w.user.name, login: w.user.login, password: w.user.password, role: w.user.role as 'worker' | 'admin' })

                                                            }} className={`${adminInfoButtonClass} min-w-[92px] px-3 py-2 text-[10px]`}>Edytuj</button>

                                                            <button onClick={() => setConfirmDelete({ id: w.user.id!, name: w.user.name })} className={`${adminDangerButtonClass} min-w-[92px] px-3 py-2 text-[10px]`}>Usun</button>

                                                        </div>

                                                    </div>



                                                    <div className="flex flex-wrap items-center gap-1.5">

                                                        <span className="inline-flex items-center rounded-full border border-slate-200/80 bg-slate-100/90 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.18em] text-slate-500 dark:border-slate-600/70 dark:bg-slate-800/80 dark:text-slate-300">

                                                            Login: {w.user.login}

                                                        </span>

                                                        <span className="inline-flex items-center rounded-full border border-slate-200/70 bg-slate-50/70 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.15em] text-slate-400 dark:border-slate-700/80 dark:bg-slate-900/40 dark:text-slate-500">

                                                            Haslo: <span className="ml-1 font-mono text-slate-500 dark:text-slate-400">{w.user.password}</span>

                                                        </span>

                                                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.18em] ${

                                                            w.user.role === 'admin'

                                                                ? 'border-violet-300/70 bg-violet-100 text-violet-600 dark:border-violet-500/30 dark:bg-violet-500/15 dark:text-violet-300'

                                                                : 'border-cyan-300/70 bg-cyan-100 text-cyan-700 dark:border-cyan-500/30 dark:bg-cyan-500/15 dark:text-cyan-300'

                                                        }`}>

                                                            {w.user.role === 'admin' ? 'Administrator' : 'Handlowiec'}

                                                        </span>

                                                    </div>



                                                    <div className="grid grid-cols-3 gap-2 border-t border-gray-100 pt-3 dark:border-slate-500">

                                                        <div className="rounded-xl bg-slate-50 px-3 py-2 text-center dark:bg-slate-800/70">

                                                            <p className="text-[9px] font-black uppercase tracking-[0.16em] text-slate-400">Dzis</p>

                                                            <p className="mt-1 text-lg font-black text-cyan-500">{w.todaySurveys}</p>

                                                        </div>

                                                        <div className="rounded-xl bg-slate-50 px-3 py-2 text-center dark:bg-slate-800/70">

                                                            <p className="text-[9px] font-black uppercase tracking-[0.16em] text-slate-400">Lacznie</p>

                                                            <p className="mt-1 text-lg font-black text-slate-700 dark:text-slate-100">{w.totalSurveys}</p>

                                                        </div>

                                                        <div className="rounded-xl bg-slate-50 px-3 py-2 text-center dark:bg-slate-800/70">

                                                            <p className="text-[9px] font-black uppercase tracking-[0.16em] text-slate-400">Status</p>

                                                            <p className={`mt-1 text-[11px] font-black uppercase tracking-[0.16em] ${w.activeShift ? 'text-emerald-500' : 'text-slate-400'}`}>

                                                                {w.activeShift ? 'Online' : 'Offline'}

                                                            </p>

                                                        </div>

                                                    </div>

                                                </div>

                                            </div>

                                        ))}

                                    </div>

                                </div>

                            </motion.div>

                        )}



                    </AnimatePresence>

                </>

            )}



            {/* Modals and Toasts */}

            <AnimatePresence>

                {confirmDelete && (

                    <div className="fixed inset-0 z-100 flex items-center justify-center p-4">

                        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setConfirmDelete(null)} className="ui-modal-backdrop absolute inset-0 bg-slate-900/60 backdrop-blur-sm" />

                        <motion.div initial={{ scale: 0.9, opacity: 0, y: 20 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.9, opacity: 0, y: 20 }} className="ui-modal-panel relative bg-white dark:bg-slate-800 rounded-3xl p-6 shadow-2xl border border-gray-100 dark:border-slate-700 w-full max-w-sm overflow-hidden text-center">

                            <div className="w-16 h-16 bg-red-500/10 text-red-500 rounded-full flex items-center justify-center text-3xl mb-4 mx-auto">{'\u26A0'}</div>

                            <h3 className="text-lg font-black dark:text-white mb-2 leading-tight">Potwierdź usunięcie</h3>

                            <p className="text-xs text-gray-500 dark:text-gray-400 mb-6 uppercase tracking-wider font-bold">Czy na pewno usunąć pracownika <span className="text-red-500">{confirmDelete.name}</span>? Dane wpisów nie zostaną usunięte.</p>

                            <div className="flex gap-3">

                                <button onClick={() => setConfirmDelete(null)} className={`${adminSecondaryButtonClass} flex-1 py-3 text-xs`}>Anuluj</button>

                                <button onClick={() => deleteWorker(confirmDelete.id)} className={`${adminDangerButtonClass} flex-1 py-3 text-xs`}>Tak, usuń</button>

                            </div>

                        </motion.div>

                    </div>

                )}



                {showAddForm && (

                    <div className="fixed inset-0 z-100 flex items-center justify-center p-4">

                        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={closeAddForm} className="ui-modal-backdrop absolute inset-0 bg-slate-900/60 backdrop-blur-sm" />

                        <motion.div initial={{ scale: 0.9, opacity: 0, y: 20 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.9, opacity: 0, y: 20 }} className="ui-modal-panel relative bg-white dark:bg-slate-800 rounded-3xl p-6 shadow-2xl border border-gray-100 dark:border-slate-700 w-full max-w-md overflow-hidden">

                            <div className="flex items-center justify-between mb-6">

                                <h3 className="text-lg font-black dark:text-white uppercase tracking-widest">Nowy profil pracownika</h3>

                                <div className="w-10 h-10 bg-cyan-500/10 text-cyan-500 rounded-xl flex items-center justify-center text-xl font-black">+</div>

                            </div>



                            <div className="space-y-4 mb-8">

                                <div>

                                    <label className="text-[10px] font-black text-gray-400 uppercase mb-1.5 block ml-1">Imię i nazwisko</label>

                                    <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Jan Kowalski" className="w-full border border-gray-200 dark:border-slate-600 bg-gray-50 dark:bg-slate-700/50 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-cyan-500 outline-none transition-all dark:text-white" />

                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">

                                    <div>

                                        <label className="text-[10px] font-black text-gray-400 uppercase mb-1.5 block ml-1">Login</label>

                                        <input type="text" value={newLogin} onChange={(e) => setNewLogin(e.target.value)} placeholder="jan123" className="w-full border border-gray-200 dark:border-slate-600 bg-gray-50 dark:bg-slate-700/50 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-cyan-500 outline-none transition-all dark:text-white" />

                                    </div>

                                    <div>

                                        <label className="text-[10px] font-black text-gray-400 uppercase mb-1.5 block ml-1">Hasło</label>

                                        <input type="text" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="haslo123" className="w-full border border-gray-200 dark:border-slate-600 bg-gray-50 dark:bg-slate-700/50 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-cyan-500 outline-none transition-all dark:text-white" />

                                    </div>

                                </div>

                            </div>



                            <div className="flex gap-3">

                                <button onClick={closeAddForm} className={`${adminSecondaryButtonClass} flex-1 py-4 text-[10px] tracking-[0.2em]`}>Anuluj</button>

                                <button onClick={addWorker} disabled={!newName.trim() || !newLogin.trim() || !newPassword.trim()} className={`${adminSuccessButtonClass} flex-1 py-4 text-[10px] tracking-[0.2em] disabled:opacity-30`}>Utwórz konto</button>

                            </div>

                        </motion.div>

                    </div>

                )}



                {editingWorker && (

                    <div className="fixed inset-0 z-100 flex items-center justify-center p-4">

                        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setEditingWorker(null)} className="ui-modal-backdrop absolute inset-0 bg-slate-900/60 backdrop-blur-sm" />

                        <motion.div initial={{ scale: 0.9, opacity: 0, y: 20 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.9, opacity: 0, y: 20 }} className="ui-modal-panel relative bg-white dark:bg-slate-800 rounded-3xl p-6 shadow-2xl border border-gray-100 dark:border-slate-700 w-full max-w-md overflow-hidden">

                            <div className="flex items-center justify-between mb-6">

                                <h3 className="text-lg font-black dark:text-white uppercase tracking-widest">Edycja profilu</h3>

                                <div className="w-10 h-10 bg-blue-500/10 text-blue-500 rounded-xl flex items-center justify-center text-xl font-black">{'\u270E'}</div>

                            </div>

                            

                            <div className="space-y-4 mb-8">

                                <div>

                                    <label className="text-[10px] font-black text-gray-400 uppercase mb-1.5 block ml-1">Imię i nazwisko</label>

                                    <input type="text" value={editData.name} onChange={(e) => setEditData({...editData, name: e.target.value})} className="w-full border border-gray-200 dark:border-slate-600 bg-gray-50 dark:bg-slate-700/50 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white" />

                                </div>

                                <div className="grid grid-cols-2 gap-3">

                                    <div>

                                        <label className="text-[10px] font-black text-gray-400 uppercase mb-1.5 block ml-1">Login</label>

                                        <input type="text" value={editData.login} onChange={(e) => setEditData({...editData, login: e.target.value})} className="w-full border border-gray-200 dark:border-slate-600 bg-gray-50 dark:bg-slate-700/50 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white" />

                                    </div>

                                    <div>

                                        <label className="text-[10px] font-black text-gray-400 uppercase mb-1.5 block ml-1">Hasło</label>

                                        <input type="text" value={editData.password} onChange={(e) => setEditData({...editData, password: e.target.value})} className="w-full border border-gray-200 dark:border-slate-600 bg-gray-50 dark:bg-slate-700/50 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white" />

                                    </div>

                                </div>

                                <div>

                                    <label className="text-[10px] font-black text-gray-400 uppercase mb-1.5 block ml-1">Rola systemowa</label>

                                    <div className="flex gap-2">

                                        {(['worker', 'admin'] as const).map(r => (

                                            <button key={r} onClick={() => setEditData({...editData, role: r})} className={`ui-pressable flex-1 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all ${editData.role === r ? 'bg-blue-500 border-blue-500 text-white shadow-lg shadow-blue-500/20' : 'bg-white dark:bg-slate-700 border-gray-200 dark:border-slate-600 text-gray-500 dark:text-slate-300'}`}>

                                                {r}

                                            </button>

                                        ))}

                                    </div>

                                </div>

                            </div>



                            <div className="flex gap-3">

                                <button onClick={() => setEditingWorker(null)} className={`${adminSecondaryButtonClass} flex-1 py-4 text-[10px] tracking-[0.2em]`}>Anuluj</button>

                                <button onClick={saveEdit} className={`${adminInfoButtonClass} flex-1 py-4 text-[10px] tracking-[0.2em]`}>Zapisz zmiany</button>

                            </div>

                        </motion.div>

                    </div>

                )}



                {surveyToDelete && (

                    <div className="fixed inset-0 z-100 flex items-center justify-center p-4">

                        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSurveyToDelete(null)} className="ui-modal-backdrop absolute inset-0 bg-slate-900/60 backdrop-blur-sm" />

                        <motion.div initial={{ scale: 0.9, opacity: 0, y: 20 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.9, opacity: 0, y: 20 }} className="ui-modal-panel relative bg-white dark:bg-slate-800 rounded-3xl p-6 shadow-2xl border border-gray-100 dark:border-slate-700 w-full max-w-sm overflow-hidden text-center">

                            <div className="w-16 h-16 bg-red-500/10 text-red-500 rounded-full flex items-center justify-center text-3xl mb-4 mx-auto">{'\u{1F5D1}'}</div>

                            <h3 className="text-lg font-black dark:text-white mb-2 leading-tight">Usuń wpis</h3>

                            <p className="text-xs text-gray-500 dark:text-gray-400 mb-6 uppercase tracking-wider font-bold">Czy na pewno chcesz bezpowrotnie usunąć ten wpis: <span className="text-red-500">{surveyToDelete.label}</span>?</p>

                            <div className="flex gap-3">

                                <button onClick={() => setSurveyToDelete(null)} className={`${adminSecondaryButtonClass} flex-1 py-3 text-xs`}>Anuluj</button>

                                <button onClick={() => deleteSurvey(surveyToDelete.id)} className={`${adminDangerButtonClass} flex-1 py-3 text-xs`}>Tak, usuń</button>

                            </div>

                        </motion.div>

                    </div>

                )}



                {toast && (

                    <motion.div initial={{ y: 50, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 50, opacity: 0 }} className={`fixed bottom-8 left-1/2 z-200 flex -translate-x-1/2 items-center gap-3 rounded-2xl border px-6 py-3 shadow-2xl backdrop-blur-md ${toast.type === 'error' ? 'border-red-200 bg-red-50/95 text-red-700 dark:border-red-400 dark:bg-red-500/90 dark:text-white' : 'border-slate-200 bg-white/95 text-slate-800 dark:border-slate-700 dark:bg-slate-900/90 dark:text-white'}`}>

                        <span className={`text-lg ${toast.type === 'error' ? 'text-red-500 dark:text-white' : 'text-emerald-500 dark:text-emerald-300'}`}>{toast.type === 'error' ? '\u26A0' : '\u2713'}</span>

                        <span className="text-xs font-black uppercase tracking-widest">{toast.msg}</span>

                    </motion.div>

                )}

            </AnimatePresence>

        </div>

    )

}



function GlobalMapView({ workers, surveys, salesMeetings, allGps, dateFrom, dateTo }: { workers: WS[], surveys: Survey[], salesMeetings: SalesMeeting[], allGps: GpsLog[], dateFrom: string, dateTo: string }) {

    return (

        <AdvancedGlobalMapView 

            workers={workers}

            surveys={surveys}

            salesMeetings={salesMeetings}

            allGps={allGps}

            dateFrom={dateFrom}

            dateTo={dateTo}

        />

    )

}



function AdvancedGlobalMapView({ workers, surveys, salesMeetings, allGps, dateFrom, dateTo }: { workers: WS[], surveys: Survey[], salesMeetings: SalesMeeting[], allGps: GpsLog[], dateFrom: string, dateTo: string }) {

    const mapRef = useRef<HTMLDivElement>(null)

    const mapShellRef = useRef<HTMLDivElement>(null)

    const mapInst = useRef<L.Map | null>(null)

    const tileLayerRef = useRef<L.TileLayer | null>(null)

    const markersRef = useRef<L.LayerGroup | null>(null)

    const parcelLayerRef = useRef<L.Layer | null>(null)

    const selectedScopeLayerRef = useRef<L.Layer | null>(null)

    const polesRef = useRef<L.LayerGroup | null>(null)

    const linesRef = useRef<L.LayerGroup | null>(null)

    const hasCenteredRef = useRef(false)

    const lastReflowAtRef = useRef(0)

    const powerOverlayRenderTimerRef = useRef<number | null>(null)

    const meetingLocationsRef = useRef<Record<string, GeocodedMeetingAddress | null>>({})

    const visiblePoleAnchorsRef = useRef<Array<{ lat: number; lng: number; parcelId?: string | null; hasExactAddress?: boolean }>>([])

    const localPolesCacheRef = useRef<Map<string, Promise<PowerPole[]>>>(new Map())

    const mapViewportBoundsRef = useRef<BoundsLike | null>(null)

    const lastPoleAssignmentSyncKeyRef = useRef('')

    const lastAutoScopeSelectionKeyRef = useRef('')

    const powerOverlaySettingsRef = useRef<{

        localityCodes: string[] | null

        countyLabels: string[] | null

        precinctLabels: string[] | null

        selectedParcelIds: string[] | null

        boundaryPolygons: BoundaryPolygon[] | null

        scopeBounds: BoundsLike | null

        showPowerPoles: boolean

        showPowerLines: boolean

        addressFilter: AddressPresenceFilter

        scopeReady: boolean

    }>({

        localityCodes: null,

        countyLabels: null,

        precinctLabels: null,

        selectedParcelIds: null,

        boundaryPolygons: null,

        scopeBounds: null,

        showPowerPoles: true,

        showPowerLines: true,

        addressFilter: 'all',

        scopeReady: false

    })



    const [isFullscreen, setIsFullscreen] = useState(false)

    const [visibleWorkers, setVisibleWorkers] = useState<Set<number>>(new Set(workers.map((worker) => worker.user.id!)))

    const [meetingLocations, setMeetingLocations] = useState<Record<string, GeocodedMeetingAddress | null>>({})

    const [localities, setLocalities] = useState<MapLocalitySummary[]>([])

    const [countyScopeBoundaries, setCountyScopeBoundaries] = useState<Record<string, MapScopeBoundary>>({})
    const [municipalityScopeBoundaries, setMunicipalityScopeBoundaries] = useState<Record<string, MunicipalityScopeBoundary>>({})

    const [offlineScopeIndex, setOfflineScopeIndex] = useState<OfflineScopeIndex | null>(null)

    const [parcelTileIndex, setParcelTileIndex] = useState<ParcelTileIndex | null>(null)
    const [parcelSearchResults, setParcelSearchResults] = useState<ParcelSearchResult[]>([])
    const [selectedParcelSearchResult, setSelectedParcelSearchResult] = useState<ParcelSearchResult | null>(null)

    const offlineLocalityStatsByCode = useMemo(() => {
        const lookup = new Map<string, OfflineScopeStats>()
        Object.values(offlineScopeIndex?.localities || {}).forEach((scope) => {
            ;(scope.localityCodes || []).forEach((code) => {
                if (code && !lookup.has(code)) lookup.set(code, scope)
            })
        })
        return lookup
    }, [offlineScopeIndex])

    const offlineLocalityStatsByName = useMemo(() => {
        const lookup = new Map<string, OfflineScopeStats>()
        Object.values(offlineScopeIndex?.localities || {}).forEach((scope) => {
            buildOfflineScopeNameKeys(scope.label, scope.precincts).forEach((key) => {
                if (key && !lookup.has(key)) lookup.set(key, scope)
            })
        })
        return lookup
    }, [offlineScopeIndex])

    const resolveLocalityOfflineStats = useCallback((locality: MapLocalitySummary) => (
        offlineScopeIndex?.localities?.[locality.code] ||
        locality.localityCodes.map((code) => offlineLocalityStatsByCode.get(code)).find(Boolean) ||
        buildOfflineScopeNameKeys(locality.label, locality.precincts)
            .map((key) => offlineLocalityStatsByName.get(key))
            .find(Boolean) ||
        locality.offlineStats
    ), [offlineLocalityStatsByCode, offlineLocalityStatsByName, offlineScopeIndex])

    const [localitySearch, setLocalitySearch] = useState('')

    const [localityTypeFilter, setLocalityTypeFilter] = useState<'all' | 'county' | 'municipality' | 'locality' | 'parcel' | 'selected'>('all')

    const [selectedLocalityCodes, setSelectedLocalityCodes] = useState<string[]>([])

    const [showWorkerRoutes, setShowWorkerRoutes] = useState(true)

    const [showWorkerMarkers, setShowWorkerMarkers] = useState(true)

    const [showSurveyMarkers, setShowSurveyMarkers] = useState(true)

    const [showMeetingMarkers, setShowMeetingMarkers] = useState(true)

    const [showParcelOverlay, setShowParcelOverlay] = useState(true)

    const [showPowerPoles, setShowPowerPoles] = useState(true)

    const [showPowerLines, setShowPowerLines] = useState(true)

    const [addressPresenceFilter, setAddressPresenceFilter] = useState<AddressPresenceFilter>('all')

    const [, setVisiblePoleCount] = useState(0)

    const [, setVisiblePoleAnchorKey] = useState('')

    const [mapViewportVersion, setMapViewportVersion] = useState(0)

    const [mapScopeApplied, setMapScopeApplied] = useState(false)

    const [mapScopeDialogOpen, setMapScopeDialogOpen] = useState(false)

    const [mapScopeLoadVersion, setMapScopeLoadVersion] = useState(0)

    const [exportingCsv, setExportingCsv] = useState(false)

    const [mapControlsOpen, setMapControlsOpen] = useState(false)



    const forceMapReflow = useCallback((options?: { burst?: boolean }) => {

        const map = mapInst.current

        if (!map) return



        const now = Date.now()

        if (!options?.burst && now - lastReflowAtRef.current < 450) return

        lastReflowAtRef.current = now



        const resizeOnly = () => {
            map.invalidateSize({ pan: false, debounceMoveend: true })
        }

        window.requestAnimationFrame(resizeOnly)

        if (options?.burst) {
            window.setTimeout(resizeOnly, 180)
        }

    }, [])



    const renderCurrentPowerOverlay = useCallback(() => {

        const map = mapInst.current

        if (!map) return



        const settings = powerOverlaySettingsRef.current

        void renderPowerInfrastructure({

            map,

            polesLayer: polesRef.current,

            linesLayer: linesRef.current,

            enabled: settings.scopeReady && (settings.showPowerLines || settings.showPowerPoles),

            linesEnabled: settings.showPowerLines && !settings.selectedParcelIds?.length,

            polesEnabled: settings.showPowerPoles,

            localityCodes: settings.localityCodes,

            countyLabels: settings.countyLabels,

            precinctLabels: settings.precinctLabels,

            selectedParcelIds: settings.selectedParcelIds,

            boundaryPolygons: settings.boundaryPolygons,

            scopeBounds: settings.scopeBounds,

            allowedVoltages: ['sn', 'wn'],

            excludePoleTypes: ['station'],

            maxArea: 0.5,

            minLineZoom: 9,

            minPoleZoom: 9,

            bulkResolvePoleParcelsMinZoom: 13,

            assignedPolesOnly: false,

            addressFilter: settings.addressFilter,

            buildPolePopupContent: (pole) => buildPowerPoleDetailsHtml(pole),

            onPoleCountChange: setVisiblePoleCount,

            onVisiblePolesChange: (poles) => {

                const nextAnchors = poles.map((pole) => ({

                    lat: pole.lat,

                    lng: pole.lng,

                    parcelId: pole.parcelId || null,

                    hasExactAddress: Boolean(getPowerPoleDisplayAddress(pole))

                }))

                visiblePoleAnchorsRef.current = nextAnchors

                setVisiblePoleAnchorKey(

                    nextAnchors

                        .map((anchor) => `${anchor.parcelId || ''}|${anchor.lat.toFixed(6)}|${anchor.lng.toFixed(6)}|${anchor.hasExactAddress ? 'exact' : 'missing'}`)

                        .sort()

                        .join(',')

                )

            }

        })

    }, [])



    const queuePowerOverlayRender = useCallback((delay = 110) => {

        if (powerOverlayRenderTimerRef.current !== null) {

            window.clearTimeout(powerOverlayRenderTimerRef.current)

        }



        powerOverlayRenderTimerRef.current = window.setTimeout(() => {

            powerOverlayRenderTimerRef.current = null

            renderCurrentPowerOverlay()

        }, delay)

    }, [renderCurrentPowerOverlay])

    const getPaddedViewportBounds = useCallback((): BoundsLike | null => {
        const bounds = mapViewportBoundsRef.current
        if (!bounds) return null

        return {
            south: bounds.south - 0.01,
            west: bounds.west - 0.01,
            north: bounds.north + 0.01,
            east: bounds.east + 0.01
        }
    }, [])

    const getCachedLocalPoles = useCallback((bounds?: BoundsLike | null) => {
        const key = bounds
            ? `${bounds.south.toFixed(4)}|${bounds.west.toFixed(4)}|${bounds.north.toFixed(4)}|${bounds.east.toFixed(4)}`
            : 'all'

        const cached = localPolesCacheRef.current.get(key)
        if (cached) return cached

        const nextPromise = fetchAllLocalPoles(bounds || undefined)
            .then((poles) => poles.filter((pole) => pole.type !== 'station'))
            .catch((error) => {
                localPolesCacheRef.current.delete(key)
                throw error
            })

        localPolesCacheRef.current.set(key, nextPromise)
        return nextPromise
    }, [])



    const rangeFrom = `${dateFrom}T00:00:00`

    const rangeTo = `${dateTo}T23:59:59`

    const derivedMunicipalityScopes = useMemo<MapMunicipalitySummary[]>(
        () =>
            Array.from(
                localities.reduce((grouped, locality) => {
                    ;(locality.municipalities || []).forEach((municipalityLabel) => {
                        const cleanMunicipalityLabel = cleanDisplayText(municipalityLabel)
                        if (!cleanMunicipalityLabel) return

                        const code = `municipality:${normalizeNameKey(cleanMunicipalityLabel)}`
                        const municipalityBoundary = municipalityScopeBoundaries[code]
                        const existing = grouped.get(code)
                        if (existing) {
                            existing.south = municipalityBoundary ? municipalityBoundary.south : Math.min(existing.south, locality.south)
                            existing.west = municipalityBoundary ? municipalityBoundary.west : Math.min(existing.west, locality.west)
                            existing.north = municipalityBoundary ? municipalityBoundary.north : Math.max(existing.north, locality.north)
                            existing.east = municipalityBoundary ? municipalityBoundary.east : Math.max(existing.east, locality.east)
                            existing.count = municipalityBoundary?.count ?? (existing.count + locality.count)
                            existing.localityCodes = Array.from(new Set([...existing.localityCodes, ...locality.localityCodes]))
                            existing.precincts = Array.from(new Set([...existing.precincts, ...(locality.precincts || [])]))
                            existing.countyLabels = Array.from(new Set([...existing.countyLabels, ...(locality.countyLabels || [])]))
                            if (municipalityBoundary?.polygons?.length) {
                                existing.boundaryPolygons = municipalityBoundary.polygons
                            }
                            existing.offlineStats = mergeOfflineScopeStats([existing.offlineStats, resolveLocalityOfflineStats(locality)])
                            existing.offlineSummary = formatOfflineScopeSummary(existing.offlineStats || EMPTY_OFFLINE_SCOPE_STATS)
                            existing.offlineDataReady = Boolean(existing.offlineStats)
                            return
                        }

                        const offlineStats = resolveLocalityOfflineStats(locality)
                        grouped.set(code, {
                            code,
                            label: cleanMunicipalityLabel,
                            displayCode: cleanMunicipalityLabel,
                            badgeLabel: locality.countyLabels?.[0] || 'gmina',
                            scopeKind: 'municipality' as const,
                            south: municipalityBoundary?.south ?? locality.south,
                            west: municipalityBoundary?.west ?? locality.west,
                            north: municipalityBoundary?.north ?? locality.north,
                            east: municipalityBoundary?.east ?? locality.east,
                            count: municipalityBoundary?.count ?? locality.count,
                            localityCodes: [...locality.localityCodes],
                            countyLabels: municipalityBoundary?.countyLabels?.length ? [...municipalityBoundary.countyLabels] : [...(locality.countyLabels || [])],
                            municipalityLabels: [cleanMunicipalityLabel],
                            boundaryPolygons: municipalityBoundary?.polygons,
                            precincts: municipalityBoundary?.precincts?.length ? [...municipalityBoundary.precincts] : [...(locality.precincts || [])],
                            offlineStats,
                            offlineSummary: formatOfflineScopeSummary(offlineStats || EMPTY_OFFLINE_SCOPE_STATS),
                            offlineDataReady: Boolean(offlineStats),
                            parcelGeometryOffline: true
                        } satisfies MapMunicipalitySummary)
                    })

                    return grouped
                }, new Map<string, MapMunicipalitySummary>()).values()
            ).sort((left, right) => left.label.localeCompare(right.label, 'pl')),
        [localities, municipalityScopeBoundaries, resolveLocalityOfflineStats]
    )


    const mapScopeOptions = useMemo<MapScopeOption[]>(

        () => [

            ...COUNTY_MAP_SCOPE_PRESETS.map((preset) => {
                const offlineStats = offlineScopeIndex?.counties?.[preset.code]

                return {
                    ...preset,
                    count: 0,
                    countyLabels: preset.countyLabels,
                    boundaryPolygons: countyScopeBoundaries[preset.code]?.polygons,
                    precincts: [],
                    offlineStats,
                    offlineSummary: formatOfflineScopeSummary(offlineStats || EMPTY_OFFLINE_SCOPE_STATS),
                    offlineDataReady: Boolean(offlineStats),
                    parcelGeometryOffline: scopeHasOfflineParcelGeometry(preset, parcelTileIndex)
                }
            }),

            ...derivedMunicipalityScopes,

            ...localities.map((locality) => {
                const offlineStats = resolveLocalityOfflineStats(locality)

                return {
                    ...locality,
                    displayCode: locality.localityCodes[0] || locality.code,
                    badgeLabel: locality.municipalities?.[0],
                    scopeKind: 'locality' as const,
                    localityCodes: locality.localityCodes,
                    countyLabels: locality.countyLabels || [],
                    municipalityLabels: locality.municipalities || [],
                    precincts: locality.precincts,
                    offlineStats,
                    offlineSummary: formatOfflineScopeSummary(offlineStats || EMPTY_OFFLINE_SCOPE_STATS),
                    offlineDataReady: Boolean(offlineStats),
                    parcelGeometryOffline: scopeHasOfflineParcelGeometry(locality, parcelTileIndex)
                }
            })

        ],

        [countyScopeBoundaries, derivedMunicipalityScopes, localities, parcelTileIndex, resolveLocalityOfflineStats]

    )

    const selectedLocalityCodeList = useMemo(() => Array.from(new Set(selectedLocalityCodes)), [selectedLocalityCodes])

    const selectedLocalityKey = useMemo(() => selectedLocalityCodeList.slice().sort().join('|'), [selectedLocalityCodeList])

    const selectedLocalities = useMemo(

        () => mapScopeOptions.filter((scope) => selectedLocalityCodeList.includes(scope.code)),

        [mapScopeOptions, selectedLocalityCodeList]

    )

    const visibleSelectedLocalities = useMemo(

        () => (selectedParcelSearchResult ? [] : selectedLocalities),

        [selectedLocalities, selectedParcelSearchResult]

    )

    const selectedParcelLocalityCodeList = useMemo(

        () => Array.from(new Set(selectedLocalities.flatMap((scope) => scope.localityCodes))),

        [selectedLocalities]

    )

    const selectedParcelPrecinctList = useMemo(

        () => Array.from(new Set(selectedLocalities.flatMap((scope) => scope.precincts).filter(Boolean))),

        [selectedLocalities]

    )

    const selectedCountyLabelList = useMemo(

        () => Array.from(new Set(selectedLocalities.flatMap((scope) => scope.countyLabels).filter(Boolean))),

        [selectedLocalities]

    )

    const selectedBoundaryPolygons = useMemo(

        () => visibleSelectedLocalities.filter((scope) => shouldDrawMapScopeBoundary(scope)).flatMap((scope) => scope.boundaryPolygons || []),

        [visibleSelectedLocalities]

    )

    const selectedLocalityBounds = useMemo(

        () =>

            selectedLocalities.map((locality) => ({

                south: locality.south,

                west: locality.west,

                north: locality.north,

                east: locality.east

            })),

        [selectedLocalities]

    )

    const selectedLocalityBoundsUnion = useMemo(() => mergeBounds(selectedLocalityBounds), [selectedLocalityBounds])

    const selectedLocalityLabels = useMemo(

        () => new Set(selectedLocalities.map((locality) => normalizeNameKey(locality.label))),

        [selectedLocalities]

    )

    const hasSelectedLocalityScope = selectedLocalities.length > 0

    const hasAnyMapDataSelected =

        showWorkerRoutes ||

        showWorkerMarkers ||

        showSurveyMarkers ||

        showMeetingMarkers ||

        showParcelOverlay ||

        showPowerPoles ||

        showPowerLines

    const hasAnyExportDataSelected = showSurveyMarkers || showMeetingMarkers || showPowerPoles

    const shouldLoadScopedMapData = mapScopeApplied && hasSelectedLocalityScope && hasAnyMapDataSelected

    const canApplyMapScope = hasSelectedLocalityScope && hasAnyMapDataSelected

    const filteredLocalities = useMemo(() => {
        if (localityTypeFilter === 'parcel') return []

        const options = mapScopeOptions.filter((locality) => {

            if (shouldHideMapScopeOption(locality)) return false

            if (localityTypeFilter === 'county') return locality.scopeKind === 'county'

            if (localityTypeFilter === 'municipality') return locality.scopeKind === 'municipality'

            if (localityTypeFilter === 'locality') return locality.scopeKind === 'locality'

            if (localityTypeFilter === 'selected') return selectedLocalityCodeList.includes(locality.code)

            return true

        })

        const query = normalizeNameKey(localitySearch)

        if (!query) return options

        return options.filter((locality) =>

            normalizeNameKey(locality.label).includes(query) ||

            normalizeNameKey(locality.displayCode).includes(query) ||

            normalizeNameKey(locality.code).includes(query)

        )

    }, [localitySearch, localityTypeFilter, mapScopeOptions, selectedLocalityCodeList])

    const derivedMunicipalityCount = useMemo(
        () =>
            Array.from(
                new Set(
                    localities.flatMap((locality) => locality.municipalities || []).map((value) => normalizeNameKey(value)).filter(Boolean)
                )
            ).length,
        [localities]
    )

    useEffect(() => {
        const trimmedQuery = localitySearch.trim()
        const normalizedQuery = normalizeNameKey(trimmedQuery)
        if (!normalizedQuery || trimmedQuery.length < 2 || !/\d/.test(trimmedQuery)) {
            setParcelSearchResults([])
            return
        }

        let cancelled = false
        const timer = window.setTimeout(() => {
            void fetchAllLocalParcels()
                .then((parcels) => {
                    if (cancelled) return
                    const matches = filterParcelsByQuery(parcels, trimmedQuery)
                        .slice(0, 12)
                        .map((parcel) => ({
                            id: parcel.id,
                            parcelNumber: parcel.parcelNumber,
                            south: parcel.south,
                            west: parcel.west,
                            north: parcel.north,
                            east: parcel.east,
                            localityLabel: parcel.localityLabel,
                            municipality: parcel.municipality,
                            precinct: parcel.precinct,
                            county: parcel.county
                        }))
                    setParcelSearchResults(matches)
                })
                .catch((error) => {
                    if (cancelled) return
                    console.warn('Failed to search parcels by query:', error)
                    setParcelSearchResults([])
                })
        }, 220)

        return () => {
            cancelled = true
            window.clearTimeout(timer)
        }
    }, [localitySearch])

    useEffect(() => {
        if (!selectedParcelSearchResult) return
        if (parcelSearchResults.some((parcel) => parcel.id === selectedParcelSearchResult.id)) return
        setSelectedParcelSearchResult(null)
    }, [parcelSearchResults, selectedParcelSearchResult])

    const getMeetingResolvedLocation = (meeting: SalesMeeting): GeocodedMeetingAddress | { lat: number; lng: number; label: string } | null => {

        const directLocation = getSalesMeetingMapLocation(meeting)

        if (directLocation) return directLocation



        for (const query of buildMeetingAddressQueries(meeting)) {

            const cacheKey = getMeetingAddressCacheKey(query)

            const cached = cacheKey ? meetingLocations[cacheKey] : null

            if (cached) return cached

        }



        return null

    }



    const meetingMatchesSelectedLocalities = useCallback((meeting: SalesMeeting): boolean => {
        if (!shouldLoadScopedMapData) return false
        if (meeting.locality_code && selectedParcelLocalityCodeList.includes(meeting.locality_code)) return true

        const parcelLocalityCode = getLocalityCodeFromParcelId(meeting.parcel_id)
        if (parcelLocalityCode && selectedParcelLocalityCodeList.includes(parcelLocalityCode)) return true
        if (meeting.locality_label && selectedLocalityLabels.has(normalizeNameKey(meeting.locality_label))) return true

        const resolvedLocation = getMeetingResolvedLocation(meeting)
        return Boolean(resolvedLocation && pointMatchesSelectedScopes(resolvedLocation.lat, resolvedLocation.lng, selectedLocalities))
    }, [meetingLocations, selectedLocalities, selectedLocalityLabels, selectedParcelLocalityCodeList, shouldLoadScopedMapData])



    const filteredVisibleSalesMeetings = useMemo(

        () =>

            salesMeetings.filter((meeting) => {

                if (!MAP_VISIBLE_MEETING_STATUSES.includes(meeting.status)) return false

                const workerId = resolveMeetingWorkerId(meeting, workers)

                if (workerId !== null && !visibleWorkers.has(workerId)) return false

                return meetingMatchesSelectedLocalities(meeting)

            }),

        [salesMeetings, workers, visibleWorkers, meetingMatchesSelectedLocalities, shouldLoadScopedMapData]

    )



    const filteredVisibleSurveys = useMemo(

        () => {

            if (!shouldLoadScopedMapData) return []



            return dedupeSurveys(

                surveys.filter((survey) => {

                    if (!survey.latitude || !survey.longitude) return false

                    if (!visibleWorkers.has(survey.user_id)) return false

                    if (selectedLocalities.length === 0) return true

                    return pointMatchesSelectedScopes(Number(survey.latitude), Number(survey.longitude), selectedLocalities)

                })

            )

        },

        [selectedLocalities, shouldLoadScopedMapData, surveys, visibleWorkers]

    )



    const toggleWorker = (id: number) => {

        setVisibleWorkers((prev) => {

            const next = new Set(prev)

            if (next.has(id)) next.delete(id)

            else next.add(id)

            return next

        })

    }



    const toggleLocality = (code: string) => {

        setSelectedLocalityCodes((prev) => {

            if (prev.includes(code)) return prev.filter((item) => item !== code)

            return [...prev, code]

        })

    }

    const handleToggleLocalityClick = (code: string, event: React.MouseEvent<HTMLButtonElement>) => {
        toggleLocality(code)
        event.currentTarget.blur()
    }



    const clearLocalitySelection = () => {

        setSelectedLocalityCodes([])

    }

    const removeSelectedLocality = (code: string) => {

        setSelectedLocalityCodes((prev) => prev.filter((item) => item !== code))

    }

    const clearSelectedParcelSearchResult = useCallback(() => {
        setSelectedParcelSearchResult(null)
    }, [])

    const findBestScopeForParcel = useCallback((parcel: ParcelSearchResult) => {
        const parcelPrecinct = normalizeNameKey(parcel.precinct || '')
        const parcelLocality = normalizeNameKey(parcel.localityLabel || '')
        const parcelMunicipality = normalizeNameKey(parcel.municipality || '')
        const parcelCounty = normalizeNameKey(parcel.county || '')

        const scopeMatchesCounty = (scope: MapScopeOption) =>
            !parcelCounty || scope.countyLabels.some((value) => normalizeNameKey(value) === parcelCounty)

        const exactLocality = mapScopeOptions.find((scope) =>
            scope.scopeKind === 'locality' &&
            scopeMatchesCounty(scope) &&
            (
                normalizeNameKey(scope.label) === parcelPrecinct ||
                normalizeNameKey(scope.label) === parcelLocality ||
                scope.precincts.some((value) => normalizeNameKey(value) === parcelPrecinct)
            )
        )
        if (exactLocality) return exactLocality

        const municipalityScope = mapScopeOptions.find((scope) =>
            scope.scopeKind === 'municipality' &&
            scopeMatchesCounty(scope) &&
            normalizeNameKey(scope.label) === parcelMunicipality
        )
        if (municipalityScope) return municipalityScope

        return mapScopeOptions.find((scope) =>
            scope.scopeKind === 'county' &&
            normalizeNameKey(scope.label) === parcelCounty
        ) || null
    }, [mapScopeOptions])

    const zoomToParcelSearchResult = useCallback((parcel: ParcelSearchResult) => {
        const map = mapInst.current
        if (!map) return

        if (selectedParcelSearchResult?.id === parcel.id) {
            setSelectedParcelSearchResult(null)
            return
        }

        const matchingScope = findBestScopeForParcel(parcel)
        if (matchingScope) {
            setSelectedLocalityCodes([matchingScope.code])
            setMapScopeApplied(true)
            setMapScopeLoadVersion((current) => current + 1)
        }

        hasCenteredRef.current = true
        setShowParcelOverlay(true)
        setSelectedParcelSearchResult(parcel)
        const centerLat = (parcel.south + parcel.north) / 2
        const centerLng = (parcel.west + parcel.east) / 2
        const maxSpan = Math.max(Math.abs(parcel.north - parcel.south), Math.abs(parcel.east - parcel.west))
        map.fitBounds(
            [
                [parcel.south, parcel.west],
                [parcel.north, parcel.east]
            ],
            { padding: [48, 48], maxZoom: 18 }
        )
        if (maxSpan < 0.01) {
            window.setTimeout(() => {
                if (!mapInst.current) return
                hasCenteredRef.current = true
                mapInst.current.setView([centerLat, centerLng], 18, { animate: false })
            }, 120)
        }
    }, [findBestScopeForParcel, selectedParcelSearchResult])



    const selectAllFilteredLocalities = () => {

        setSelectedLocalityCodes(Array.from(new Set(filteredLocalities.map((locality) => locality.code))))

    }



    const zoomToSelectedLocalities = useCallback(() => {

        if (!selectedLocalityBoundsUnion || !mapInst.current) return

        hasCenteredRef.current = true

        mapInst.current.fitBounds(

            [

                [selectedLocalityBoundsUnion.south, selectedLocalityBoundsUnion.west],

                [selectedLocalityBoundsUnion.north, selectedLocalityBoundsUnion.east]

            ],

            { padding: [36, 36], maxZoom: 15 }

        )

    }, [selectedLocalityBoundsUnion])



    const closeMapScopeDialog = () => {

        setMapScopeDialogOpen(false)

    }



    const applyMapScopeSelection = () => {

        if (!hasSelectedLocalityScope) {

            hotToast.error('Wybierz przynajmniej jedną miejscowość lub powiat do wczytania danych.')

            return

        }



        if (!hasAnyMapDataSelected) {

            hotToast.error('Włącz przynajmniej jeden typ danych do wczytania.')

            return

        }



        setMapScopeLoadVersion((current) => current + 1)

        setMapScopeApplied(true)

        setMapScopeDialogOpen(false)

        hasCenteredRef.current = false

        zoomToSelectedLocalities()

        queuePowerOverlayRender(0)

    }



    useEffect(() => {

        meetingLocationsRef.current = meetingLocations

    }, [meetingLocations])



    useEffect(() => {

        let cancelled = false



        const loadLocalities = async () => {

            try {

                const [nextLocalities, localityBoundaries] = await Promise.all([
                    fetchParcelLocalities(),
                    fetchLocalityScopeBoundaries().catch(() => ({} as Record<string, LocalityScopeBoundary>))
                ])

                if (cancelled) return

                const mergedLocalities = new Map<string, MapLocalitySummary>()

                nextLocalities.forEach((locality) => {
                    const boundary = localityBoundaries[locality.code]
                    mergedLocalities.set(locality.code, {
                        ...locality,
                        label: cleanDisplayText(locality.label),
                        precincts: (locality.precincts || []).map((value) => cleanDisplayText(value)).filter(Boolean),
                        municipalities: (locality.municipalities || []).map((value) => cleanDisplayText(value)).filter(Boolean),
                        countyLabels: (locality.countyLabels || []).map((value) => cleanDisplayText(value)).filter(Boolean),
                        boundaryPolygons: boundary && !isSuspiciousLocalityBoundary(boundary, locality) ? boundary.polygons : undefined
                    })
                })

                Object.values(localityBoundaries).forEach((boundary) => {
                    if (mergedLocalities.has(boundary.code)) return
                    if (isSuspiciousLocalityBoundary(boundary, null)) return

                    mergedLocalities.set(boundary.code, {
                        code: boundary.code,
                        label: cleanDisplayText(boundary.label),
                        south: boundary.south,
                        west: boundary.west,
                        north: boundary.north,
                        east: boundary.east,
                        count: boundary.count,
                        localityCodes: boundary.localityCodes,
                        precincts: (boundary.precincts || []).map((value) => cleanDisplayText(value)).filter(Boolean),
                        municipalities: [],
                        countyLabels: [],
                        boundaryPolygons: boundary.polygons
                    })
                })

                setLocalities(

                    dedupeMapLocalities(Array.from(mergedLocalities.values()))
                        .filter((locality) => !locality.code.startsWith('unknown::') && !isTechnicalLocalityLabel(locality.label))
                        .sort((left, right) => {

                            if (right.count !== left.count) return right.count - left.count

                            return left.label.localeCompare(right.label, 'pl')

                        })

                )

            } catch (error) {

                console.error('Failed to load localities for global map:', error)

            }

        }

        void loadLocalities()

        return () => {

            cancelled = true

        }

    }, [])

    useEffect(() => {
        let cancelled = false

        const loadMunicipalityBoundaries = async () => {
            try {
                const nextMunicipalityBoundaries = await fetchMunicipalityScopeBoundaries()
                if (cancelled) return
                setMunicipalityScopeBoundaries(nextMunicipalityBoundaries)
            } catch (error) {
                console.warn('Failed to load municipality scope boundaries:', error)
            }
        }

        void loadMunicipalityBoundaries()

        return () => {
            cancelled = true
        }
    }, [])

    useEffect(() => {

        let cancelled = false

        const loadOfflineScopeIndex = async () => {

            try {

                const nextScopeIndex = await fetchOfflineScopeIndex()

                if (cancelled) return

                setOfflineScopeIndex(nextScopeIndex)

            } catch (error) {

                console.warn('Failed to load offline scope index:', error)

            }

        }

        void loadOfflineScopeIndex()

        return () => {

            cancelled = true

        }

    }, [])

    useEffect(() => {

        let cancelled = false

        const loadParcelCoverageIndex = async () => {

            try {

                const nextParcelTileIndex = await fetchParcelTileIndex()

                if (cancelled) return

                setParcelTileIndex(nextParcelTileIndex)

            } catch (error) {

                console.warn('Failed to load parcel tile index:', error)

            }

        }

        void loadParcelCoverageIndex()

        return () => {

            cancelled = true

        }

    }, [])

    useEffect(() => {

        let cancelled = false

        const loadCountyBoundaries = async () => {

            try {

                const nextBoundaries = await fetchCountyScopeBoundaries()

                if (cancelled) return

                setCountyScopeBoundaries(nextBoundaries)

            } catch (error) {

                console.warn('Failed to load county scope boundaries:', error)

            }

        }

        void loadCountyBoundaries()

        return () => {

            cancelled = true

        }

    }, [])



    useEffect(() => {

        if (hasSelectedLocalityScope && hasAnyMapDataSelected) return

        lastAutoScopeSelectionKeyRef.current = ''

        setMapScopeApplied(false)

    }, [hasAnyMapDataSelected, hasSelectedLocalityScope])



    useEffect(() => {

        if (!canApplyMapScope) return
        if (selectedParcelSearchResult) return



        const autoScopeKey = [

            selectedLocalityKey,

            showWorkerRoutes ? 'routes' : '',

            showWorkerMarkers ? 'workers' : '',

            showSurveyMarkers ? 'surveys' : '',

            showMeetingMarkers ? 'meetings' : '',

            showParcelOverlay ? 'parcels' : '',

            showPowerPoles ? 'poles' : '',

            showPowerLines ? 'lines' : ''

        ].join('::')



        if (lastAutoScopeSelectionKeyRef.current === autoScopeKey) return

        lastAutoScopeSelectionKeyRef.current = autoScopeKey



        setMapScopeLoadVersion((current) => current + 1)

        setMapScopeApplied(true)

        hasCenteredRef.current = false

        queuePowerOverlayRender(0)

    }, [

        selectedParcelSearchResult,

        canApplyMapScope,

        queuePowerOverlayRender,

        selectedLocalityKey,

        showMeetingMarkers,

        showParcelOverlay,

        showPowerLines,

        showPowerPoles,

        showSurveyMarkers,

        showWorkerMarkers,

        showWorkerRoutes

    ])



    useEffect(() => {

        if (!shouldLoadScopedMapData || !selectedLocalityBoundsUnion) return

        if (mapScopeDialogOpen) return

        if (hasCenteredRef.current) return

        zoomToSelectedLocalities()

    }, [mapScopeDialogOpen, selectedLocalityBoundsUnion, shouldLoadScopedMapData, zoomToSelectedLocalities])



    useEffect(() => {

        const syncFullscreenState = () => {

            const doc = document as Document & { webkitFullscreenElement?: Element | null }

            const fullscreenElement = doc.fullscreenElement || doc.webkitFullscreenElement || null

            const active = Boolean(mapShellRef.current && fullscreenElement === mapShellRef.current)

            setIsFullscreen(active)



            ;[0, 120, 320, 640].forEach((delay) => {

                window.setTimeout(() => {

                    forceMapReflow({ burst: delay === 0 || delay === 320 })

                }, delay)

            })

        }



        document.addEventListener('fullscreenchange', syncFullscreenState)

        document.addEventListener('webkitfullscreenchange', syncFullscreenState as EventListener)



        return () => {

            document.removeEventListener('fullscreenchange', syncFullscreenState)

            document.removeEventListener('webkitfullscreenchange', syncFullscreenState as EventListener)

        }

    }, [forceMapReflow])



    const toggleFullscreen = async () => {

        const shell = mapShellRef.current as (HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> | void }) | null

        if (!shell) return



        try {

            const doc = document as Document & {

                webkitExitFullscreen?: () => Promise<void> | void

                webkitFullscreenElement?: Element | null

            }

            const fullscreenElement = doc.fullscreenElement || doc.webkitFullscreenElement || null



            if (fullscreenElement === shell) {

                if (document.exitFullscreen) await document.exitFullscreen()

                else if (doc.webkitExitFullscreen) await doc.webkitExitFullscreen()

                return

            }



            if (shell.requestFullscreen) await shell.requestFullscreen()

            else if (shell.webkitRequestFullscreen) await shell.webkitRequestFullscreen()

        } catch {

            // Ignore browser fullscreen errors.

        }

    }



    useEffect(() => {

        const handleViewportChange = () => forceMapReflow()

        const handleVisibilityChange = () => {

            if (document.visibilityState === 'visible') {

                forceMapReflow({ burst: true })

            }

        }



        window.addEventListener('resize', handleViewportChange)

        window.addEventListener('orientationchange', handleViewportChange)

        window.addEventListener('pageshow', handleViewportChange)

        document.addEventListener('visibilitychange', handleVisibilityChange)



        const viewport = window.visualViewport

        viewport?.addEventListener('resize', handleViewportChange)



        return () => {

            window.removeEventListener('resize', handleViewportChange)

            window.removeEventListener('orientationchange', handleViewportChange)

            window.removeEventListener('pageshow', handleViewportChange)

            document.removeEventListener('visibilitychange', handleVisibilityChange)

            viewport?.removeEventListener('resize', handleViewportChange)

        }

    }, [forceMapReflow])



    useEffect(() => {

        if (!mapRef.current) return

        const container = mapRef.current

        let previousWidth = container.clientWidth

        let previousHeight = container.clientHeight

        const resizeObserver = typeof ResizeObserver === 'undefined'
            ? null
            : new ResizeObserver((entries) => {
                const entry = entries[0]
                if (!entry) return

                const nextWidth = Math.round(entry.contentRect.width)
                const nextHeight = Math.round(entry.contentRect.height)
                if (nextWidth === previousWidth && nextHeight === previousHeight) return

                previousWidth = nextWidth
                previousHeight = nextHeight
                forceMapReflow({ burst: true })
            })

        resizeObserver?.observe(container)



        const map = L.map(mapRef.current, {

            zoomControl: false,

            attributionControl: false,

            preferCanvas: true,

            fadeAnimation: false,

            zoomAnimation: false,

            markerZoomAnimation: false

        }).setView([50.89, 20.70], 13)



        tileLayerRef.current = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {

            keepBuffer: 10,

            updateWhenIdle: false,

            updateWhenZooming: false,

            updateInterval: 120

        })

        tileLayerRef.current.addTo(map)

        mapInst.current = map

        const syncViewportBounds = () => {
            const bounds = map.getBounds()
            mapViewportBoundsRef.current = {
                south: bounds.getSouth(),
                west: bounds.getWest(),
                north: bounds.getNorth(),
                east: bounds.getEast()
            }
            setMapViewportVersion((current) => current + 1)
        }

        markersRef.current = L.layerGroup().addTo(map)

        linesRef.current = L.layerGroup().addTo(map)

        polesRef.current = L.layerGroup().addTo(map)

        const stopAutoCenter = () => {

            hasCenteredRef.current = true

            if (powerOverlayRenderTimerRef.current !== null) {

                window.clearTimeout(powerOverlayRenderTimerRef.current)

                powerOverlayRenderTimerRef.current = null

            }

        }



        const handleMoveEnd = () => {
            syncViewportBounds()

            queuePowerOverlayRender(120)

        }



        const handleZoomEnd = () => {
            syncViewportBounds()

            forceMapReflow()

            queuePowerOverlayRender(180)

        }



        map.on('movestart', stopAutoCenter)

        map.on('zoomstart', stopAutoCenter)

        map.on('moveend', handleMoveEnd)

        map.on('zoomend', handleZoomEnd)

        syncViewportBounds()



        window.setTimeout(() => forceMapReflow({ burst: true }), 100)

        window.setTimeout(() => queuePowerOverlayRender(0), 220)



        return () => {

            if (powerOverlayRenderTimerRef.current !== null) {

                window.clearTimeout(powerOverlayRenderTimerRef.current)

                powerOverlayRenderTimerRef.current = null

            }

            map.off('movestart', stopAutoCenter)

            map.off('zoomstart', stopAutoCenter)

            map.off('moveend', handleMoveEnd)

            map.off('zoomend', handleZoomEnd)

            map.remove()

            resizeObserver?.disconnect()

            mapInst.current = null

            tileLayerRef.current = null

            markersRef.current = null

            parcelLayerRef.current = null

            selectedScopeLayerRef.current = null

            polesRef.current = null

            linesRef.current = null

        }

    }, [forceMapReflow, queuePowerOverlayRender])



    useEffect(() => {

        powerOverlaySettingsRef.current = {

            localityCodes: selectedParcelLocalityCodeList.length > 0 ? selectedParcelLocalityCodeList : null,

            countyLabels: selectedCountyLabelList.length > 0 ? selectedCountyLabelList : null,

            precinctLabels: selectedParcelPrecinctList.length > 0 ? selectedParcelPrecinctList : null,

            selectedParcelIds: selectedParcelSearchResult ? [selectedParcelSearchResult.id] : null,

            boundaryPolygons: selectedBoundaryPolygons.length > 0 ? selectedBoundaryPolygons : null,

            scopeBounds: selectedLocalityBoundsUnion,

            showPowerPoles,

            showPowerLines,

            addressFilter: addressPresenceFilter,

            scopeReady: shouldLoadScopedMapData

        }

        queuePowerOverlayRender(0)

    }, [addressPresenceFilter, queuePowerOverlayRender, selectedBoundaryPolygons, selectedCountyLabelList, selectedLocalityBoundsUnion, selectedLocalityKey, selectedParcelLocalityCodeList, selectedParcelPrecinctList, selectedParcelSearchResult, showPowerPoles, showPowerLines, shouldLoadScopedMapData])

    useEffect(() => {

        syncOverlayLayer({

            map: mapInst.current,

            layerRef: selectedScopeLayerRef,

            enabled: visibleSelectedLocalities.length > 0,

            reloadKey: selectedLocalityKey || 'none',

            createLayer: () => {

                const layer = L.layerGroup()

                if (selectedBoundaryPolygons.length > 0) {

                    selectedBoundaryPolygons.forEach((polygonRings) => {

                        const polygonLatLngs = polygonRings.map((ring) =>
                            ring.map(([lng, lat]) => [lat, lng] as [number, number])
                        )

                        L.polygon(
                            polygonLatLngs,
                            {
                                color: '#06b6d4',
                                weight: 2.5,
                                opacity: 0.98,
                                fillColor: '#22d3ee',
                                fillOpacity: 0.08,
                                dashArray: '9 6',
                                interactive: false,
                                bubblingMouseEvents: false
                            }
                        ).addTo(layer)

                    })

                    return layer

                }

                selectedLocalities.filter((locality) => shouldDrawMapScopeBoundary(locality)).forEach((locality) => {

                    if (locality.boundaryPolygons && locality.boundaryPolygons.length > 0) {

                        locality.boundaryPolygons.forEach((polygonRings) => {

                            const polygonLatLngs = polygonRings.map((ring) =>
                                ring.map(([lng, lat]) => [lat, lng] as [number, number])
                            )

                            L.polygon(
                                polygonLatLngs,
                                {
                                    color: '#06b6d4',
                                    weight: 2,
                                    opacity: 0.95,
                                    fillColor: '#22d3ee',
                                    fillOpacity: 0.1,
                                    dashArray: '8 6',
                                    interactive: false,
                                    bubblingMouseEvents: false
                                }
                            ).addTo(layer)

                        })

                        return

                    }

                    L.rectangle(

                        [

                            [locality.south, locality.west],

                            [locality.north, locality.east]

                        ],

                        {

                            color: '#06b6d4',

                            weight: 2,

                            opacity: 0.95,

                            fillColor: '#22d3ee',

                            fillOpacity: 0.1,

                            dashArray: '8 6',

                            interactive: false,

                            bubblingMouseEvents: false

                        }

                    ).addTo(layer)

                })

                return layer

            }

        })

    }, [selectedBoundaryPolygons, selectedLocalities, selectedLocalityKey])

    useEffect(() => {

        syncOverlayLayer({

            map: mapInst.current,

            layerRef: parcelLayerRef,

            enabled: shouldLoadScopedMapData && showParcelOverlay,

            reloadKey: `${selectedLocalityKey}::${showParcelOverlay ? 'parcel-on' : 'parcel-off'}::${selectedParcelLocalityCodeList.join('|')}::${selectedParcelPrecinctList.join('|')}::${addressPresenceFilter}`,

            createLayer: () => createParcelNumbersLayer({

                getVisiblePoleAnchors: () => visiblePoleAnchorsRef.current,
                selectedParcelIds: selectedParcelSearchResult ? [selectedParcelSearchResult.id] : undefined,

                localityCodes: selectedParcelLocalityCodeList.length > 0 ? selectedParcelLocalityCodeList : undefined,

                precincts: selectedParcelPrecinctList.length > 0 ? selectedParcelPrecinctList : undefined,

                addressFilter: addressPresenceFilter

            })

        })

    }, [addressPresenceFilter, selectedLocalityKey, selectedParcelLocalityCodeList, selectedParcelPrecinctList, selectedParcelSearchResult, shouldLoadScopedMapData, showParcelOverlay])

    useEffect(() => {

        if (!showMeetingMarkers || !shouldLoadScopedMapData) return

        const controller = new AbortController()

        const loadMeetingLocations = async () => {

            const updates: Record<string, GeocodedMeetingAddress | null> = {}

            for (const meeting of filteredVisibleSalesMeetings) {

                if (getSalesMeetingMapLocation(meeting)) continue

                const queries = buildMeetingAddressQueries(meeting)

                if (queries.length === 0) continue

                let resolved: GeocodedMeetingAddress | null = null

                let matchedCached = false

                for (const query of queries) {

                    const cacheKey = getMeetingAddressCacheKey(query)

                    const cached = meetingLocationsRef.current[cacheKey]

                    if (cached !== undefined) {

                        resolved = cached

                        matchedCached = true

                        break

                    }

                }

                if (!matchedCached) {

                    for (const query of queries) {

                        try {

                            resolved = await geocodeMeetingAddress(query, controller.signal)

                        } catch (error) {

                            if (error instanceof DOMException && error.name === 'AbortError') return

                            resolved = null

                        }

                        if (resolved) break

                    }

                }

                queries.forEach((query) => {

                    const cacheKey = getMeetingAddressCacheKey(query)

                    if (cacheKey && updates[cacheKey] === undefined) {

                        updates[cacheKey] = resolved

                    }

                })

            }

            if (Object.keys(updates).length > 0) {

                setMeetingLocations((prev) => ({ ...prev, ...updates }))

            }

        }

        void loadMeetingLocations()

        return () => controller.abort()

    }, [filteredVisibleSalesMeetings, showMeetingMarkers, shouldLoadScopedMapData])

    useEffect(() => {

        if (!mapInst.current || !markersRef.current) return

        const map = mapInst.current

        const layer = markersRef.current

        let cancelled = false

        layer.clearLayers()

        if (!shouldLoadScopedMapData) return

        const renderLayers = async () => {

            const bounds = L.latLngBounds([])

            let hasAny = false

            const viewportBounds = getPaddedViewportBounds()

            const pointMatchesViewport = (lat: number, lng: number) =>
                !viewportBounds || boundsContainPoint(viewportBounds, lat, lng)

            workers

                .filter((worker) => worker.lastGps && visibleWorkers.has(worker.user.id!))

                .forEach((worker) => {

                    const workerGps = allGps

                        .filter((gps) => gps.user_id === worker.user.id && gps.timestamp >= rangeFrom && gps.timestamp <= rangeTo)

                        .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime())

                    const localityFilteredGps =

                        selectedLocalities.length > 0

                            ? workerGps.filter((gps) => pointMatchesSelectedScopes(gps.latitude, gps.longitude, selectedLocalities))

                            : workerGps

                    const viewportFilteredGps = localityFilteredGps.filter((gps) => pointMatchesViewport(gps.latitude, gps.longitude))

                    const workerSurveyPoints = filteredVisibleSurveys.filter(

                        (survey) =>
                            survey.user_id === worker.user.id &&
                            survey.created_at >= rangeFrom &&
                            survey.created_at <= rangeTo &&
                            pointMatchesViewport(Number(survey.latitude), Number(survey.longitude))

                    )

                    if (showWorkerRoutes) {

                        const routePoints = buildDisplayRoute(viewportFilteredGps, workerSurveyPoints)

                        if (routePoints.length > 1) {

                            L.polyline(routePoints, { color: '#ffffff', weight: 5, opacity: 0.55, lineCap: 'round' }).addTo(layer)

                            L.polyline(routePoints, { color: '#f59e0b', weight: 3, opacity: 0.82, lineCap: 'round' }).addTo(layer)

                            routePoints.forEach((point) => bounds.extend(point))

                            hasAny = true

                        }

                    }

                    if (!showWorkerMarkers || !worker.lastGps) return

                    if (selectedLocalities.length > 0 && !pointMatchesSelectedScopes(worker.lastGps.latitude, worker.lastGps.longitude, selectedLocalities)) return

                    if (!pointMatchesViewport(worker.lastGps.latitude, worker.lastGps.longitude)) return

                    const hasActivity = worker.todaySurveys > 0 || (worker.lastGps.timestamp >= rangeFrom && worker.lastGps.timestamp <= rangeTo)

                    const isCurrentlyActive = Boolean(worker.activeShift && dateTo === todayISO && dateFrom <= todayISO)

                    const gpsColor = isCurrentlyActive ? '#10b981' : (hasActivity ? '#ef4444' : '#94a3b8')

                    L.circleMarker([worker.lastGps.latitude, worker.lastGps.longitude], {

                        radius: 8,

                        fillColor: gpsColor,

                        fillOpacity: 1,

                        color: 'white',

                        weight: 3

                    })

                        .addTo(layer)

                        .bindTooltip(`${worker.user.name} (${worker.todaySurveys})`, {

                            permanent: true,

                            direction: 'top',

                            offset: [0, -10],

                            className: 'worker-label-tooltip'

                        })

                    bounds.extend([worker.lastGps.latitude, worker.lastGps.longitude])

                    hasAny = true

                })

            if (showSurveyMarkers) {

                const allLocalPoles = await getCachedLocalPoles(selectedLocalityBoundsUnion || undefined)

                if (cancelled) return

                const snappedSurveys = snapToNearestAvailablePole(

                    filteredVisibleSurveys
                        .filter((survey) => pointMatchesViewport(Number(survey.latitude), Number(survey.longitude)))
                        .map((survey) => ({

                            survey,

                            lat: Number(survey.latitude),

                            lng: Number(survey.longitude)

                        })),

                    allLocalPoles,

                    30

                )

                const spreadSurveys = spreadOverlappingMarkers(snappedSurveys, 9)

                spreadSurveys.forEach((item) => {

                    const surveyStatus = getSurveyStatus(item.survey)

                    const attemptedNote = getAttemptedNote(item.survey)

                    const noteLine = attemptedNote ? `<br/>Notatka: ${escapeHtml(attemptedNote)}` : ''

                    const icon = L.divIcon({

                        className: 'survey-marker-v2',

                        html: `<div style="background-color: ${surveyStatus.markerColor}; width: 26px; height: 26px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 6px rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; font-size: 14px; color: white; font-weight: bold;">${surveyStatus.markerChar}</div>`,

                        iconSize: [26, 26],

                        iconAnchor: [13, 13]

                    })

                    L.marker([item.renderLat, item.renderLng], { icon, zIndexOffset: 500 }).addTo(layer).bindPopup(

                        `<strong>Wpis</strong><br/>Status: ${surveyStatus.label}<br/>Pracownik: <b>${item.survey.user_name || 'Nieznany'}</b><br/>Adres: ${item.survey.address || 'Brak'}<br/>Osoba: ${item.survey.respondent_name || 'Brak'}<br/>Godzina: ${new Date(item.survey.created_at).toLocaleTimeString('pl-PL')}${noteLine}`

                    )

                    bounds.extend([item.renderLat, item.renderLng])

                    hasAny = true

                })

            }

            if (showMeetingMarkers) {

                const meetingPoints = spreadOverlappingMarkers(

                    filteredVisibleSalesMeetings

                        .map((meeting) => {

                            const resolvedLocation = getMeetingResolvedLocation(meeting)

                            if (!resolvedLocation) return null

                            if (!pointMatchesViewport(resolvedLocation.lat, resolvedLocation.lng)) return null

                            return { meeting, lat: resolvedLocation.lat, lng: resolvedLocation.lng, label: resolvedLocation.label }

                        })

                        .filter((item): item is { meeting: SalesMeeting; lat: number; lng: number; label: string } => item !== null),

                    14

                )

                meetingPoints.forEach((item) => {

                    const markerMeta = getMapMeetingMarkerMeta(item.meeting)

                    const displayMeta = getSalesMeetingDisplayMeta(item.meeting)

                    const cleanStatusNote = getSalesMeetingCleanStatusNote(item.meeting.status_note)

                    const timeLabel = new Date(item.meeting.scheduled_at).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })

                    const popupRows = [

                        '<strong>Przypisane spotkanie</strong>',

                        `Status: ${escapeHtml(displayMeta.label)}`,

                        `Termin: ${escapeHtml(new Date(item.meeting.scheduled_at).toLocaleString('pl-PL'))}`,

                        `Handlowiec: <b>${escapeHtml(item.meeting.salesperson_name || 'Nieprzypisany')}</b>`,

                        `Klient: ${escapeHtml(item.meeting.client_name || 'Brak')}`,

                        `Lokalizacja: ${escapeHtml(getSalesMeetingPrimaryLocationLabel(item.meeting) || item.label)}`

                    ]

                    if (item.meeting.phone) popupRows.push(`Telefon: ${escapeHtml(item.meeting.phone)}`)

                    if (item.meeting.lead_source) popupRows.push(`Zrodlo: ${escapeHtml(normalizeSalesMeetingInlineText(item.meeting.lead_source))}`)

                    if (item.meeting.note) popupRows.push(`Komentarz: ${escapeHtml(normalizeSalesMeetingInlineText(item.meeting.note))}`)

                    if (cleanStatusNote) popupRows.push(`Informacja statusu: ${escapeHtml(cleanStatusNote)}`)

                    const icon = L.divIcon({

                        className: 'sales-meeting-marker',

                        html: `<div style="display:flex;flex-direction:column;align-items:center;transform:translateY(-2px);"><div style="min-width:58px;padding:5px 9px;border-radius:999px;background:${markerMeta.color};color:#fff;font-size:11px;font-weight:900;line-height:1;letter-spacing:0.06em;text-align:center;box-shadow:0 12px 28px rgba(15,23,42,0.22);border:2px solid rgba(255,255,255,0.92);">${escapeHtml(timeLabel)}</div><div style="width:0;height:0;border-left:7px solid transparent;border-right:7px solid transparent;border-top:9px solid ${markerMeta.color};margin-top:-1px;filter:drop-shadow(0 4px 8px rgba(15,23,42,0.18));"></div><div style="width:18px;height:18px;border-radius:999px;background:${markerMeta.color};border:3px solid rgba(255,255,255,0.96);margin-top:-2px;box-shadow:0 6px 14px rgba(15,23,42,0.2);display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:900;">${markerMeta.glyph}</div></div>`,

                        iconSize: [58, 42],

                        iconAnchor: [29, 42],

                        popupAnchor: [0, -34]

                    })

                    L.marker([item.renderLat, item.renderLng], { icon, zIndexOffset: 760 }).addTo(layer).bindPopup(popupRows.join('<br/>'))

                    bounds.extend([item.renderLat, item.renderLng])

                    hasAny = true

                })

            }

            if (hasAny && !hasCenteredRef.current && !selectedParcelSearchResult) {

                map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 })

            }

        }

        void renderLayers()

        return () => {

            cancelled = true

        }

    }, [

        allGps,

        dateFrom,

        dateTo,

        filteredVisibleSalesMeetings,

        filteredVisibleSurveys,

        getCachedLocalPoles,

        getPaddedViewportBounds,

        mapViewportVersion,

        meetingLocations,

        rangeFrom,

        rangeTo,

        selectedLocalityBounds,

        selectedLocalityBoundsUnion,
        selectedParcelSearchResult,

        selectedLocalityKey,

        shouldLoadScopedMapData,

        showMeetingMarkers,

        showSurveyMarkers,

        showWorkerMarkers,

        showWorkerRoutes,

        visibleWorkers,

        workers

    ])

    useEffect(() => {

        if (!shouldLoadScopedMapData) return

        if (!selectedLocalityBoundsUnion) return

        if (mapScopeLoadVersion === 0) return

        if (!showPowerPoles && !showPowerLines && !showParcelOverlay) return



        const syncKey = [

            mapScopeLoadVersion,

            selectedLocalityKey,

            selectedParcelLocalityCodeList.slice().sort().join('|'),

            selectedParcelPrecinctList.slice().sort().join('|'),

            showPowerPoles ? 'poles' : '',

            showPowerLines ? 'lines' : '',

            showParcelOverlay ? 'parcels' : ''

        ].join('::')



        if (lastPoleAssignmentSyncKeyRef.current === syncKey) return

        lastPoleAssignmentSyncKeyRef.current = syncKey



        let cancelled = false



        const syncPoleAssignments = async () => {

            try {

                const result = await syncPoleAssignmentsFromScope({

                    bounds: selectedLocalityBoundsUnion,

                    localityCodes: selectedParcelLocalityCodeList.length > 0 ? selectedParcelLocalityCodeList : null,

                    countyLabels: selectedCountyLabelList.length > 0 ? selectedCountyLabelList : null,

                    precinctLabels: selectedParcelPrecinctList.length > 0 ? selectedParcelPrecinctList : null,

                    boundaryPolygons: selectedBoundaryPolygons.length > 0 ? selectedBoundaryPolygons : null

                })

                if (cancelled || result.rowCount === 0) return

                hotToast.success(`Tabela działek zsynchronizowana: ${result.rowCount} rekordów z ${result.poleCount} słupów.`)

            } catch (error) {

                if (cancelled) return

                console.warn('Skipped automatic pole assignment sync for selected map scope:', error)

            }

        }



        void syncPoleAssignments()



        return () => {

            cancelled = true

        }

    }, [

        mapScopeLoadVersion,

        selectedLocalityBoundsUnion,

        selectedLocalityKey,

        selectedBoundaryPolygons,

        selectedCountyLabelList,

        selectedParcelLocalityCodeList,

        selectedParcelPrecinctList,

        showParcelOverlay,

        showPowerLines,

        showPowerPoles,

        shouldLoadScopedMapData

    ])



    const exportCurrentMapData = async () => {

        if (!hasSelectedLocalityScope) {


            hotToast.error('Najpierw wybierz miejscowość lub powiat, z którego chcesz pobrać dane.')

            return

        }



        if (!hasAnyExportDataSelected) {


            hotToast.error('Wybierz przynajmniej jeden typ danych do eksportu.')

            return

        }



        if (!shouldLoadScopedMapData) {


            hotToast.error('Wybierz obszar i co najmniej jeden typ danych w prawym panelu przed pobraniem eksportu.')

            return

        }



        const map = mapInst.current

        if (!map) {

            hotToast.error('Mapa nie jest jeszcze gotowa.')

            return

        }



        const viewportBounds = map.getBounds()

        const viewport = {

            south: viewportBounds.getSouth(),

            west: viewportBounds.getWest(),

            north: viewportBounds.getNorth(),

            east: viewportBounds.getEast()

        }

        const exportBounds = selectedLocalityBoundsUnion || viewport

        const pointMatchesExport = (lat: number, lng: number) =>

            selectedBoundaryPolygons.length > 0

                ? boundaryPolygonContainsPoint(selectedBoundaryPolygons, lat, lng)

                : selectedLocalityBounds.length > 0

                ? pointMatchesLocalityBounds(lat, lng, selectedLocalityBounds)

                : boundsContainPoint(viewport, lat, lng)



        setExportingCsv(true)

        try {

            const { poles } = await fetchPowerData(exportBounds, {

                localityCodes: selectedParcelLocalityCodeList.length > 0 ? selectedParcelLocalityCodeList : null,

                countyLabels: selectedCountyLabelList.length > 0 ? selectedCountyLabelList : null,

                precinctLabels: selectedParcelPrecinctList.length > 0 ? selectedParcelPrecinctList : null,

                boundaryPolygons: selectedBoundaryPolygons.length > 0 ? selectedBoundaryPolygons : null

            })



            const exportPoles = poles.filter((pole) => pointMatchesExport(pole.lat, pole.lng) && hasPowerPoleParcelAssignment(pole))

            const resolvedExportPoles = showPowerPoles

                ? await Promise.all(exportPoles.map((pole) => resolvePowerPoleDetails({ ...pole })))

                : []

            const exportMeetings = filteredVisibleSalesMeetings.filter((meeting) => {

                const resolvedLocation = getMeetingResolvedLocation(meeting)

                return Boolean(resolvedLocation && pointMatchesExport(resolvedLocation.lat, resolvedLocation.lng))

            })

            const exportSurveys = filteredVisibleSurveys.filter((survey) =>

                pointMatchesExport(Number(survey.latitude), Number(survey.longitude))

            )



            const exportPoleRows = showPowerPoles ? resolvedExportPoles.map((pole) => {

                const displayAddress = getPowerPoleDisplayAddress(pole)

                const suggestedLocation = getPowerPoleSuggestedLocation(pole)

                return [

                    'slup',

                    pole.id,

                    '',

                    displayAddress ? 'adres dokładny' : 'adres do doprecyzowania',

                    '',

                    displayAddress,

                    pole.localityLabel || pole.precinct || pole.municipality || pole.county || '',

                    pole.parcelId || '',

                    pole.parcelNumber || '',

                    getPowerVoltageLabel(pole.voltage),

                    pole.type,

                    pole.lat.toFixed(6),

                    pole.lng.toFixed(6),

                    getPowerPoleGoogleMapsUrl(pole),

                    suggestedLocation,

                    displayAddress ? '' : 'Brak dokładnego adresu - użyj sugerowanej lokalizacji.'

                ]

            }) : []

            const exportMeetingRows = showMeetingMarkers ? exportMeetings.map((meeting) => {

                const resolvedLocation = getMeetingResolvedLocation(meeting)

                const statusMeta = getSalesMeetingDisplayMeta(meeting)

                return [

                    'spotkanie',

                    meeting.id || meeting.import_key,

                    meeting.salesperson_name || '',

                    statusMeta.label,

                    new Date(meeting.scheduled_at).toLocaleString('pl-PL'),

                    getSalesMeetingPrimaryLocationLabel(meeting),

                    meeting.locality_label || '',

                    meeting.parcel_id || '',

                    meeting.parcel_number || '',

                    '',

                    meeting.client_name || '',

                    resolvedLocation ? resolvedLocation.lat.toFixed(6) : '',

                    resolvedLocation ? resolvedLocation.lng.toFixed(6) : '',

                    resolvedLocation ? `https://www.google.com/maps?q=${resolvedLocation.lat.toFixed(6)},${resolvedLocation.lng.toFixed(6)}` : '',

                    getSalesMeetingPrimaryLocationLabel(meeting),

                    meeting.note || meeting.status_note || ''

                ]

            }) : []

            const exportSurveyRows = showSurveyMarkers ? exportSurveys.map((survey) => {

                const matchingLocality = findMatchingLocalitySummary(Number(survey.latitude), Number(survey.longitude), localities)

                const matchingScope = selectedLocalities.find((scope) => boundsContainPoint(scope, Number(survey.latitude), Number(survey.longitude), MAP_LOCALITY_PADDING_DEGREES))

                return [

                    'wpis',

                    survey.id || '',

                    survey.user_name || '',

                    getSurveyStatus(survey).label,

                    new Date(survey.created_at).toLocaleString('pl-PL'),

                    survey.address || '',

                    matchingLocality?.label || matchingScope?.label || '',

                    '',

                    '',

                    '',

                    survey.respondent_name || '',

                    Number(survey.latitude).toFixed(6),

                    Number(survey.longitude).toFixed(6),

                    `https://www.google.com/maps?q=${Number(survey.latitude).toFixed(6)},${Number(survey.longitude).toFixed(6)}`,

                    survey.address || matchingLocality?.label || matchingScope?.label || '',

                    getAttemptedNote(survey)

                ]

            }) : []



            const rows = [

                ['typ', 'id', 'pracownik', 'status', 'termin', 'adres', 'miejscowosc', 'parcel_id', 'nr_dzialki', 'napiecie', 'rodzaj', 'lat', 'lng', 'google_maps_url', 'sugerowana_lokalizacja', 'uwagi'],

                ...exportPoleRows,

                ...exportMeetingRows,

                ...exportSurveyRows

            ]



            const csvContent = rows.map((row) => row.map((value) => escapeCsvCell(value)).join(',')).join('\r\n')

            const scopeLabel =

                selectedLocalities.length === 1

                    ? selectedLocalities[0].label

                    : selectedLocalities.length > 1

                        ? `${selectedLocalities.length}_obszary`

                        : 'widok_mapy'

            downloadCsvFile(`globalna_mapa_${slugifyFilenamePart(scopeLabel)}_${dateFrom}_${dateTo}.csv`, csvContent)

            hotToast.success('Pobrano CSV z aktualnego widoku mapy.')

        } catch (error) {

            console.error('Failed to export global map data:', error)

            hotToast.error('Nie udało się pobrać danych z mapy.')

        } finally {

            setExportingCsv(false)

        }

    }



    const localityActionButtons = [

        { key: 'all', label: 'Wyczyść', className: adminSecondaryButtonClass, disabled: false, onClick: clearLocalitySelection },

        { key: 'select', label: 'Zaznacz wynik', className: adminInfoButtonClass, disabled: false, onClick: selectAllFilteredLocalities },

        { key: 'zoom', label: 'Przybliż', className: adminPrimaryButtonClass, disabled: selectedLocalities.length === 0, onClick: zoomToSelectedLocalities }

    ]

    const localityFilterButtons = [

        { key: 'all' as const, label: 'Wszystko', count: mapScopeOptions.filter((locality) => !shouldHideMapScopeOption(locality)).length },

        { key: 'county' as const, label: 'Powiaty', count: mapScopeOptions.filter((locality) => locality.scopeKind === 'county' && !shouldHideMapScopeOption(locality)).length },

        { key: 'municipality' as const, label: 'Gminy', count: derivedMunicipalityCount },

        { key: 'parcel' as const, label: 'Działki', count: parcelSearchResults.length },

        { key: 'locality' as const, label: 'Miejsc.', count: mapScopeOptions.filter((locality) => locality.scopeKind === 'locality' && !shouldHideMapScopeOption(locality)).length },

        { key: 'selected' as const, label: 'Zazn.', count: selectedLocalityCodeList.length }

    ]

    const visibleLocalityFilterButtons = localityFilterButtons.map((filter) =>
        filter.key === 'parcel'
            ? {
                  ...filter,
                  label: 'Dzialki',
                  count: localitySearch.trim().length >= 2 ? parcelSearchResults.length : 'szukaj'
              }
            : filter
    )

    const addressPresenceFilterButtons: Array<{ key: AddressPresenceFilter; label: string }> = [

        { key: 'all', label: 'Wszystkie' },

        { key: 'exact', label: 'Dokładne' },

        { key: 'missing', label: 'Bez dokładn.' }

    ]



    return (

        <div

            ref={mapShellRef}

            className={`${card} ${isFullscreen ? 'fixed inset-0 z-[2000] flex h-screen w-screen flex-col overflow-hidden rounded-none border-0 bg-slate-950 p-3' : 'p-4'}`}

        >

            <div className="mb-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">

                <div>

                    <h3 className="mb-1 text-xs font-black uppercase tracking-widest">Globalna Mapa Terenu</h3>

                    <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">

                        Wybierz miejscowość albo powiat oraz typ danych, a mapa i tabela działek zsynchronizują się automatycznie.

                    </p>

                </div>



                <div className="flex flex-wrap items-center gap-2">

                    <button

                        type="button"

                        onClick={() => { void exportCurrentMapData() }}

                        disabled={exportingCsv}

                        className={`${adminSuccessButtonClass} h-fit px-4 py-2 text-[10px] disabled:cursor-not-allowed disabled:opacity-50`}

                    >

                        {exportingCsv ? 'Pobieranie...' : 'Pobierz dane'}

                    </button>

                    <button

                        onClick={() => { void toggleFullscreen() }}

                        className="h-fit rounded-xl bg-slate-800 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white shadow-xl shadow-slate-900/10 transition-all hover:scale-105 active:scale-95 dark:bg-cyan-500 dark:shadow-cyan-500/10"

                    >

                        {isFullscreen ? 'Zamknij pełny ekran' : 'Pełny ekran'}

                    </button>

                </div>

            </div>



            <div className={`flex flex-col gap-4 ${isFullscreen ? 'h-full min-h-0 flex-1' : ''}`}>

                <div className={`min-w-0 flex min-h-0 flex-col ${isFullscreen ? 'flex-1' : ''}`}>

                    <div

                        className={`relative overflow-hidden rounded-2xl border border-gray-200/60 shadow-inner transition-all dark:border-slate-700 ${isFullscreen ? 'min-h-0 flex-1' : 'h-[480px] md:h-[780px]'}`}

                        style={{ background: '#e2e8f0' }}

                    >

                        <div ref={mapRef} className="h-full w-full z-0" />



                        {/* ---- Overlay controls inside map ---- */}

                        <div className="absolute top-3 right-3 z-1000 flex flex-col items-end gap-2" style={{ pointerEvents: 'none' }}>

                            <button

                                type="button"

                                onClick={() => setMapControlsOpen((v) => !v)}

                                className="rounded-xl border border-cyan-400/40 bg-slate-900/90 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-cyan-100 shadow-lg backdrop-blur-sm transition-all hover:bg-slate-800/95"

                                style={{ pointerEvents: 'auto' }}

                            >

                                {mapControlsOpen ? '✕ Zamknij' : '☰ Ustawienia'}

                            </button>



                            {mapControlsOpen && (

                                <div className="w-[340px] max-h-[calc(100%-56px)] overflow-y-auto rounded-2xl border border-cyan-500/15 bg-slate-900/95 p-3 shadow-2xl backdrop-blur-md" style={{ pointerEvents: 'auto' }}>

                                    {/* Layer toggles */}

                                    <p className="text-[9px] font-black uppercase tracking-[0.28em] text-cyan-300/80 mb-2">Warstwy</p>

                                    <div className="grid grid-cols-2 gap-1.5">

                                        <button type="button" onClick={() => setShowWorkerRoutes((value) => !value)} className={`rounded-lg border px-2 py-1.5 text-[9px] font-black uppercase tracking-widest transition-all ${showWorkerRoutes ? 'border-cyan-400/40 bg-cyan-500/20 text-cyan-100' : 'border-slate-700 bg-slate-900/70 text-slate-400'}`}>Trasy GPS</button>

                                        <button type="button" onClick={() => setShowWorkerMarkers((value) => !value)} className={`rounded-lg border px-2 py-1.5 text-[9px] font-black uppercase tracking-widest transition-all ${showWorkerMarkers ? 'border-cyan-400/40 bg-cyan-500/20 text-cyan-100' : 'border-slate-700 bg-slate-900/70 text-slate-400'}`}>Pracownicy</button>

                                        <button type="button" onClick={() => setShowSurveyMarkers((value) => !value)} className={`rounded-lg border px-2 py-1.5 text-[9px] font-black uppercase tracking-widest transition-all ${showSurveyMarkers ? 'border-violet-400/40 bg-violet-500/20 text-violet-100' : 'border-slate-700 bg-slate-900/70 text-slate-400'}`}>Wpisy</button>

                                        <button type="button" onClick={() => setShowMeetingMarkers((value) => !value)} className={`rounded-lg border px-2 py-1.5 text-[9px] font-black uppercase tracking-widest transition-all ${showMeetingMarkers ? 'border-amber-400/40 bg-amber-500/20 text-amber-100' : 'border-slate-700 bg-slate-900/70 text-slate-400'}`}>Spotkania</button>

                                        <button type="button" onClick={() => setShowParcelOverlay((value) => !value)} className={`rounded-lg border px-2 py-1.5 text-[9px] font-black uppercase tracking-widest transition-all ${showParcelOverlay ? 'border-emerald-400/40 bg-emerald-500/20 text-emerald-100' : 'border-slate-700 bg-slate-900/70 text-slate-400'}`}>Działki</button>

                                        <button type="button" onClick={() => setShowPowerPoles((value) => !value)} className={`rounded-lg border px-2 py-1.5 text-[9px] font-black uppercase tracking-widest transition-all ${showPowerPoles ? 'border-blue-400/40 bg-blue-500/20 text-blue-100' : 'border-slate-700 bg-slate-900/70 text-slate-400'}`}>Słupy</button>

                                        <button type="button" onClick={() => setShowPowerLines((value) => !value)} className={`col-span-2 rounded-lg border px-2 py-1.5 text-[9px] font-black uppercase tracking-widest transition-all ${showPowerLines ? 'border-blue-400/40 bg-blue-500/20 text-blue-100' : 'border-slate-700 bg-slate-900/70 text-slate-400'}`}>Linie energetyczne</button>

                                    </div>



                                    {/* Locality search */}

                                    <div className="mt-3 border-t border-slate-700/60 pt-3">

                                        <div className="flex items-center justify-between gap-2">

                                            <p className="text-[9px] font-black uppercase tracking-[0.28em] text-cyan-300/80">Obszary mapy</p>

                                            <span className="rounded-full border border-cyan-400/30 bg-cyan-500/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-cyan-100">

                                                {visibleSelectedLocalities.length} zazn.

                                            </span>

                                        </div>



                                        <input

                                            type="text"

                                            value={localitySearch}

                                            onChange={(event) => setLocalitySearch(event.target.value)}

                                            placeholder="Szukaj miejscowości, powiatu lub kodu..."

                                            className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900/80 px-2.5 py-2 text-xs font-semibold text-white outline-none transition-all placeholder:text-slate-500 focus:border-cyan-400/45"

                                        />



                                        <div className="mt-2 flex flex-wrap gap-1.5">

                                            {visibleLocalityFilterButtons.map((filter) => (

                                                <button

                                                    key={filter.key}

                                                    type="button"

                                                    onClick={() => setLocalityTypeFilter(filter.key)}

                                                    className={`whitespace-nowrap rounded-lg border px-2 py-1.5 text-[9px] font-black uppercase tracking-widest transition-all ${filter.key === localityTypeFilter ? 'border-cyan-400/45 bg-cyan-500/15 text-cyan-100' : 'border-slate-700 bg-slate-900/60 text-slate-400 hover:border-slate-500'}`}

                                                >

                                                    {filter.label} ({filter.count})

                                                </button>

                                            ))}

                                        </div>



                                        <div className="mt-3 space-y-2">

                                            <div>

                                                <p className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Filtr adresu</p>

                                                <div className="mt-2 flex flex-wrap gap-1.5">

                                                    {addressPresenceFilterButtons.map((filter) => (

                                                        <button

                                                            key={filter.key}

                                                            type="button"

                                                            onClick={() => setAddressPresenceFilter(filter.key)}

                                                            className={`whitespace-nowrap rounded-lg border px-2 py-1.5 text-[9px] font-black uppercase tracking-widest transition-all ${filter.key === addressPresenceFilter ? 'border-emerald-400/45 bg-emerald-500/15 text-emerald-100' : 'border-slate-700 bg-slate-900/60 text-slate-400 hover:border-slate-500'}`}

                                                        >

                                                            {filter.label}

                                                        </button>

                                                    ))}

                                                </div>

                                            </div>

                                            {selectedParcelSearchResult && (

                                                <div>

                                                    <p className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Filtr działki</p>

                                                    <div className="mt-2 flex flex-wrap gap-1.5">

                                                        <button

                                                            type="button"

                                                            onClick={() => zoomToParcelSearchResult(selectedParcelSearchResult)}

                                                            className="rounded-lg border border-cyan-400/45 bg-cyan-500/15 px-2 py-1.5 text-[9px] font-black uppercase tracking-widest text-cyan-100 transition-all hover:bg-cyan-500/20"

                                                        >

                                                            tylko {selectedParcelSearchResult.parcelNumber || selectedParcelSearchResult.id}

                                                        </button>

                                                        <button

                                                            type="button"

                                                            onClick={clearSelectedParcelSearchResult}

                                                            className="rounded-lg border border-slate-700 bg-slate-900/60 px-2 py-1.5 text-[9px] font-black uppercase tracking-widest text-slate-400 transition-all hover:border-slate-500"

                                                        >

                                                            wyczyść

                                                        </button>

                                                    </div>

                                                </div>

                                            )}

                                            {visibleSelectedLocalities.length > 0 && (

                                                <div>

                                                    <div className="flex items-center justify-between gap-2">

                                                        <p className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Zaznaczone obszary</p>

                                                        <button

                                                            type="button"

                                                            onClick={clearLocalitySelection}

                                                            className="text-[9px] font-black uppercase tracking-widest text-cyan-300 transition-colors hover:text-cyan-100"

                                                        >

                                                            Wyczyść

                                                        </button>

                                                    </div>

                                                    <div className="mt-2 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto pr-1">

                                                        {visibleSelectedLocalities.map((scope) => (

                                                            <button

                                                                key={`selected-scope-${scope.code}`}

                                                                type="button"

                                                                onClick={() => removeSelectedLocality(scope.code)}

                                                                className="rounded-full border border-cyan-400/30 bg-cyan-500/12 px-2.5 py-1 text-[9px] font-black uppercase tracking-widest text-cyan-100 transition-colors hover:bg-cyan-500/20"

                                                            >

                                                                {scope.label} ×

                                                            </button>

                                                        ))}

                                                    </div>

                                                </div>

                                            )}

                                            {selectedParcelSearchResult && (

                                                <div>

                                                    <div className="flex items-center justify-between gap-2">

                                                        <p className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Wybrana działka</p>

                                                        <button

                                                            type="button"

                                                            onClick={clearSelectedParcelSearchResult}

                                                            className="text-[9px] font-black uppercase tracking-widest text-cyan-300 transition-colors hover:text-cyan-100"

                                                        >

                                                            Wyczyść

                                                        </button>

                                                    </div>

                                                    <div className="mt-2 flex flex-wrap gap-1.5 overflow-y-auto pr-1">

                                                        <button

                                                            type="button"

                                                            onClick={() => zoomToParcelSearchResult(selectedParcelSearchResult)}

                                                            className="rounded-full border border-cyan-400/30 bg-cyan-500/12 px-2.5 py-1 text-[9px] font-black uppercase tracking-widest text-cyan-100 transition-colors hover:bg-cyan-500/20"

                                                        >

                                                            {selectedParcelSearchResult.parcelNumber || selectedParcelSearchResult.id}

                                                        </button>

                                                    </div>

                                                </div>

                                            )}

                                        </div>



                                        <div className="mt-2 max-h-52 space-y-1.5 overflow-y-auto pr-1">

                                            {(localityTypeFilter === 'all' || localityTypeFilter === 'parcel') && parcelSearchResults.length > 0 && (

                                                <div className="space-y-1.5 pb-1">

                                                    <p className="text-[8px] font-black uppercase tracking-[0.18em] text-amber-300/80">Działki</p>

                                                    {parcelSearchResults.map((parcel) => (

                                                        <button

                                                            key={`parcel-search-${parcel.id}`}

                                                            type="button"

                                                            onClick={() => zoomToParcelSearchResult(parcel)}

                                                            className={`flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-all ${selectedParcelSearchResult?.id === parcel.id ? 'border-cyan-400/40 bg-cyan-500/15 text-white shadow-sm shadow-cyan-500/10' : 'border-slate-700 bg-slate-900/70 text-slate-300 hover:border-slate-500'}`}

                                                        >

                                                            <div className="min-w-0">

                                                                <p className="truncate text-[10px] font-black uppercase tracking-widest">{parcel.parcelNumber || parcel.id}</p>

                                                                <p className={`mt-0.5 truncate text-[8px] font-semibold uppercase tracking-[0.18em] ${selectedParcelSearchResult?.id === parcel.id ? 'text-cyan-300/80' : 'text-slate-400'}`}>

                                                                    {[parcel.precinct || parcel.localityLabel, parcel.municipality, parcel.county].filter(Boolean).join(' | ')}

                                                                </p>

                                                            </div>

                                                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-black ${selectedParcelSearchResult?.id === parcel.id ? 'bg-white/15 text-cyan-100' : 'bg-slate-800 text-slate-300'}`}>

                                                                działka

                                                            </span>

                                                        </button>

                                                    ))}

                                                </div>

                                            )}

                                            {filteredLocalities.slice(0, 160).map((locality) => {

                                                const active = selectedLocalityCodeList.includes(locality.code)

                                                return (

                                                    <button

                                                        key={locality.code}

                                                        type="button"

                                                        onClick={(event) => handleToggleLocalityClick(locality.code, event)}

                                                        className={`flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left outline-none transition-all focus:outline-none focus-visible:outline-none focus-visible:ring-0 ${

                                                            active

                                                                ? 'border-cyan-400/40 bg-cyan-500/15 text-white shadow-sm shadow-cyan-500/10'

                                                                : 'border-slate-700 bg-slate-900/70 text-slate-300 hover:border-slate-500'

                                                        }`}

                                                    >

                                                        <div className="min-w-0">

                                                            <p className="truncate text-[10px] font-black uppercase tracking-widest">{locality.label}</p>

                                                            {locality.badgeLabel && (

                                                                <p className="mt-0.5 truncate text-[8px] font-semibold uppercase tracking-[0.18em] text-cyan-300/80">

                                                                    {locality.badgeLabel}

                                                                </p>

                                                            )}

                                                            {locality.offlineSummary && (

                                                                <p className="mt-0.5 truncate text-[8px] font-semibold uppercase tracking-[0.18em] text-emerald-300/80">

                                                                    {locality.offlineSummary}

                                                                </p>

                                                            )}

                                                        </div>

                                                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-black ${active ? 'bg-white/15 text-cyan-100' : 'bg-slate-800 text-slate-300'}`}>

                                                            {getMapScopeTypeLabel(locality)}

                                                        </span>

                                                    </button>

                                                )

                                            })}

                                            {localityTypeFilter === 'parcel' && parcelSearchResults.length === 0 && localitySearch.trim().length < 2 && (

                                                <div className="rounded-lg border border-dashed border-slate-700 bg-slate-900/60 px-3 py-3 text-center text-[10px] font-bold text-slate-400">

                                                    Wpisz numer dzialki, np. 1583/6.

                                                </div>

                                            )}

                                            {localityTypeFilter === 'parcel' && localitySearch.trim().length >= 2 && parcelSearchResults.length === 0 && (

                                                <div className="rounded-lg border border-dashed border-slate-700 bg-slate-900/60 px-3 py-3 text-center text-[10px] font-bold text-slate-400">

                                                    Brak dzialek dla podanej frazy.

                                                </div>

                                            )}

                                            {localityTypeFilter !== 'parcel' && filteredLocalities.length === 0 && parcelSearchResults.length === 0 && (

                                                <div className="rounded-lg border border-dashed border-slate-700 bg-slate-900/60 px-3 py-3 text-center text-[10px] font-bold text-slate-400">

                                                    Brak obszarów dla podanej frazy.

                                                </div>

                                            )}

                                        </div>

                                    </div>

                                </div>

                            )}

                        </div>

                    </div>

                </div>



                {/* ---- Legend + workers below map ---- */}

                {!isFullscreen && (
                <div className="rounded-2xl border border-slate-200 bg-white/95 dark:border-slate-700/60 dark:bg-slate-900/80 px-5 py-4 space-y-3">

                    {/* Workers row */}

                    <div>

                        <p className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-400 dark:text-slate-500 mb-2">Pracownicy</p>

                        <div className="flex flex-wrap items-center gap-2">

                            {workers.map((worker) => {

                                const isCurrentlyActive = Boolean(worker.activeShift && dateTo === todayISO && dateFrom <= todayISO)

                                const hasActivity =

                                    worker.todaySurveys > 0 ||

                                    Boolean(worker.lastGps && worker.lastGps.timestamp >= rangeFrom && worker.lastGps.timestamp <= rangeTo)

                                const statusColor = isCurrentlyActive ? 'bg-green-500 animate-pulse' : (hasActivity ? 'bg-red-500' : 'bg-slate-400')



                                return (

                                    <button

                                        key={worker.user.id}

                                        onClick={() => toggleWorker(worker.user.id!)}

                                        className={`flex items-center gap-2 rounded-xl border px-3 py-1.5 text-[10px] font-black uppercase tracking-tighter transition-all ${

                                            visibleWorkers.has(worker.user.id!)

                                                ? 'border-cyan-400/30 bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-white shadow-sm ring-1 ring-400/15'

                                                : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/70 text-slate-400 dark:text-slate-500 opacity-55'

                                        }`}

                                    >

                                        <span className={`h-2 w-2 rounded-full ${statusColor}`} />

                                        {worker.user.name} ({worker.todaySurveys})

                                    </button>

                                )

                            })}



                            <div className="ml-auto flex items-center gap-2">

                                <span className="flex items-center gap-1.5 rounded-full bg-green-100 dark:bg-slate-800 border border-green-200 dark:border-slate-700 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-green-700 dark:text-slate-300"><span className="block h-2 w-2 shrink-0 rounded-full bg-green-500 shadow-sm shadow-green-500/50 animate-pulse" /> Aktywny</span>

                                <span className="flex items-center gap-1.5 rounded-full bg-red-100 dark:bg-slate-800 border border-red-200 dark:border-slate-700 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-red-700 dark:text-slate-300"><span className="block h-2 w-2 shrink-0 rounded-full bg-red-500 shadow-sm shadow-red-500/50" /> Skończył</span>

                                <span className="flex items-center gap-1.5 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-slate-500 dark:text-slate-300"><span className="block h-2 w-2 shrink-0 rounded-full bg-slate-400 shadow-sm shadow-slate-400/50" /> Offline</span>

                            </div>

                        </div>

                    </div>



                    {/* Meeting status legend */}

                    <div>

                        <p className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-400 dark:text-slate-500 mb-2">Statusy spotkań</p>

                        <div className="flex flex-wrap gap-2">

                            {MAP_MEETING_LEGEND_ITEMS.map((item) => (

                                <span

                                    key={item.key}

                                    className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-black ${item.className}`}

                                >

                                    <span className="font-black">{item.glyph}</span>

                                    {item.label}

                                </span>

                            ))}

                        </div>

                    </div>

                </div>
                )}

            </div>



            {mapScopeDialogOpen && (

                <div className="fixed inset-0 z-1200 flex items-center justify-center p-4">

                    <div

                        className="ui-modal-backdrop absolute inset-0 bg-slate-950/70 backdrop-blur-sm"

                        onClick={closeMapScopeDialog}

                    />

                    <div className="relative w-full max-w-5xl rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-900">

                        <div className="flex items-start justify-between gap-4">

                            <div>

                                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-cyan-500">Zakres mapy</p>

                                <h3 className="mt-2 text-xl font-black text-slate-900 dark:text-white">Wybierz obszar i dane mapy</h3>

                                <p className="mt-2 max-w-3xl text-sm font-semibold text-slate-500 dark:text-slate-300">

                                    Wybór działa od razu. Wskaż miejscowość albo powiat i zaznacz, jakie dane mają być widoczne na mapie oraz w synchronizacji tabeli działek.

                                </p>

                            </div>



                            <button

                                type="button"

                                onClick={closeMapScopeDialog}

                                className="rounded-xl border border-slate-200 bg-slate-100 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-slate-500 transition-all hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"

                            >

                                Zamknij

                            </button>

                        </div>



                        <div className="mt-4 flex flex-wrap gap-2">

                            <span className="rounded-full border border-cyan-300/40 bg-cyan-500/10 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-cyan-600 dark:text-cyan-200">

                                {selectedLocalities.length} obszary

                            </span>

                            <span className={`rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest ${hasAnyMapDataSelected ? 'border-emerald-300/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-200' : 'border-amber-300/40 bg-amber-500/10 text-amber-600 dark:text-amber-200'}`}>

                                {hasAnyMapDataSelected ? 'Dane wybrane' : 'Wybierz dane'}

                            </span>

                            <span className={`rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest ${shouldLoadScopedMapData ? 'border-emerald-300/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-200' : 'border-slate-300/40 bg-slate-500/10 text-slate-500 dark:text-slate-300'}`}>

                                {shouldLoadScopedMapData ? 'Mapa aktywna' : 'Wybierz obszar'}

                            </span>

                        </div>



                        <div className="mt-5 grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">

                            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-950/60">

                                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-slate-400">Jakie dane wczytać</p>

                                <div className="mt-3 grid grid-cols-2 gap-2">

                                    <button type="button" onClick={() => setShowWorkerRoutes((value) => !value)} className={`rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-all ${showWorkerRoutes ? 'border-cyan-400/40 bg-cyan-500/15 text-cyan-700 dark:text-cyan-100' : 'border-slate-300 bg-white text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400'}`}>Trasy GPS</button>

                                    <button type="button" onClick={() => setShowWorkerMarkers((value) => !value)} className={`rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-all ${showWorkerMarkers ? 'border-cyan-400/40 bg-cyan-500/15 text-cyan-700 dark:text-cyan-100' : 'border-slate-300 bg-white text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400'}`}>Pracownicy</button>

                                    <button type="button" onClick={() => setShowSurveyMarkers((value) => !value)} className={`rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-all ${showSurveyMarkers ? 'border-violet-400/40 bg-violet-500/15 text-violet-700 dark:text-violet-100' : 'border-slate-300 bg-white text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400'}`}>Wpisy</button>

                                    <button type="button" onClick={() => setShowMeetingMarkers((value) => !value)} className={`rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-all ${showMeetingMarkers ? 'border-amber-400/40 bg-amber-500/15 text-amber-700 dark:text-amber-100' : 'border-slate-300 bg-white text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400'}`}>Spotkania</button>

                                    <button type="button" onClick={() => setShowParcelOverlay((value) => !value)} className={`rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-all ${showParcelOverlay ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-100' : 'border-slate-300 bg-white text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400'}`}>Działki</button>

                                    <button type="button" onClick={() => setShowPowerPoles((value) => !value)} className={`rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-all ${showPowerPoles ? 'border-blue-400/40 bg-blue-500/15 text-blue-700 dark:text-blue-100' : 'border-slate-300 bg-white text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400'}`}>Słupy</button>

                                    <button type="button" onClick={() => setShowPowerLines((value) => !value)} className={`col-span-2 rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-all ${showPowerLines ? 'border-blue-400/40 bg-blue-500/15 text-blue-700 dark:text-blue-100' : 'border-slate-300 bg-white text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400'}`}>Linie energetyczne</button>

                                </div>



                                <div className="mt-4 rounded-2xl border border-slate-200 bg-white px-3 py-3 dark:border-slate-700 dark:bg-slate-900">

                                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Eksport pobierze</p>

                                    <p className="mt-2 text-xs font-semibold text-slate-600 dark:text-slate-300">

                                        {hasAnyExportDataSelected

                                            ? [

                                                showPowerPoles ? 'słupy' : null,

                                                showMeetingMarkers ? 'spotkania' : null,

                                                showSurveyMarkers ? 'wpisy' : null

                                            ].filter(Boolean).join(', ')

                                            : 'nic jeszcze nie wybrano do eksportu'}

                                    </p>

                                </div>

                            </div>



                            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-950/60">

                                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">

                                    <div>

                                        <p className="text-[10px] font-black uppercase tracking-[0.24em] text-slate-400">Miejscowości i powiaty</p>

                                        <p className="mt-1 text-xs font-semibold text-slate-500 dark:text-slate-300">

                                            Wybierz miasto, miejscowość albo powiat, dla którego mapa ma wczytać dane.

                                        </p>

                                    </div>



                                    <div className="grid grid-cols-3 gap-2 sm:w-[320px]">

                                        {localityActionButtons.map((action) => (

                                            <button

                                                key={action.key}

                                                type="button"

                                                onClick={action.onClick}

                                                disabled={action.disabled}

                                                className={`${action.className} px-2 py-2 text-[9px] disabled:cursor-not-allowed disabled:opacity-45`}

                                            >

                                                {action.label}

                                            </button>

                                        ))}

                                    </div>

                                </div>



                                <input

                                    type="text"

                                    value={localitySearch}

                                    onChange={(event) => setLocalitySearch(event.target.value)}

                                    placeholder="Szukaj miejscowości, powiatu lub kodu..."

                                    className="mt-4 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm font-semibold text-slate-900 outline-none transition-all placeholder:text-slate-400 focus:border-cyan-400/60 dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:placeholder:text-slate-500"

                                />



                                <div className="mt-4 flex flex-wrap gap-2">

                                    {visibleLocalityFilterButtons.map((filter) => {

                                        const active = localityTypeFilter === filter.key

                                        return (

                                            <button

                                                key={filter.key}

                                                type="button"

                                                onClick={() => setLocalityTypeFilter(filter.key)}

                                                className={`whitespace-nowrap rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-all ${active ? 'border-cyan-400/50 bg-cyan-500/15 text-slate-900 shadow-sm dark:text-white' : 'border-slate-300 bg-white text-slate-500 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:border-slate-500'}`}

                                            >

                                                {filter.label} ({filter.count})

                                            </button>

                                        )

                                    })}

                                </div>



                                <div className="mt-4 space-y-3">

                                    <div>

                                        <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Filtr adresu na mapie</p>

                                        <div className="mt-2 flex flex-wrap gap-2">

                                            {addressPresenceFilterButtons.map((filter) => {

                                                const active = addressPresenceFilter === filter.key

                                                return (

                                                    <button

                                                        key={`dialog-address-filter-${filter.key}`}

                                                        type="button"

                                                        onClick={() => setAddressPresenceFilter(filter.key)}

                                                        className={`whitespace-nowrap rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-all ${active ? 'border-emerald-400/50 bg-emerald-500/15 text-slate-900 shadow-sm dark:text-white' : 'border-slate-300 bg-white text-slate-500 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:border-slate-500'}`}

                                                    >

                                                        {filter.label}

                                                    </button>

                                                )

                                            })}

                                        </div>

                                    </div>

                                    {selectedLocalities.length > 0 && (

                                        <div>

                                            <div className="flex items-center justify-between gap-2">

                                                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Zaznaczone obszary</p>

                                                <button

                                                    type="button"

                                                    onClick={clearLocalitySelection}

                                                    className="text-[10px] font-black uppercase tracking-widest text-cyan-500 transition-colors hover:text-cyan-400"

                                                >

                                                    Wyczyść wszystko

                                                </button>

                                            </div>

                                            <div className="mt-2 flex max-h-28 flex-wrap gap-2 overflow-y-auto pr-1">

                                                {selectedLocalities.map((scope) => (

                                                    <button

                                                        key={`dialog-selected-scope-${scope.code}`}

                                                        type="button"

                                                        onClick={() => removeSelectedLocality(scope.code)}

                                                        className="rounded-full border border-cyan-400/35 bg-cyan-500/12 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-cyan-700 transition-all hover:bg-cyan-500/20 dark:text-cyan-100"

                                                    >

                                                        {scope.label} ×

                                                    </button>

                                                ))}

                                            </div>

                                        </div>

                                    )}

                                </div>



                                <div className="mt-4 grid max-h-[360px] gap-2 overflow-y-auto pr-1 sm:grid-cols-2 xl:grid-cols-3">

                                    {(localityTypeFilter === 'all' || localityTypeFilter === 'parcel') && parcelSearchResults.map((parcel) => (

                                        <button

                                            key={`dialog-parcel-search-${parcel.id}`}

                                            type="button"

                                            onClick={() => zoomToParcelSearchResult(parcel)}

                                            className="rounded-2xl border border-amber-300 bg-amber-50 px-3 py-3 text-left transition-all hover:border-amber-400 dark:border-amber-500/30 dark:bg-amber-500/10"

                                        >

                                            <div className="flex items-start justify-between gap-2">

                                                <div className="min-w-0">

                                                    <p className="truncate text-[11px] font-black uppercase tracking-widest text-amber-900 dark:text-amber-100">{parcel.parcelNumber || parcel.id}</p>

                                                    <p className="mt-1 truncate text-[9px] font-semibold uppercase tracking-[0.18em] text-amber-700 dark:text-amber-300">

                                                        {[parcel.precinct || parcel.localityLabel, parcel.municipality, parcel.county].filter(Boolean).join(' | ')}

                                                    </p>

                                                </div>

                                                <span className="shrink-0 rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-black text-amber-900 dark:bg-amber-500/20 dark:text-amber-100">

                                                    działka

                                                </span>

                                            </div>

                                        </button>

                                    ))}

                                    {filteredLocalities.slice(0, 180).map((locality) => {

                                        const active = selectedLocalityCodeList.includes(locality.code)

                                        return (

                                            <button

                                                key={locality.code}

                                                type="button"

                                                onClick={(event) => handleToggleLocalityClick(locality.code, event)}

                                                className={`rounded-2xl border px-3 py-3 text-left outline-none transition-all focus:outline-none focus-visible:outline-none focus-visible:ring-0 ${active ? 'border-cyan-400/50 bg-cyan-500/15 text-slate-900 shadow-sm dark:text-white' : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-slate-500'}`}

                                            >

                                                <div className="flex items-start justify-between gap-2">

                                                    <div className="min-w-0">

                                                        <p className="truncate text-[11px] font-black uppercase tracking-widest">{locality.label}</p>

                                                        {locality.badgeLabel && (

                                                            <p className="mt-1 truncate text-[9px] font-semibold uppercase tracking-[0.18em] text-cyan-500 dark:text-cyan-300">

                                                                {locality.badgeLabel}

                                                            </p>

                                                        )}

                                                        {locality.offlineSummary && (

                                                            <p className="mt-1 truncate text-[9px] font-semibold uppercase tracking-[0.18em] text-emerald-500 dark:text-emerald-300">

                                                                {locality.offlineSummary}

                                                            </p>

                                                        )}

                                                    </div>

                                                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black ${active ? 'bg-white/60 text-cyan-700 dark:bg-white/10 dark:text-cyan-100' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300'}`}>

                                                        {getMapScopeTypeLabel(locality)}

                                                    </span>

                                                </div>

                                            </button>

                                        )

                                    })}



                                    {localityTypeFilter === 'parcel' && parcelSearchResults.length === 0 && localitySearch.trim().length < 2 && (

                                        <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm font-semibold text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">

                                            Wpisz numer dzialki, np. 1583/6.

                                        </div>

                                    )}



                                    {localityTypeFilter === 'parcel' && localitySearch.trim().length >= 2 && parcelSearchResults.length === 0 && (

                                        <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm font-semibold text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">

                                            Brak dzialek dla podanej frazy.

                                        </div>

                                    )}



                                    {localityTypeFilter !== 'parcel' && filteredLocalities.length === 0 && parcelSearchResults.length === 0 && (

                                        <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm font-semibold text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">

                                            Brak obszarów dla podanej frazy.

                                        </div>

                                    )}

                                </div>

                            </div>

                        </div>



                        <div className="mt-5 flex flex-col gap-3 border-t border-slate-200 pt-4 dark:border-slate-700 sm:flex-row sm:items-center sm:justify-between">

                            <p className="text-xs font-semibold text-slate-500 dark:text-slate-300">

                                Nie trzeba juz nic osobno wczytywac. Po zmianie obszaru albo danych mapa i tabela dzialek synchronizuja sie automatycznie.

                            </p>



                            <div className="flex flex-wrap gap-2">

                                {shouldLoadScopedMapData && (

                                    <button

                                        type="button"

                                        onClick={closeMapScopeDialog}

                                        className={`${adminSecondaryButtonClass} px-4 py-2 text-[10px]`}

                                    >

                                        Zostaw bieżący zakres

                                    </button>

                                )}

                                <button

                                    type="button"

                                    onClick={applyMapScopeSelection}

                                    disabled={!canApplyMapScope}

                                    className="hidden"

                                >

                                    Wczytaj dane dla wyboru

                                </button>

                            </div>

                        </div>

                    </div>

                </div>

            )}

        </div>

    )

}



export function WorkerDetailsView({ worker, surveys, allGps, allShifts, dateFrom, dateTo, dateControl, onBack, onDeleteSurvey }: { worker: WS, surveys: Survey[], allGps: GpsLog[], allShifts: Shift[], dateFrom: string, dateTo: string, dateControl?: React.ReactNode, onBack: () => void, onDeleteSurvey?: (id: number | string, label: string) => void }) {

    const mapRef = useRef<HTMLDivElement>(null)

    const mapInst = useRef<L.Map | null>(null)

    const [expanded, setExpanded] = useState<string | null>(null)

    const [elapsed, setElapsed] = useState('00:00:00')

    const hasCenteredRef = useRef(false)

    const markersLayerRef = useRef<L.LayerGroup | null>(null)

    const [selectedShiftId, setSelectedShiftId] = useState<number | null>(worker.activeShift?.id || null)



    const workerShifts = useMemo(() => 

        [...allShifts].filter(s => s.user_id === worker.user.id).sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime()),

        [allShifts, worker.user.id]

    )



    const now = useMemo(() => new Date(), [])

    const selectedRangeFrom = useMemo(() => `${dateFrom}T00:00:00`, [dateFrom])

    const selectedRangeTo = useMemo(() => `${dateTo}T23:59:59`, [dateTo])

    const selectedRangeLabel = useMemo(() => {

        const fromLabel = new Date(`${dateFrom}T00:00:00`).toLocaleDateString('pl-PL')

        const toLabel = new Date(`${dateTo}T00:00:00`).toLocaleDateString('pl-PL')

        return fromLabel === toLabel ? fromLabel : `${fromLabel} - ${toLabel}`

    }, [dateFrom, dateTo])



    const filteredShifts = useMemo(() => {

        return workerShifts.filter((shift) => shift.start_time >= selectedRangeFrom && shift.start_time <= selectedRangeTo)

    }, [workerShifts, selectedRangeFrom, selectedRangeTo])

    const visibleSelectedShiftId = useMemo(() => {

        if (selectedShiftId === null) return null

        return filteredShifts.some((shift) => shift.id === selectedShiftId) ? selectedShiftId : null

    }, [filteredShifts, selectedShiftId])



    // Usunieto funkcje clearDayData

    const workerSurveys = useMemo(() => surveys.filter(s => s.user_id === worker.user.id).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()), [surveys, worker.user.id])



    // Group by date

    type DayGroup = { dateLabel: string; shifts: typeof filteredShifts; totalMs: number; totalSurveys: number }

    const { groupedByDay, filteredSurveyCount } = useMemo(() => {

        const groups: DayGroup[] = []

        const map: Record<string, DayGroup> = {}

        let count = 0

        filteredShifts.forEach(s => {

            const dayKey = new Date(s.start_time).toLocaleDateString('pl-PL')

            if (!map[dayKey]) {

                const grp: DayGroup = { dateLabel: dayKey, shifts: [], totalMs: 0, totalSurveys: 0 }

                map[dayKey] = grp

                groups.push(grp)

            }

            map[dayKey].shifts.push(s)

            const shiftSurveys = workerSurveys.filter(sv => sv.shift_id === s.id)

            map[dayKey].totalSurveys += shiftSurveys.length

            count += shiftSurveys.length

            const end = s.end_time ? new Date(s.end_time).getTime() : now.getTime()

            map[dayKey].totalMs += end - new Date(s.start_time).getTime()

        })

        return { groupedByDay: groups, filteredSurveyCount: count }

    }, [filteredShifts, workerSurveys, now])



    // We get GPS specific to this shift, or last 10 points if no active shift

    const userGpsAll = useMemo(() => allGps.filter(g => g.user_id === worker.user.id).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()), [allGps, worker.user.id])

    

    // Use selected shift GPS or fall back to active shift / current date

    const todayISO = useMemo(() => new Date().toISOString().split('T')[0], [])

    const workerGps = useMemo(() => {

        return visibleSelectedShiftId !== null

            ? userGpsAll.filter(g => g.shift_id === visibleSelectedShiftId)

            : (worker.activeShift && dateTo === todayISO && dateFrom <= todayISO

                ? userGpsAll.filter(g => g.shift_id === worker.activeShift!.id)

                : userGpsAll.filter(g => g.timestamp >= `${dateFrom}T00:00:00` && g.timestamp <= `${dateTo}T23:59:59`))

    }, [visibleSelectedShiftId, userGpsAll, worker.activeShift, dateTo, todayISO, dateFrom])



    const lastPoint = useMemo(() => {

        return visibleSelectedShiftId !== null && visibleSelectedShiftId !== worker.activeShift?.id

            ? (workerGps.length > 0 ? workerGps[workerGps.length - 1] : null)

            : (userGpsAll.length > 0 ? userGpsAll[userGpsAll.length - 1] : null)

    }, [visibleSelectedShiftId, worker.activeShift, workerGps, userGpsAll])

    const activitySummary = useMemo(() => getWorkerActivitySummary(worker, dateFrom, dateTo), [worker, dateFrom, dateTo])





    useEffect(() => {

        if (!worker.activeShift) return

        const start = new Date(worker.activeShift.start_time).getTime()

        const update = () => {

            const diff = Date.now() - start

            const h = String(Math.floor(diff / 3600000)).padStart(2, '0')

            const m = String(Math.floor((diff % 3600000) / 60000)).padStart(2, '0')

            const s = String(Math.floor((diff % 60000) / 1000)).padStart(2, '0')

            setElapsed(`${h}:${m}:${s}`)

        }

        update()

        const int = setInterval(update, 1000)

        return () => clearInterval(int)

    }, [worker.activeShift])



    const workerSurveysRef = useRef(workerSurveys)

    const workerGpsRef = useRef(workerGps)

    useEffect(() => {

        workerSurveysRef.current = workerSurveys

        workerGpsRef.current = workerGps

    }, [workerSurveys, workerGps])

    const initialLastPointRef = useRef(lastPoint)



    // 1. Initialize Map instance

    useEffect(() => {

        if (!mapRef.current) return



        // Destroy previous map if container changed (inline - modal)

        if (mapInst.current) {

            mapInst.current.remove()

            mapInst.current = null

            markersLayerRef.current = null

        }



        const initialPoint = initialLastPointRef.current

        const defaultPos: [number, number] = initialPoint ? [initialPoint.latitude, initialPoint.longitude] : [50.89, 20.70]

        const map = L.map(mapRef.current, { zoomControl: false, attributionControl: false }).setView(defaultPos, initialPoint ? 16 : 13)

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map)

        mapInst.current = map

        markersLayerRef.current = L.layerGroup().addTo(map)



        setTimeout(() => map.invalidateSize(), 300)



        // Detect user interaction to stop auto-centering

        const stopAuto = () => { hasCenteredRef.current = true }

        map.on('movestart', stopAuto)

        map.on('zoomstart', stopAuto)



        return () => {

            if (mapInst.current) {

                mapInst.current.remove()

                mapInst.current = null

                markersLayerRef.current = null

            }

        }

    }, [])



    const dataHash = useMemo(() => {

        const g = [...workerGps].map(gx => gx.id).sort()

        const s = [...workerSurveys].map(sx => `${sx.id}-${sx.status}`).sort()

        return JSON.stringify({

            g, s,

            sh: visibleSelectedShiftId,

            lp: lastPoint ? `${lastPoint.latitude},${lastPoint.longitude}` : ''

        })

    }, [workerGps, workerSurveys, visibleSelectedShiftId, lastPoint])



    // 2. Update Data Layers (GPS, Surveys) on stable map

    useEffect(() => {

        const map = mapInst.current

        const layer = markersLayerRef.current

        if (!map || !layer) return



        layer.clearLayers()

        const b = L.latLngBounds([])

        let hasPoints = false

        const visibleSurveys = visibleSelectedShiftId !== null 

            ? workerSurveysRef.current.filter(s => s.shift_id === visibleSelectedShiftId)

            : workerSurveysRef.current.filter(s => s.created_at >= `${dateFrom}T00:00:00` && s.created_at <= `${dateTo}T23:59:59`)

        const displayRoute = buildDisplayRoute(workerGpsRef.current, visibleSurveys)



        if (displayRoute.length > 0) {

            if (displayRoute.length > 1) {

                L.polyline(displayRoute, { color: '#ffffff', weight: 7, opacity: 0.6, lineCap: 'round' }).addTo(layer)

                L.polyline(displayRoute, { color: '#f59e0b', weight: 4, opacity: 0.95, lineCap: 'round' }).addTo(layer)

            }

            if (displayRoute.length > 1) {

                L.circleMarker(displayRoute[0], { color: 'green', fillColor: 'green', radius: 6, fillOpacity: 1 }).addTo(layer).bindPopup('Start trasy')

            }

            if (lastPoint) {

                const isCurrentlyActive = worker.activeShift && dateTo === todayISO && dateFrom <= todayISO

                const rangeFrom = `${dateFrom}T00:00:00`

                const rangeTo = `${dateTo}T23:59:59`

                const hasActivityInRange = worker.totalSurveys > 0 || (lastPoint && lastPoint.timestamp >= rangeFrom && lastPoint.timestamp <= rangeTo)

                

                const markerColor = isCurrentlyActive ? '#10b981' : (hasActivityInRange ? '#ef4444' : '#94a3b8')



                L.circleMarker([lastPoint.latitude, lastPoint.longitude], { radius: 8, fillColor: markerColor, fillOpacity: 1, color: 'white', weight: 3 }).addTo(layer).bindPopup(isCurrentlyActive ? 'Aktualna pozycja' : (hasActivityInRange ? 'Ostatnia znana pozycja' : 'Punkt startowy / Brak aktywności')).bindTooltip(`${worker.user.name} (${worker.todaySurveys})`, { permanent: true, direction: 'top', offset: [0, -10], className: 'worker-label-tooltip' })

                b.extend([lastPoint.latitude, lastPoint.longitude])

            }

            displayRoute.forEach((p) => b.extend(p))

            hasPoints = true

        }



        const dedupedSurveys: Survey[] = dedupeSurveys(

            visibleSurveys.filter((s) => typeof s.latitude === 'number' && typeof s.longitude === 'number')

        );

        const surveyPoleBounds = mergeBounds(

            dedupedSurveys.map((survey) => ({

                south: Number(survey.latitude),

                west: Number(survey.longitude),

                north: Number(survey.latitude),

                east: Number(survey.longitude)

            }))

        )



        const renderWorkerSurveys = async () => {

            const allLocalPoles = (await fetchAllLocalPoles(surveyPoleBounds || undefined)).filter((pole) => pole.type !== 'station')



            const snapped = snapToNearestAvailablePole(

                dedupedSurveys.map((s) => ({

                    survey: s,

                    lat: Number(s.latitude),

                    lng: Number(s.longitude)

                })),

                allLocalPoles,

                30

            )



            const spread = spreadOverlappingMarkers(snapped, 9)

            spread.forEach(item => {

                const s = item.survey



                const surveyStatus = getSurveyStatus(s)

                const color = surveyStatus.markerColor

                const iconChar = surveyStatus.markerChar

                const attemptedNote = getAttemptedNote(s)

                const noteLine = attemptedNote ? `<br/>Notatka: ${escapeHtml(attemptedNote)}` : ''



                const icon = L.divIcon({

                    className: 'survey-marker-v2',

                    html: `<div style="background-color: ${color}; width: 26px; height: 26px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 6px rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; font-size: 14px; color: white; font-weight: bold;">${iconChar}</div>`,

                    iconSize: [26, 26],

                    iconAnchor: [13, 13]

                })

                L.marker([item.renderLat, item.renderLng], { icon, zIndexOffset: 500 }).addTo(layer).bindPopup(`<strong>Spotkanie</strong><br/>Status: ${surveyStatus.label}<br/>Adres: ${s.address || 'Brak'}<br/>Pracownik: ${worker.user.name}<br/>Klient: ${s.respondent_name || 'Brak'}<br/>Godzina: ${new Date(s.created_at).toLocaleTimeString('pl-PL')}${noteLine}`)

                b.extend([item.renderLat, item.renderLng])

                hasPoints = true

            })



            if (hasPoints && !hasCenteredRef.current) {

                if (lastPoint && (visibleSelectedShiftId === null || visibleSelectedShiftId === worker.activeShift?.id)) {

                    mapInst.current?.setView([lastPoint.latitude, lastPoint.longitude], 16)

                } else if (b.isValid()) {

                    mapInst.current?.fitBounds(b, { padding: [40, 40], maxZoom: 16 })

                }

                hasCenteredRef.current = true

            }

        }

        

        renderWorkerSurveys()

    }, [dataHash, visibleSelectedShiftId, lastPoint, dateFrom, dateTo, worker.activeShift, worker.user.name, todayISO, worker.totalSurveys, worker.todaySurveys])





    // Cleanup map on unmount

    useEffect(() => {

        return () => {

            if (mapInst.current) {

                mapInst.current.remove()

                mapInst.current = null

                markersLayerRef.current = null

            }

        }

    }, [])



    return (

        <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} className="space-y-6">

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">

                <button onClick={onBack} className="group text-sm font-black text-cyan-500 hover:text-cyan-600 flex items-center gap-2 transition-all">

                    <span className="bg-cyan-500 text-white w-8 h-8 rounded-xl flex items-center justify-center group-hover:-translate-x-1 transition-transform shadow-lg shadow-cyan-500/20">{'\u2190'}</span>

                    Powrót do listy

                </button>

                {dateControl && <div className="w-full sm:w-auto">{dateControl}</div>}

            </div>



            <div className="space-y-6">

                {/* Visual Status Card */}

                <div className={`${card} p-6 relative overflow-hidden group`}>

                    <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:scale-110 transition-transform duration-700">

                        <svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>

                    </div>

                    <h3 className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-6">Status Operacyjny</h3>



                    <div className="flex flex-col xl:flex-row xl:items-stretch gap-6 xl:gap-8">

                        <div className="flex-1 min-w-0 xl:pr-2">

                                    <div className="flex items-center gap-4 mb-5">

                                        <div className="w-14 h-14 bg-cyan-500 text-white rounded-2xl flex items-center justify-center text-lg font-black shadow-lg shadow-cyan-500/20 shrink-0">

                                            {worker.user.name.split(' ').map((n) => n[0]).join('')}

                                        </div>

                                        <div className="min-w-0">

                                    <p className="text-xl font-black text-slate-800 dark:text-white truncate">{worker.user.name}</p>

                                    <div className="flex flex-col sm:flex-row sm:items-center gap-2 mt-2">

                                        <span className={`text-[10px] font-black px-2.5 py-1.5 rounded-xl uppercase tracking-wider inline-flex items-center justify-center border ${activitySummary.badgeClass}`}>

                                            {activitySummary.statusLabel}

                                        </span>

                                        {activitySummary.timeLabel && (

                                            <span className="bg-slate-50 dark:bg-slate-800/40 px-2.5 py-1.5 rounded-xl border border-slate-200/50 dark:border-slate-700/50 flex items-center gap-2 shadow-sm text-[10px] font-black text-slate-600 dark:text-slate-300 uppercase tracking-tight">

                                                <span className="text-[11px] opacity-60">{'\u{1F553}'}</span>

                                                {activitySummary.timeLabel}

                                            </span>

                                        )}

                                    </div>



                                    {activitySummary.detailLabel && (

                                        <div className={`mt-3 flex max-w-full items-center gap-2 rounded-2xl border px-3 py-2 text-[11px] font-black leading-snug ${activitySummary.detailClass}`}>

                                            <span className="shrink-0 rounded-full bg-white/70 px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.16em] text-current dark:bg-slate-950/20">

                                                {activitySummary.detailTag}

                                            </span>

                                            <span className="wrap-break-word">{activitySummary.detailLabel}</span>

                                        </div>

                                    )}

                                </div>

                            </div>



                            {worker.activeShift ? (

                                <div className="space-y-1">

                                    <p className="text-4xl font-black text-cyan-500 tracking-tighter">{elapsed}</p>

                                    <p className="text-[11px] font-bold text-green-500 uppercase tracking-wider flex items-center gap-2">

                                        <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />

                                        Sesja w toku

                                    </p>

                                </div>

                            ) : lastPoint ? (

                                <div className="space-y-1">

                                    <p className="text-4xl font-black text-gray-300 dark:text-slate-700 tracking-tighter">OFFLINE</p>

                                    <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Ostatnio aktywny: <span className="text-gray-500 font-black">{new Date(lastPoint.timestamp).toLocaleTimeString('pl-PL', {hour:'2-digit', minute:'2-digit'})}</span></p>

                                </div>

                            ) : (

                                <div className="space-y-1">

                                    <p className="text-4xl font-black text-gray-300 dark:text-slate-700 tracking-tighter">OFFLINE</p>

                                    <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Pracownik nieaktywny</p>

                                </div>

                            )}

                        </div>



                        <div className="w-full xl:w-140 2xl:w-152 xl:flex-none xl:border-l xl:border-slate-200/60 dark:xl:border-slate-700/50 xl:pl-7">

                            <WorkerStatsOverview worker={worker} variant="details" />

                        </div>

                    </div>

                </div>



                {/* Map Card */}

                <div className={`${card} p-4 overflow-hidden`}>

                    <div className="flex items-center justify-between mb-4 px-1">

                        <h3 className="text-[11px] font-black text-gray-400 uppercase tracking-widest leading-none">Mapa Terenu</h3>

                        <div className="flex gap-2">

                            <button

                                onClick={() => {

                                    if (mapInst.current) {

                                        // Center on worker's last position if available

                                        if (lastPoint) {

                                            mapInst.current.setView([lastPoint.latitude, lastPoint.longitude], 16)

                                        } else {

                                            const lastS = workerSurveys[0]

                                            if (lastS?.latitude && lastS?.longitude) {

                                                mapInst.current.setView([lastS.latitude, lastS.longitude], 16)

                                            }

                                        }

                                    }

                                }}

                                className="text-[10px] px-3 py-1.5 rounded-lg font-black bg-blue-500 text-white hover:bg-blue-600 shadow-lg shadow-blue-500/20 transition-all flex items-center gap-1.5 uppercase tracking-tighter"

                            >Resetuj widok</button>

                        </div>

                    </div>



                    <div className="relative group rounded-xl overflow-hidden border border-gray-100 dark:border-slate-700 shadow-inner">

                        <div ref={mapRef} className="w-full h-[500px] z-0" style={{ background: '#f8fafc' }} />

                    </div>



                    <div className="mt-4 pt-3 border-t border-gray-100 dark:border-slate-700/50">

                        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 text-[10px] font-black text-gray-400 uppercase tracking-tighter">

                            <div className="flex flex-wrap items-center gap-4">

                                <span className="flex items-center gap-1.5 px-2 py-1 bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 rounded-full font-black text-[9px]"><span className="font-black">{'\u2713'}</span> Umowa podpisana</span>

                                <span className="flex items-center gap-1.5 px-2 py-1 bg-cyan-100 dark:bg-cyan-900/30 text-cyan-600 dark:text-cyan-400 rounded-full font-black text-[9px]"><span className="font-black">{'\u21bb'}</span> Kontakt ponowny</span>

                                <span className="flex items-center gap-1.5 px-2 py-1 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-full font-black text-[9px]"><span className="font-black">{'\u2717'}</span> Odmowa przed spotkaniem</span>

                                <span className="flex items-center gap-1.5 px-2 py-1 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-full font-black text-[9px]"><span className="font-black">{'\u2717'}</span> Odmowa po spotkaniu</span>

                                <span className="flex items-center gap-1.5 px-2 py-1 bg-rose-100 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400 rounded-full font-black text-[9px]"><span className="font-black">F</span> Brak wspolpracy</span>

                                <span className="flex items-center gap-1.5 px-2 py-1 bg-blue-200/90 dark:bg-blue-500/25 text-blue-700 dark:text-blue-100 rounded-full font-black text-[9px] ring-1 ring-inset ring-blue-300/70 dark:ring-blue-400/20"><span className="font-black">{'\u2302'}</span> Nie było nikogo</span>

                                <span className="flex items-center gap-1.5 px-2 py-1 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded-full font-black text-[9px]"><span className="w-4 h-0.5 rounded" style={{ background: '#f59e0b' }} /> Trasa GPS</span>

                            </div>

                        </div>

                    </div>

                </div>

            </div>



            {/* Shift History & Timeline Integration */}

            <div className={`${card} p-8`}>

                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6 pb-6 border-b border-gray-50 dark:border-slate-700">

                    <div className="w-full md:w-auto">

                        <h3 className="text-sm font-black text-gray-800 dark:text-white uppercase tracking-widest mb-4">Rejestr i Historia Spotkań</h3>

                        <p className="text-[10px] font-black uppercase tracking-[0.18em] text-gray-400">

                            Zakres z kalendarza: <span className="text-cyan-500">{selectedRangeLabel}</span>

                        </p>

                    </div>

                    <div className="flex gap-6 md:gap-10 bg-gray-50 dark:bg-slate-900/50 p-4 md:p-6 rounded-2xl md:rounded-4xl border border-gray-100 dark:border-slate-700 shadow-inner w-full md:w-auto justify-around md:justify-start">

                        <div className="text-center">

                            <p className="text-[10px] text-gray-400 uppercase font-black mb-1">Spotkań</p>

                            <p className="text-2xl font-black dark:text-white leading-none">{filteredSurveyCount}</p>

                        </div>

                        <div className="text-center">

                            <p className="text-[10px] text-gray-400 uppercase font-black mb-1">Sesji</p>

                            <p className="text-2xl font-black dark:text-white leading-none">{filteredShifts.length}</p>

                        </div>

                    </div>

                </div>



                <div className="space-y-12 max-h-screen overflow-y-auto pr-4 custom-scrollbar">

                    {groupedByDay.length === 0 && <div className="text-center py-32 text-gray-300 dark:text-gray-600 font-bold italic">Brak spotkań dla wybranego okresu</div>}

                    {groupedByDay.map(day => {

                        const dH = Math.floor(day.totalMs / 3600000)

                        const dM = Math.floor((day.totalMs % 3600000) / 60000)

                        return (

                            <div key={day.dateLabel} className="space-y-8">

                                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-6">

                                    <h4 className="shrink-0 text-[10px] font-black text-slate-900 dark:text-white uppercase bg-cyan-100 dark:bg-cyan-500/20 px-3 py-1.5 rounded-xl border border-cyan-200 dark:border-cyan-900/50">{day.dateLabel}</h4>

                                    <div className="hidden sm:block flex-1 h-px bg-gray-100 dark:bg-slate-800" />

                                    <div className="text-[10px] font-black text-gray-400 uppercase flex flex-wrap gap-2 sm:gap-4 w-full sm:w-auto justify-between sm:justify-start items-center">

                                        <span>{'\u23F1'} {dH > 0 ? `${dH}h ` : ''}{dM}m pracy</span>

                                        <span className="text-cyan-500">{'\u{1F4CB}'} {day.totalSurveys} spotkań</span>

                                    </div>

                                </div>



                                <div className="space-y-6 ml-6">

                                    {day.shifts.map(s => {

                                        const start = new Date(s.start_time)

                                        const shiftSurveys = workerSurveys.filter(sv => sv.shift_id === s.id)

                                        return (

                                            <div key={s.id} className="relative pl-10 border-l-2 border-gray-100 dark:border-slate-800 py-2">

                                                <div className="absolute top-0 -left-[5px] w-2 h-2 rounded-full bg-cyan-500 shadow-[0_0_10px_rgba(245,158,11,0.5)]" />



                                                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-4 mb-4">

                                                    <span className="text-[10px] font-black font-mono text-slate-900 dark:text-white bg-slate-50 dark:bg-slate-800 px-2 py-1 rounded-lg border border-slate-100 dark:border-slate-700 shadow-sm">

                                                        {start.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })} - {s.end_time ? new Date(s.end_time).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }) : 'Obecnie'}

                                                    </span>

                                                    <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto mt-1 sm:mt-0">

                                                        <span className="text-[9px] font-bold text-gray-400 uppercase tracking-widest hidden sm:inline-block">Sesja</span>

                                                        <div className="bg-green-500/10 text-green-600 dark:text-green-400 text-[9px] font-black px-2 sm:px-3 py-0.5 rounded-full border border-green-500/20">

                                                            {shiftSurveys.length} SPOTKAŃ

                                                        </div>

                                                        <div className="bg-blue-500/10 text-blue-600 dark:text-blue-400 text-[9px] font-black px-2 sm:px-3 py-0.5 rounded-full border border-blue-500/20">

                                                            {calculatePathDistance(allGps.filter(g => g.shift_id === s.id)).toFixed(2)} KM

                                                        </div>

                                                        <button 

                                                            onClick={(e) => {

                                                                e.stopPropagation();

                                                                if (s.id) setSelectedShiftId(s.id);

                                                                hasCenteredRef.current = false;

                                                                window.scrollTo({ top: 0, behavior: 'smooth' });

                                                            }}

                                                            className={`w-full sm:w-auto mt-1 sm:mt-0 px-3 py-2 sm:py-1 rounded-lg text-[9px] font-black uppercase transition-all border shrink-0 ${visibleSelectedShiftId === s.id ? 'bg-cyan-500 text-white border-cyan-500 shadow-lg' : 'bg-white dark:bg-slate-700 text-gray-400 border-gray-200 dark:border-slate-600 hover:border-cyan-500 hover:text-cyan-500'}`}

                                                        >

                                                            {visibleSelectedShiftId === s.id ? 'Widoczna trasa' : 'Pokaż trasę'}

                                                        </button>

                                                    </div>

                                                </div>



                                                <div className="flex flex-col gap-3">

                                                    {shiftSurveys.map(sv => {

                                                        const surveyStatus = getSurveyStatus(sv)

                                                        const surveyTiming = getSurveyTimingMeta(sv)

                                                        return (

                                                        <div key={sv.id} className="group">

                                                            <button

                                                                onClick={() => setExpanded(expanded === `${s.id}-${sv.id}` ? null : `${s.id}-${sv.id}`)}

                                                                className={`w-full ${innerCard} px-3 sm:px-6 py-3 sm:py-4 flex items-center justify-between hover:bg-white dark:hover:bg-slate-700 transition-all text-left border-l-4 ${surveyStatus.borderClass} shadow-sm`}

                                                            >

                                                                <div className="flex items-center gap-3 sm:gap-4 flex-1 min-w-0">

                                                                    <div className={`w-7 h-7 sm:w-8 sm:h-8 ${surveyStatus.badgeClass} rounded-full flex items-center justify-center text-[10px] font-black shadow-sm group-hover:scale-110 transition-transform`}>

                                                                        {surveyStatus.markerChar}

                                                                    </div>

                                                                    <div className="min-w-0 flex-1">

                                                                        <div className="flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-2 mb-0.5">

                                                                            <p className="text-xs sm:text-sm font-bold truncate dark:text-white">{sv.respondent_name || 'Klient'}</p>

                                                                            {sv.respondent_phone && <span className="text-[9px] text-gray-400 font-mono">TEL {sv.respondent_phone}</span>}

                                                                        </div>

                                                                        <p className="text-[9px] font-bold text-gray-400 uppercase truncate">ADR {sv.address || 'Brak danych'}</p>

                                                                    </div>

                                                                </div>

                                                                <div className="text-right ml-2 sm:ml-4 flex flex-col items-end">

                                                                    <p className="text-[10px] sm:text-[11px] font-black text-slate-800 dark:text-slate-200 font-mono">{new Date(sv.created_at).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}</p>

                                                                    <span className={`text-[8px] sm:text-[9px] font-black uppercase tracking-widest mt-1 transition-colors ${expanded === `${s.id}-${sv.id}` ? 'text-cyan-500 underline' : 'text-gray-400 group-hover:text-cyan-500'}`}>

                                                                        {expanded === `${s.id}-${sv.id}` ? 'Zwiń' : 'Szczegóły'}

                                                                    </span>

                                                                </div>

                                                            </button>



                                                            <AnimatePresence>

                                                                {expanded === `${s.id}-${sv.id}` && (

                                                                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">

                                                                        <div className="bg-slate-100 dark:bg-slate-900/60 border-x border-b border-gray-100 dark:border-slate-700/50 rounded-b-2xl px-4 sm:px-8 py-4 sm:py-6 space-y-4 sm:space-y-5 shadow-inner mx-1 mt-[-4px]">

                                                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pb-4 sm:pb-6 border-b border-gray-200 dark:border-slate-800">

                                                                                <div className="min-w-0 space-y-3">

                                                                                    <div>

                                                                                        <p className="text-[8px] sm:text-[9px] text-gray-400 font-black uppercase tracking-widest mb-1.5 leading-none">Dokładna lokalizacja</p>

                                                                                        <p className="text-[11px] sm:text-xs font-bold dark:text-white truncate">{sv.address || 'Brak danych'}</p>

                                                                                        {sv.latitude && <p className="text-[8px] sm:text-[9px] font-mono text-gray-400 mt-1">{sv.latitude.toFixed(6)}, {sv.longitude?.toFixed(6)}</p>}

                                                                                    </div>



                                                                                    {sv.audio_transcript?.trim() && (

                                                                                        <div>

                                                                                            <div className="flex items-center justify-between mb-1">

                                                                                                <p className="text-[8px] sm:text-[9px] text-gray-400 font-black uppercase tracking-widest">Transkrypcja</p>

                                                                                                <button

                                                                                                    type="button"

                                                                                                    onClick={() => downloadText(getTranscriptFilename(sv.id), buildTranscriptText(sv))}

                                                                                                    className="text-[9px] text-blue-500 hover:underline flex items-center gap-1 font-bold"

                                                                                                >

                                                                                                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg> TXT

                                                                                                </button>

                                                                                            </div>

                                                                                            <p className="text-[10px] sm:text-[11px] text-gray-600 dark:text-gray-300 max-h-20 overflow-auto whitespace-pre-wrap bg-white dark:bg-slate-800 p-2 rounded border border-gray-200 dark:border-slate-700/50">

                                                                                                {sv.audio_transcript.trim()}

                                                                                            </p>

                                                                                        </div>

                                                                                    )}

                                                                                </div>

                                                                                <div className="min-w-0">

                                                                                    <p className="text-[8px] sm:text-[9px] text-gray-400 font-black uppercase tracking-widest mb-1.5 leading-none">Klient i kontakt</p>

                                                                                    <div className="flex flex-col gap-1">

                                                                                        <p className="text-[11px] sm:text-xs font-bold dark:text-white truncate">{sv.respondent_name || 'Brak'} {sv.respondent_phone ? `• ${sv.respondent_phone}` : ''}</p>

                                                                                        {sv.status === 'attempted' && getAttemptedNote(sv) ? (

                                                                                            <p className="text-[9px] text-cyan-500 font-black flex items-center gap-1">

                                                                                                <span>{'\u{1F4DD}'}</span> Notatka kontaktu: {getAttemptedNote(sv)}

                                                                                            </p>

                                                                                        ) : (

                                                                                            sv.respondent_preferred_date && sv.status !== 'refused' && sv.status !== 'not_home' && sv.status !== 'no_cooperation' && (

                                                                                                <p className="text-[8px] sm:text-[9px] text-cyan-500 font-black uppercase flex items-center gap-1">

                                                                                                    <span>{'\u{1F4C5}'}</span> {sv.status === 'completed' ? 'Termin wizyty eksperta' : 'Planowany powrót / kontakt'}: {sv.respondent_preferred_date} {sv.respondent_preferred_time}

                                                                                                </p>

                                                                                            )

                                                                                        )}

                                                                                        {sv.audio_url && (

                                                                                            <div className="pt-1 space-y-2">

                                                                                                <div className="flex items-center justify-between mb-2">

                                                                                                    <p className="text-[8px] sm:text-[9px] text-gray-400 font-black uppercase tracking-widest">Nagranie audio</p>

                                                                                                    <button

                                                                                                        type="button"

                                                                                                        onClick={() => {

                                                                                                            void downloadSurveyAudioAsMp3(sv, `nagranie_${sv.id ?? 'spotkanie'}`).catch((error) => {

                                                                                                                console.error('Audio download failed:', error)

                                                                                                                alert('Nie udało się pobrać nagrania w formacie MP3.')

                                                                                                            })

                                                                                                        }}

                                                                                                        className="text-[9px] text-blue-500 hover:underline flex items-center gap-1 font-bold"

                                                                                                    >

                                                                                                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg> Pobierz

                                                                                                    </button>

                                                                                                </div>

                                                                                                <AudioPlayer url={sv.audio_url} />

                                                                                            </div>

                                                                                        )}

                                                                                    </div>

                                                                                </div>

                                                                            </div>

                                                                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pb-4 sm:pb-6 border-b border-gray-200 dark:border-slate-800">

                                                                                <div>

                                                                                    <p className="text-[8px] sm:text-[9px] text-gray-400 font-black uppercase tracking-widest mb-1.5 leading-none">Start wniosku</p>

                                                                                    <p className="text-[11px] sm:text-xs font-bold dark:text-white">{formatSurveyDateTime(surveyTiming.startedAt)}</p>

                                                                                </div>

                                                                                <div>

                                                                                    <p className="text-[8px] sm:text-[9px] text-gray-400 font-black uppercase tracking-widest mb-1.5 leading-none">Koniec wniosku</p>

                                                                                    <p className="text-[11px] sm:text-xs font-bold dark:text-white">{formatSurveyDateTime(surveyTiming.finishedAt)}</p>

                                                                                </div>

                                                                                <div>

                                                                                    <p className="text-[8px] sm:text-[9px] text-gray-400 font-black uppercase tracking-widest mb-1.5 leading-none">Czas spotkania</p>

                                                                                    <p className="text-[11px] sm:text-xs font-bold dark:text-white">{surveyTiming.durationLabel || 'Brak'}</p>

                                                                                </div>

                                                                            </div>

                                                                            <div>

                                                                                <p className="text-[8px] sm:text-[9px] text-gray-400 font-black uppercase tracking-widest mb-3 sm:mb-4 leading-none">Szczegóły spotkania</p>

                                                                                <div className="grid grid-cols-1 gap-1.5 sm:gap-2">

                                                                                    {QS.map((q) => {

                                                                                        const answerText = getSurveyAnswerDisplayValue(sv, q.id)

                                                                                        return (

                                                                                            <div key={q.id} className="flex items-start justify-between py-1.5 sm:py-2 border-b border-gray-200 dark:border-slate-800/60 last:border-0 hover:bg-gray-200 dark:hover:bg-slate-800/40 px-1 sm:px-2 rounded-lg transition-colors gap-2">

                                                                                                <span className="text-[10px] sm:text-[11px] text-gray-600 dark:text-gray-400 pr-2 sm:pr-4">{q.num}. {q.text}</span>

                                                                                                <span className={`text-[10px] sm:text-[11px] text-right shrink-0 max-w-[52%] ${answerText ? 'font-black dark:text-white' : 'italic text-gray-400 dark:text-slate-500'}`}>

                                                                                                    {answerText || 'Brak odpowiedzi'}

                                                                                                </span>

                                                                                            </div>

                                                                                        )

                                                                                    })}

                                                                                </div>

                                                                            </div>

                                                                            <div className="flex justify-end mt-6 pt-4 border-t border-red-100 dark:border-red-900/30">

                                                                                <button

                                                                                    onClick={() => onDeleteSurvey?.(sv.id!, sv.respondent_name || sv.address || 'to spotkanie')}

                                                                                    className="text-[10px] font-black uppercase bg-red-50 text-red-600 hover:bg-red-600 hover:text-white dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20 px-4 py-2 rounded-lg transition-colors border border-red-100 dark:border-red-500/20"

                                                                                >

                                                                                    Usuń spotkanie

                                                                                </button>

                                                                            </div>

                                                                        </div>

                                                                    </motion.div>

                                                                )}

                                                            </AnimatePresence>

                                                        </div>

                                                        )

                                                    })}

                                                    {shiftSurveys.length === 0 && <p className="text-xs font-bold text-gray-300 dark:text-slate-700 uppercase p-6 border-2 border-dashed border-gray-100 dark:border-slate-800 rounded-2xl text-center">Brak spotkań w tej sesji</p>}

                                                </div>

                                            </div>

                                        )

                                    })}

                                </div>

                            </div>

                        )

                    })}

                </div>

            </div>

        </motion.div>

    )

}











