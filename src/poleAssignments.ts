import type {
    PoleAssignment,
    PoleAssignmentKwMode,
    PoleAssignmentPgeServitudeStatus,
    SalesMeeting,
    SalesMeetingStatus
} from './db'
import { getSalesMeetingCleanStatusNote, getSalesMeetingDisplayMeta, SALES_MEETING_STATUSES } from './salesMeetingStatus'
import { getSalesMeetingParcelLabel } from './salesMeetingLocation'
import { normalizeSalesMeetingAddress, normalizeSalesMeetingInlineText } from './salesMeetingText'

export const POLE_ASSIGNMENT_KW_OPTIONS: Array<{ value: PoleAssignmentKwMode; label: string }> = [
    { value: 'known_address', label: 'Znamy adres' },
    { value: 'missing', label: 'Brak' },
    { value: 'manual', label: 'Reczne uzupelnienie' }
]

export const POLE_ASSIGNMENT_PGE_OPTIONS: Array<{ value: PoleAssignmentPgeServitudeStatus; label: string }> = [
    { value: 'yes', label: 'Tak' },
    { value: 'no', label: 'Nie' },
    { value: 'unknown', label: 'Nie wie' }
]

export const POLE_ASSIGNMENT_CAN_PROCEED_OPTIONS: Array<{ value: '' | 'yes' | 'no'; label: string }> = [
    { value: '', label: 'Puste' },
    { value: 'yes', label: 'Tak' },
    { value: 'no', label: 'Nie' }
]

export const getPoleAssignmentPgeLabel = (value?: PoleAssignmentPgeServitudeStatus | null): string => {
    if (value === 'yes') return 'Tak'
    if (value === 'no') return 'Nie'
    if (value === 'unknown') return 'Nie ustalono'
    return ''
}

export const getPoleAssignmentCanProceedLabel = (value?: boolean | null): string => {
    if (value === true) return 'Tak'
    if (value === false) return 'Nie'
    return ''
}

const normalizeText = (value?: string | null): string =>
    `${value || ''}`
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()

export const parsePoleAssignmentSurfaceAreaSqm = (value?: string | null): number | null => {
    const raw = `${value || ''}`.trim()
    if (!raw) return null

    const normalized = raw
        .replace(/\s+/g, '')
        .replace(/m²|m2|ha/giu, '')
        .replace(',', '.')

    const parsed = Number.parseFloat(normalized)
    return Number.isFinite(parsed) ? parsed : null
}

const formatPoleAssignmentNumber = (value: number, maximumFractionDigits: number): string =>
    value.toLocaleString('pl-PL', {
        minimumFractionDigits: 0,
        maximumFractionDigits
    })

export const formatPoleAssignmentSurfaceArea = (
    value?: string | null,
    options?: { mode?: 'ha' | 'both' | 'sqm' }
): string => {
    const squareMeters = parsePoleAssignmentSurfaceAreaSqm(value)
    if (squareMeters === null) return `${value || ''}`.trim()

    if (options?.mode === 'sqm') {
        return `${formatPoleAssignmentNumber(squareMeters, 2)} m²`
    }

    const hectares = squareMeters / 10000
    const hectareLabel = `${formatPoleAssignmentNumber(hectares, 2)} ha`
    if (options?.mode === 'both') {
        return `${hectareLabel} (${formatPoleAssignmentNumber(squareMeters, 2)} m²)`
    }

    return hectareLabel
}

export const parsePoleAssignmentStatus = (value?: string | null): SalesMeetingStatus | null => {
    const normalized = normalizeText(value)
    if (!normalized) return null

    const direct = SALES_MEETING_STATUSES.find((option) => normalizeText(option.label) === normalized || option.key === normalized)
    if (direct) return direct.key

    if (normalized.includes('umowa')) return 'signed'
    if (normalized.includes('kontakt ponowny') || normalized.includes('ponowny')) return 'follow_up'
    if (normalized.includes('nie bylo nikogo') || normalized.includes('nie zastano')) return 'not_home'
    if (normalized.includes('odmowa demo') || normalized.includes('brak mozliwosci wspolpracy')) {
        return 'no_cooperation'
    }
    if (normalized.includes('odmowa') || normalized.includes('niezainteresowany') || normalized.includes('kancelaria')) return 'refused'
    if (normalized.includes('anul')) return 'cancelled'
    if (normalized.includes('plan')) return 'planned'

    return null
}

export const parsePoleAssignmentKw = (value?: string | null): { mode: PoleAssignmentKwMode | null; manualValue: string | null } => {
    const raw = `${value || ''}`.trim()
    const normalized = normalizeText(raw)
    if (!normalized) return { mode: null, manualValue: null }
    if (normalized === 'brak') return { mode: 'missing', manualValue: null }
    if (normalized === 'znamy adres') return { mode: 'known_address', manualValue: null }
    return { mode: 'manual', manualValue: raw }
}

export const parsePoleAssignmentPgeServitudeStatus = (value?: string | null): PoleAssignmentPgeServitudeStatus | null => {
    const normalized = normalizeText(value)
    if (!normalized) return null
    if (normalized === 'tak' || normalized === 'yes') return 'yes'
    if (normalized === 'nie' || normalized === 'no') return 'no'
    if (normalized.includes('nie wie')) return 'unknown'
    return null
}

export const parsePoleAssignmentCanProceed = (value?: string | null): boolean | null => {
    const normalized = normalizeText(value)
    if (!normalized) return null
    if (normalized === 'tak' || normalized === 'yes') return true
    if (normalized === 'nie' || normalized === 'no') return false
    return null
}

export const getPoleAssignmentLocationLabel = (
    assignment: Pick<PoleAssignment, 'address' | 'locality' | 'parcel_number' | 'parcel_id'>
): string => {
    const address = normalizeSalesMeetingAddress(assignment.address)
    if (address) return address

    const locality = normalizeSalesMeetingInlineText(assignment.locality)
    const parcel = normalizeSalesMeetingInlineText(assignment.parcel_number) || normalizeSalesMeetingInlineText(assignment.parcel_id)
    return [locality, parcel ? `dzialka ${parcel}` : ''].filter(Boolean).join(', ') || 'Brak lokalizacji'
}

export const getPoleAssignmentClientName = (
    assignment: Pick<PoleAssignment, 'owner_details' | 'parcel_number' | 'parcel_id' | 'locality'>
): string => {
    const owner = normalizeSalesMeetingInlineText(assignment.owner_details)
    if (owner) return owner

    const parcel = normalizeSalesMeetingInlineText(assignment.parcel_number) || normalizeSalesMeetingInlineText(assignment.parcel_id)
    const locality = normalizeSalesMeetingInlineText(assignment.locality)
    return [parcel ? `Dzialka ${parcel}` : '', locality].filter(Boolean).join(', ') || 'Dzialka / wlasciciel'
}

export const getPoleAssignmentStatusLabel = (
    assignment: Pick<PoleAssignment, 'status_ph' | 'result_status'>,
    linkedMeeting?: SalesMeeting | null
): string => {
    if (assignment.status_ph) {
        return SALES_MEETING_STATUSES.find((option) => option.key === assignment.status_ph)?.label || assignment.status_ph
    }
    if (linkedMeeting) return getSalesMeetingDisplayMeta(linkedMeeting).label
    if (assignment.result_status?.trim()) {
        return getPoleAssignmentResultLabel(assignment.result_status)
    }
    return 'Brak'
}

export const getPoleAssignmentResultLabel = (value?: string | null): string => {
    const normalized = `${value || ''}`.trim()
    if (!normalized) return ''
    return SALES_MEETING_STATUSES.find((option) => option.key === normalized)?.label || normalized
}

export const getPoleAssignmentWorkerNotes = (
    assignment: Pick<PoleAssignment, 'worker_notes'>,
    linkedMeeting?: SalesMeeting | null
): string => {
    const note = `${assignment.worker_notes || ''}`.trim() || getSalesMeetingCleanStatusNote(linkedMeeting?.status_note) || ''
    return normalizeText(note) === 'braknotatekpracownika' ? '' : note
}

export const formatPoleAssignmentTravel = (minutes?: number | null): string =>
    Number.isFinite(minutes) ? `${Math.max(0, Number(minutes))} min` : '-'

export const getSalesMeetingAssignmentBadges = (
    meeting: Pick<SalesMeeting, 'pole_assignment_id' | 'parcel_number' | 'parcel_id' | 'pge_servitude_status' | 'can_proceed'>
): string[] => {
    const badges: string[] = []
    if (typeof meeting.pole_assignment_id === 'number') badges.push('Z dzialek')

    const pgeLabel = getPoleAssignmentPgeLabel(meeting.pge_servitude_status)
    if (pgeLabel) badges.push(`PGE: ${pgeLabel}`)

    const canProceedLabel = getPoleAssignmentCanProceedLabel(meeting.can_proceed)
    if (canProceedLabel) {
        badges.push(canProceedLabel === 'Tak' ? 'Mozemy dzialac' : 'Wstrzymane')
    }

    return badges
}

export const getSalesMeetingAssignmentMetaRows = (
    meeting: Pick<
        SalesMeeting,
        | 'pole_assignment_id'
        | 'parcel_number'
        | 'parcel_id'
        | 'surface_area'
        | 'county'
        | 'municipality'
        | 'owner_details'
        | 'kw_mode'
        | 'kw_value'
        | 'pge_servitude_status'
        | 'can_proceed'
    >
): Array<{ label: string; value: string }> => {
    const rows: Array<{ label: string; value: string }> = []

    if (typeof meeting.pole_assignment_id === 'number') {
        rows.push({ label: 'Zrodlo', value: 'Tabela dzialek' })
    }

    const parcelLabel = getSalesMeetingParcelLabel(meeting)
    if (parcelLabel) rows.push({ label: 'Dzialka', value: parcelLabel })

    const surfaceArea = normalizeSalesMeetingInlineText(meeting.surface_area)
    if (surfaceArea) rows.push({ label: 'Powierzchnia', value: formatPoleAssignmentSurfaceArea(surfaceArea, { mode: 'both' }) })

    const county = normalizeSalesMeetingInlineText(meeting.county)
    if (county) rows.push({ label: 'Powiat', value: county })

    const municipality = normalizeSalesMeetingInlineText(meeting.municipality)
    if (municipality) rows.push({ label: 'Gmina', value: municipality })

    const ownerDetails = normalizeSalesMeetingInlineText(meeting.owner_details)
    if (ownerDetails) rows.push({ label: 'Wlasciciel', value: ownerDetails })

    const kwLabel = getSalesMeetingKwLabel(meeting)
    if (kwLabel) rows.push({ label: 'KW', value: kwLabel })

    const pgeLabel = getPoleAssignmentPgeLabel(meeting.pge_servitude_status)
    if (pgeLabel) rows.push({ label: 'Sluzebnosc PGE', value: pgeLabel })

    const canProceedLabel = getPoleAssignmentCanProceedLabel(meeting.can_proceed)
    if (canProceedLabel) rows.push({ label: 'Mozemy dzialac', value: canProceedLabel })

    return rows
}

export const getSalesMeetingExecutionMetaRows = (
    meeting: Pick<SalesMeeting, 'travel_minutes' | 'worker_notes'>
): Array<{ label: string; value: string }> => {
    const rows: Array<{ label: string; value: string }> = []

    if (Number.isFinite(meeting.travel_minutes)) {
        rows.push({ label: 'Czas dojazdu', value: formatPoleAssignmentTravel(meeting.travel_minutes) })
    }

    const workerNotes = normalizeSalesMeetingInlineText(meeting.worker_notes)
    if (workerNotes) rows.push({ label: 'Uwagi PH', value: workerNotes })

    return rows
}

export const getSalesMeetingKwLabel = (
    meeting: Pick<SalesMeeting, 'kw_mode' | 'kw_value'>
): string => {
    if (meeting.kw_mode === 'known_address') return 'Znamy adres'
    if (meeting.kw_mode === 'missing') return 'Brak'

    const manualValue = normalizeSalesMeetingInlineText(meeting.kw_value)
    if (meeting.kw_mode === 'manual' && manualValue) return manualValue

    return manualValue
}
