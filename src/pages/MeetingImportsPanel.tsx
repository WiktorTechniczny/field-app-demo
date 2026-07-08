
import { useCallback, useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import { pl } from 'date-fns/locale'
import { DayPicker } from 'react-day-picker'
import { supabase } from '../supabase'
import type { SalesMeeting, SalesMeetingStatus, Survey, User } from '../db'
import {
    SALES_MEETING_STATUSES,
    buildSalesMeetingRefusalNote,
    buildSalesMeetingRescheduledNote,
    getSalesMeetingCleanStatusNote,
    getSalesMeetingDisplayMeta,
    getSalesMeetingEffectiveScheduledAt,
    mapMeetingStatusToPoleStatus,
    mapMeetingStatusToSurveyStatus
} from '../salesMeetingStatus'
import { APPOINTMENT_SLOTS } from '../appointmentSlots'
import {
    isMissingSalesMeetingsLeadSourceColumnError,
    mapSalesMeetingsMutationError,
    omitLeadSource,
    parseUnknownError
} from '../salesMeetingsErrors'
import {
    getSalesMeetingAssignmentBadges,
    getSalesMeetingAssignmentMetaRows,
    getSalesMeetingExecutionMetaRows
} from '../poleAssignments'
import {
    SALES_MEETING_LEAD_SOURCE_OPTIONS,
    normalizeSalesMeetingAddress,
    normalizeSalesMeetingInlineText
} from '../salesMeetingText'
import { buildSalesMeetingImportKey, buildSalesMeetingSlotKey } from '../salesMeetingIdentity'
import { findSalesMeetingSlotConflict } from '../salesMeetingConflicts'
import { syncPoleAssignmentsForMeetings } from '../salesMeetingPoleAssignments'
import {
    getSalesMeetingLocalityLabel,
    getSalesMeetingLocationBadges,
    getSalesMeetingEnhancedAddress,
    needsSalesMeetingAddressClarification
} from '../salesMeetingLocation'
import { formatSurveyDateTime, getSurveyTimingMeta } from '../surveyTiming'
import toast from 'react-hot-toast'
import { SelectInput } from '../components/SelectInput'

type ImportPayload = Omit<
    SalesMeeting,
    'id' | 'created_at' | 'updated_at'
> & {
    status: SalesMeetingStatus
}

type MeetingFormData = {
    salesperson_id: string
    lead_source: string
    scheduled_at: string
    phone: string
    client_name: string
    region: string
    address: string
    note: string
}

type AdminSettableMeetingStatus = 'follow_up' | 'refused' | 'no_cooperation' | 'not_home'
type AddressPrecisionFilter = 'all' | 'exact' | 'needs_clarification'

const IMPORT_ERROR_PREVIEW_LIMIT = 4

const card = 'bg-white dark:bg-slate-800 rounded-xl border border-gray-200/60 dark:border-slate-700 shadow-md'
const input =
    'w-full border border-gray-200 dark:border-slate-600 bg-gray-50 dark:bg-slate-700/50 rounded-xl px-3 py-2.5 text-sm focus:ring-2 focus:ring-cyan-500 outline-none transition-all dark:text-white dark:[color-scheme:dark]'
const actionButtonBase =
    'ui-pressable inline-flex min-h-[34px] min-w-[88px] items-center justify-center rounded-xl border px-2.5 text-[9px] font-black uppercase tracking-[0.12em] shadow-sm'
const detailsButtonClass =
    `${actionButtonBase} border-sky-400/30 bg-sky-500/12 text-sky-700 shadow-sky-500/10 hover:bg-sky-500/20 dark:border-sky-400/20 dark:bg-sky-500/10 dark:text-sky-100`
const statusButtonClass =
    `${actionButtonBase} border-violet-400/35 bg-violet-600 text-white shadow-violet-600/20 hover:bg-violet-500 dark:border-violet-400/25 dark:bg-violet-600 dark:text-white dark:hover:bg-violet-500`
const modalSecondaryButtonClass =
    'ui-pressable flex-1 h-11 rounded-xl border border-gray-200 bg-white text-gray-700 shadow-sm hover:bg-gray-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600 font-black text-xs uppercase tracking-widest disabled:opacity-50'
const modalPrimaryButtonClass =
    'ui-pressable flex-1 h-11 rounded-xl border border-cyan-400/35 bg-cyan-500 text-white shadow-lg shadow-cyan-500/20 hover:bg-cyan-400 font-black text-xs uppercase tracking-widest disabled:opacity-50'
const modalDangerButtonClass =
    'ui-pressable flex-1 h-11 rounded-xl border border-red-400/35 bg-red-500 text-white shadow-lg shadow-red-500/20 hover:bg-red-400 font-black text-xs uppercase tracking-widest disabled:opacity-50'
const modalDeleteButtonClass =
    'ui-pressable flex-1 h-11 rounded-xl border border-slate-500/35 bg-slate-700 text-white shadow-lg shadow-slate-950/20 hover:bg-slate-600 font-black text-xs uppercase tracking-widest disabled:opacity-50'

const HEADER_ALIASES = {
    salesperson: ['handlowiec', 'sprzedawca', 'pracownik', 'opiekun', 'worker', 'login'],
    leadSource: ['zrodlopozyskanialeada', 'zrodopozyskanialeada', 'zrodloleada', 'zrodoleada', 'zrodlo', 'zrodo', 'leadsource', 'source'],
    dateTime: ['dataigodzinaspotkania', 'termin', 'dataigodzina', 'scheduledat', 'dataczas', 'datagodzina', 'dataspotkaniaigodzina'],
    date: ['data', 'dataspotkania', 'datawizyty', 'scheduledate'],
    time: ['godzina', 'godzinaspotkania', 'godzinawizyty', 'czas', 'scheduletime'],
    phone: ['numertelefonu', 'telefon', 'phone'],
    name: ['imieinazwisko', 'klient', 'osoba', 'nazwaklienta'],
    firstName: ['imie', 'firstname'],
    lastName: ['nazwisko', 'lastname', 'surname'],
    region: ['wojewodztwo', 'wojewodztwoobszar', 'region'],
    address: ['adres', 'ulica'],
    note: ['notatka', 'opis', 'uwagi', 'komentarz']
} as const

const normalizePolishChars = (value: string): string =>
    value.replace(/[Łł]/g, (char) => (char === 'Ł' ? 'L' : 'l'))

const normalizeText = (value: string): string =>
    normalizePolishChars(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')

const normalizeForKey = (value: string): string =>
    normalizePolishChars(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ')

const getMatchTokens = (value: string): string[] =>
    normalizePolishChars(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean)

const toMatchKey = (value: string): string => getMatchTokens(value).join(' ')

const toMatchCompactKey = (value: string): string => getMatchTokens(value).join('')

const uniqueValues = (values: string[]): string[] => Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))

const parseCsvLine = (line: string, delimiter: string): string[] => {
    const out: string[] = []
    let current = ''
    let inQuotes = false

    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i]

        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"'
                i += 1
                continue
            }
            inQuotes = !inQuotes
            continue
        }

        if (ch === delimiter && !inQuotes) {
            out.push(current.trim())
            current = ''
            continue
        }

        current += ch
    }

    out.push(current.trim())
    return out
}

const detectDelimiter = (line: string): string => {
    const candidates = [';', ',', '\t']
    let best = ';'
    let bestScore = 0
    candidates.forEach((candidate) => {
        const score = parseCsvLine(line, candidate).length
        if (score > bestScore) {
            best = candidate
            bestScore = score
        }
    })
    return best
}

const getTodayDateInput = (): string => {
    const d = new Date()
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
}

const getDefaultMeetingDateTimeInput = (date = getTodayDateInput()): string => `${date}T10:00`

const addDaysToDateInput = (datePart: string, days: number): string => {
    const date = toLocalDate(datePart)
    date.setDate(date.getDate() + days)
    const yyyy = date.getFullYear()
    const mm = String(date.getMonth() + 1).padStart(2, '0')
    const dd = String(date.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
}

const toDateTimeLocalInput = (iso: string): string => {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const min = String(d.getMinutes()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}T${hh}:${min}`
}

const toLocalDate = (value: string): Date => {
    const [year, month, day] = value.split('-').map(Number)
    return new Date(year, month - 1, day)
}

const getScheduledDatePart = (value: string): string => {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/)
    return match?.[1] || getTodayDateInput()
}

const getScheduledTimePart = (value: string): string => {
    const match = value.match(/T(\d{2}:\d{2})/)
    return match?.[1] || '10:00'
}

const combineScheduledDateTime = (datePart: string, timePart: string): string => `${datePart}T${timePart}`

const buildLocalScheduledAt = (datePart: string, timePart: string): Date => {
    const [year, month, day] = datePart.split('-').map(Number)
    const [hours, minutes] = timePart.split(':').map(Number)
    return new Date(year, month - 1, day, hours, minutes, 0, 0)
}

const isScheduledTermInPast = (scheduledAt: string, now = new Date()): boolean => {
    const dateValue = new Date(scheduledAt)
    if (Number.isNaN(dateValue.getTime())) return false
    return dateValue.getTime() <= now.getTime()
}

const isSlotUnavailableForNow = (datePart: string, timePart: string, now = new Date()): boolean =>
    buildLocalScheduledAt(datePart, timePart).getTime() <= now.getTime()

const getFirstAvailableSlot = (datePart: string, now = new Date()): string | null =>
    APPOINTMENT_SLOTS.find((slot) => !isSlotUnavailableForNow(datePart, slot, now)) ?? null

const getNextAllowedMeetingDateTimeInput = (preferredDate = getTodayDateInput(), now = new Date()): string => {
    const today = getTodayDateInput()
    let datePart = preferredDate < today ? today : preferredDate

    for (let offset = 0; offset < 366; offset += 1) {
        const slot = getFirstAvailableSlot(datePart, now)
        if (slot) return combineScheduledDateTime(datePart, slot)
        datePart = addDaysToDateInput(datePart, 1)
    }

    return getDefaultMeetingDateTimeInput(addDaysToDateInput(today, 1))
}

const createMeetingFormData = (selectedDate: string, salespersonId?: number | null): MeetingFormData => ({
    salesperson_id: typeof salespersonId === 'number' ? String(salespersonId) : '',
    lead_source: '',
    scheduled_at: getNextAllowedMeetingDateTimeInput(selectedDate),
    phone: '',
    client_name: '',
    region: '',
    address: '',
    note: ''
})

const parseDateTime = (raw: string): string | null => {
    const text = raw.trim()
    if (!text) return null

    const normalized = text.replace(/\s+/g, ' ').replace(',', '.')

    const pl = normalized.match(/^(\d{1,2})[.:/-](\d{1,2})[.:/-](\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/)
    if (pl) {
        const day = Number(pl[1])
        const month = Number(pl[2]) - 1
        const year = Number(pl[3])
        const hour = Number(pl[4] ?? '0')
        const minute = Number(pl[5] ?? '0')
        const dt = new Date(year, month, day, hour, minute, 0)
        return Number.isNaN(dt.getTime()) ? null : dt.toISOString()
    }

    const isoLike = normalized.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2}))?$/)
    if (isoLike) {
        const year = Number(isoLike[1])
        const month = Number(isoLike[2]) - 1
        const day = Number(isoLike[3])
        const hour = Number(isoLike[4] ?? '0')
        const minute = Number(isoLike[5] ?? '0')
        const dt = new Date(year, month, day, hour, minute, 0)
        return Number.isNaN(dt.getTime()) ? null : dt.toISOString()
    }

    const parsed = new Date(text)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()

    return null
}

const getHeaderIndex = (headers: string[], aliases: readonly string[]): number => {
    const normalizedHeaders = headers.map((header) => normalizeText(header))
    return normalizedHeaders.findIndex((header) => aliases.some((alias) => header === alias || header.includes(alias)))
}

const findWorkerByValue = (workers: User[], value: string):
    | { kind: 'matched'; worker: User & { id: number } }
    | { kind: 'empty' | 'not_found' | 'ambiguous'; candidates?: string[] } => {
    const needle = toMatchKey(value)
    const needleCompact = toMatchCompactKey(value)
    const needleTokens = getMatchTokens(value)
    if (!needle || needleTokens.length === 0) return { kind: 'empty' }

    const scoredMatches = workers
        .filter((worker): worker is User & { id: number } => typeof worker.id === 'number')
        .map((worker) => {
            const loginTokens = getMatchTokens(worker.login ?? '')
            const nameTokens = getMatchTokens(worker.name ?? '')
            const reversedName = [...nameTokens].reverse().join(' ')
            const workerTokens = new Set([...loginTokens, ...nameTokens])
            const phrases = uniqueValues([
                worker.login ?? '',
                worker.name ?? '',
                `${worker.name ?? ''} ${worker.login ?? ''}`,
                `${worker.name ?? ''} (${worker.login ?? ''})`,
                `${worker.login ?? ''} ${worker.name ?? ''}`,
                reversedName,
                reversedName ? `${reversedName} ${worker.login ?? ''}` : ''
            ]).map(toMatchKey)
            const exactPhrases = new Set(phrases)
            const compactPhrases = new Set(phrases.map(toMatchCompactKey))

            let score = 0
            if (exactPhrases.has(needle)) score = 120
            else if (compactPhrases.has(needleCompact)) score = 110
            else if (needleTokens.length === 1 && loginTokens.includes(needleTokens[0])) score = 100
            else if (needleTokens.length > 1 && needleTokens.every((token) => workerTokens.has(token))) score = 80 + needleTokens.length
            else if (needleTokens.length === 1 && workerTokens.has(needleTokens[0])) score = 60

            return score > 0 ? { worker, score } : null
        })
        .filter((item): item is { worker: User & { id: number }; score: number } => item !== null)
        .sort((left, right) => right.score - left.score || left.worker.name.localeCompare(right.worker.name))

    if (scoredMatches.length === 0) return { kind: 'not_found' }

    const bestScore = scoredMatches[0].score
    const sameScore = scoredMatches.filter((item) => item.score === bestScore)
    if (sameScore.length > 1) {
        return {
            kind: 'ambiguous',
            candidates: sameScore.slice(0, 3).map(({ worker }) => `${worker.name} (${worker.login})`)
        }
    }

    return { kind: 'matched', worker: scoredMatches[0].worker }
}

const getClientName = (fullName: string, firstName: string, lastName: string): string =>
    fullName.trim() || [firstName.trim(), lastName.trim()].filter(Boolean).join(' ').trim()

const getMeetingDateTimeValue = (dateTime: string, date: string, time: string): string =>
    dateTime.trim() || [date.trim(), time.trim()].filter(Boolean).join(' ').trim()

const renderImportIssuesToast = (errors: string[]) => {
    const visibleErrors = errors.slice(0, IMPORT_ERROR_PREVIEW_LIMIT)
    const hiddenCount = Math.max(errors.length - visibleErrors.length, 0)

    return (
        <div className="space-y-2">
            {visibleErrors.map((error) => (
                <p key={error} className="text-[13px] font-semibold leading-5 text-cyan-50">
                    {error}
                </p>
            ))}
            {hiddenCount > 0 && (
                <p className="text-[12px] font-bold uppercase tracking-wide text-red-100/80">
                    I jeszcze {hiddenCount} kolejnych.
                </p>
            )}
        </div>
    )
}

const shouldFallbackToManualImport = (error: unknown): boolean => {
    const { message, code } = parseUnknownError(error)
    const lower = message.toLowerCase()

    return (
        code === '42P10' ||
        lower.includes('on conflict') ||
        lower.includes('no unique or exclusion constraint') ||
        lower.includes('no unique') ||
        lower.includes('import_key')
    )
}

const isMeetingLockedForAdmin = (meeting: Pick<SalesMeeting, 'status' | 'status_note'>): boolean => {
    const meta = getSalesMeetingDisplayMeta(meeting)
    return !meta.isInProgress && meta.baseKey !== 'planned'
}

const shouldPreserveImportedMeetingProgress = (meeting: Pick<
    SalesMeeting,
    'status' | 'status_note' | 'scheduled_at' | 'linked_survey_id' | 'status_updated_at' | 'cancelled_reason'
>): boolean =>
    Boolean(meeting.linked_survey_id) || getSalesMeetingDisplayMeta(meeting).baseKey !== 'planned'

const mergeImportedRowWithExistingMeeting = (row: ImportPayload, existing?: SalesMeeting | null): ImportPayload => {
    if (!existing) return row

    const mergedRow: ImportPayload = {
        ...row,
        pole_assignment_id: existing.pole_assignment_id ?? row.pole_assignment_id,
        pole_id: existing.pole_id ?? row.pole_id,
        pole_lat: existing.pole_lat ?? row.pole_lat,
        pole_lng: existing.pole_lng ?? row.pole_lng,
        parcel_id: existing.parcel_id ?? row.parcel_id,
        parcel_number: existing.parcel_number ?? row.parcel_number,
        surface_area: existing.surface_area ?? row.surface_area,
        locality_code: existing.locality_code ?? row.locality_code,
        locality_label: existing.locality_label ?? row.locality_label,
        municipality: existing.municipality ?? row.municipality,
        precinct: existing.precinct ?? row.precinct,
        kw_mode: existing.kw_mode ?? row.kw_mode,
        kw_value: existing.kw_value ?? row.kw_value,
        pge_servitude_status: existing.pge_servitude_status ?? row.pge_servitude_status,
        owner_details: existing.owner_details ?? row.owner_details,
        can_proceed: existing.can_proceed ?? row.can_proceed,
        travel_minutes: existing.travel_minutes ?? row.travel_minutes,
        result_status: existing.result_status ?? row.result_status,
        worker_notes: existing.worker_notes ?? row.worker_notes
    }

    if (!shouldPreserveImportedMeetingProgress(existing)) {
        return mergedRow
    }

    return {
        ...mergedRow,
        scheduled_at: existing.scheduled_at || row.scheduled_at,
        status: existing.status,
        status_note: existing.status_note ?? null,
        status_updated_at: existing.status_updated_at ?? null,
        cancelled_reason: existing.cancelled_reason ?? null,
        linked_survey_id: existing.linked_survey_id ?? null
    }
}

const ADMIN_STATUS_OPTIONS: Array<{ key: AdminSettableMeetingStatus; label: string }> = [
    { key: 'follow_up', label: 'Kontakt ponowny' },
    { key: 'refused', label: 'Odmowa przed spotkaniem' },
    { key: 'no_cooperation', label: 'Brak wspolpracy' },
    { key: 'not_home', label: 'Nie było nikogo' }
]

const adminStatusRequiresNote = (status: AdminSettableMeetingStatus): boolean =>
    status === 'follow_up' || status === 'refused' || status === 'no_cooperation' || status === 'not_home'

const getAdminStatusTitle = (status: AdminSettableMeetingStatus): string => {
    switch (status) {
        case 'follow_up':
            return 'Formularz kontaktu ponownego'
        case 'refused':
            return 'Formularz odmowy przed spotkaniem'
        case 'no_cooperation':
            return 'Formularz braku wspolpracy'
        case 'not_home':
            return 'Formularz nie było nikogo'
    }
}

const getAdminStatusNoteLabel = (status: AdminSettableMeetingStatus): string => {
    switch (status) {
        case 'follow_up':
            return 'Notatka do kontaktu ponownego'
        case 'refused':
            return 'Notatka do odmowy przed spotkaniem'
        case 'no_cooperation':
            return 'Notatka do odmowy INNE'
        case 'not_home':
            return 'Notatka do statusu'
    }
}

const getAdminStatusPlaceholder = (status: AdminSettableMeetingStatus): string => {
    switch (status) {
        case 'follow_up':
            return 'Opisz nowo ustalony termin lub ustalenia z klientem'
        case 'refused':
            return 'Opisz powód odmowy przed spotkaniem'
        case 'no_cooperation':
            return 'Opisz powod braku wspolpracy'
        case 'not_home':
            return 'Opcjonalna notatka do statusu'
    }
}

const addDaysToDatePart = (datePart: string, days: number): string => {
    const date = toLocalDate(datePart)
    date.setDate(date.getDate() + days)
    return format(date, 'yyyy-MM-dd')
}

const getNextFollowUpDateTimeInput = (meeting: SalesMeeting): string => {
    const originalScheduledAt = toDateTimeLocalInput(meeting.scheduled_at)
    const originalDatePart = getScheduledDatePart(originalScheduledAt)
    const originalTimePart = getScheduledTimePart(originalScheduledAt)

    for (let dayOffset = 0; dayOffset < 21; dayOffset += 1) {
        const datePart = addDaysToDatePart(originalDatePart, dayOffset)
        for (const slot of APPOINTMENT_SLOTS) {
            if (dayOffset === 0 && slot <= originalTimePart) continue
            if (isSlotUnavailableForNow(datePart, slot)) continue
            return combineScheduledDateTime(datePart, slot)
        }
    }

    return getNextAllowedMeetingDateTimeInput(originalDatePart)
}

const getMeetingStatusStripLines = (
    baseKey: ReturnType<typeof getSalesMeetingDisplayMeta>['baseKey'],
    isInProgress: boolean,
    isMissedMeeting: boolean
): string[] => {
    if (isInProgress) return ['W TRAKCIE', 'WIZYTY']
    if (isMissedMeeting) return ['NIEODBYTE']

    switch (baseKey) {
        case 'planned':
            return ['ZAPLANOWANE']
        case 'signed':
            return ['UMOWA', 'PODPISANA']
        case 'refused':
            return ['ODMOWA', 'KLIENTA']
        case 'no_cooperation':
            return ['ODMOWA', 'INNE']
        case 'not_home':
            return ['NIE BYŁO', 'NIKOGO']
        case 'follow_up':
            return ['KONTAKT', 'PONOWNY']
        case 'cancelled':
        default:
            return ['ANULOWANE']
    }
}

export default function MeetingImportsPanel({ selectedDate }: { selectedDate: string }) {
    const [workers, setWorkers] = useState<User[]>([])
    const [meetings, setMeetings] = useState<SalesMeeting[]>([])
    const [statusFilter, setStatusFilter] = useState<'all' | SalesMeetingStatus>('all')
    const [salespersonFilter, setSalespersonFilter] = useState<string>('all')
    const [localityFilter, setLocalityFilter] = useState<string>('all')
    const [addressPrecisionFilter, setAddressPrecisionFilter] = useState<AddressPrecisionFilter>('all')
    const [hideCancelled, setHideCancelled] = useState(false)
    const [hideCompleted, setHideCompleted] = useState(false)
    const [file, setFile] = useState<File | null>(null)
    const [loading, setLoading] = useState(false)
    const [importing, setImporting] = useState(false)
    const [editing, setEditing] = useState<SalesMeeting | null>(null)
    const [isCreateOpen, setIsCreateOpen] = useState(false)
    const [formSaving, setFormSaving] = useState(false)
    const [settingsDialog, setSettingsDialog] = useState<SalesMeeting | null>(null)
    const [cancelDialog, setCancelDialog] = useState<{ meeting: SalesMeeting; reason: string } | null>(null)
    const [cancelSaving, setCancelSaving] = useState(false)
    const [deleteDialog, setDeleteDialog] = useState<SalesMeeting | null>(null)
    const [deleteSaving, setDeleteSaving] = useState(false)
    const [statusPickerMeeting, setStatusPickerMeeting] = useState<SalesMeeting | null>(null)
    const [statusDetailsMeeting, setStatusDetailsMeeting] = useState<SalesMeeting | null>(null)
    const [selectedStatus, setSelectedStatus] = useState<AdminSettableMeetingStatus | null>(null)
    const [statusDraftNote, setStatusDraftNote] = useState('')
    const [statusDraftScheduledAt, setStatusDraftScheduledAt] = useState(getDefaultMeetingDateTimeInput())
    const [statusPickerMonth, setStatusPickerMonth] = useState<Date>(() => toLocalDate(getTodayDateInput()))
    const [statusSaving, setStatusSaving] = useState(false)
    const [detailsDialog, setDetailsDialog] = useState<{ meeting: SalesMeeting; survey: Survey | null; loading: boolean } | null>(null)
    const [editData, setEditData] = useState<MeetingFormData>(() => createMeetingFormData(getTodayDateInput()))
    const [meetingPickerMonth, setMeetingPickerMonth] = useState<Date>(() => toLocalDate(getTodayDateInput()))

    const selectedDateIso = useMemo(() => selectedDate || getTodayDateInput(), [selectedDate])
    const selectedWorker = useMemo(
        () => (salespersonFilter === 'all' ? null : workers.find((worker) => String(worker.id ?? '') === salespersonFilter) ?? null),
        [salespersonFilter, workers]
    )
    const effectiveMeetings = useMemo(
        () =>
            meetings.map((meeting) => {
                const effectiveScheduledAt = getSalesMeetingEffectiveScheduledAt(meeting)
                return effectiveScheduledAt === meeting.scheduled_at
                    ? meeting
                    : { ...meeting, scheduled_at: effectiveScheduledAt }
            }),
        [meetings]
    )
    const isSlotUnavailableForAdminMeeting = useCallback(
        (
            salespersonId: number | null | undefined,
            datePart: string,
            timePart: string,
            currentMeetingId?: number | null,
            now = new Date()
        ): boolean => {
            const scheduledAt = buildLocalScheduledAt(datePart, timePart)
            if (scheduledAt.getTime() <= now.getTime()) return true
            if (typeof salespersonId !== 'number') return false

            return effectiveMeetings.some((meeting) => {
                if (meeting.status === 'cancelled') return false
                if (typeof meeting.salesperson_id !== 'number' || meeting.salesperson_id !== salespersonId) return false
                if (typeof currentMeetingId === 'number' && meeting.id === currentMeetingId) return false
                return (
                    getScheduledDatePart(meeting.scheduled_at) === datePart &&
                    getScheduledTimePart(meeting.scheduled_at) === timePart
                )
            })
        },
        [effectiveMeetings]
    )
    const getFirstAvailableAdminSlot = useCallback(
        (salespersonId: number | null | undefined, datePart: string, currentMeetingId?: number | null, now = new Date()): string | null =>
            APPOINTMENT_SLOTS.find((slot) => !isSlotUnavailableForAdminMeeting(salespersonId, datePart, slot, currentMeetingId, now)) ?? null,
        [isSlotUnavailableForAdminMeeting]
    )
    const isFormOpen = Boolean(editing) || isCreateOpen
    const scheduledDatePart = useMemo(() => getScheduledDatePart(editData.scheduled_at), [editData.scheduled_at])
    const scheduledTimePart = useMemo(() => getScheduledTimePart(editData.scheduled_at), [editData.scheduled_at])
    const scheduledDateValue = useMemo(() => toLocalDate(scheduledDatePart), [scheduledDatePart])
    const meetingTimeOptions = useMemo(
        () => Array.from(new Set([scheduledTimePart, ...APPOINTMENT_SLOTS])).sort((left, right) => left.localeCompare(right)),
        [scheduledTimePart]
    )
    const meetingFormDateValue = useMemo(
        () => (editData.scheduled_at ? new Date(editData.scheduled_at) : null),
        [editData.scheduled_at]
    )
    const statusDraftDatePart = useMemo(() => getScheduledDatePart(statusDraftScheduledAt), [statusDraftScheduledAt])
    const statusDraftTimePart = useMemo(() => getScheduledTimePart(statusDraftScheduledAt), [statusDraftScheduledAt])
    const statusDraftDateValue = useMemo(() => toLocalDate(statusDraftDatePart), [statusDraftDatePart])
    const statusTimeOptions = useMemo(
        () => Array.from(new Set([statusDraftTimePart, ...APPOINTMENT_SLOTS])).sort((left, right) => left.localeCompare(right)),
        [statusDraftTimePart]
    )
    const unavailableStatusTimeSlots = useMemo(
        () =>
            new Set(
                statusTimeOptions.filter((slot) => {
                    if (!statusDetailsMeeting?.id) return false
                    return slot !== statusDraftTimePart && isSlotUnavailableForAdminMeeting(
                        statusDetailsMeeting.salesperson_id,
                        statusDraftDatePart,
                        slot,
                        statusDetailsMeeting.id
                    )
                })
            ),
        [
            isSlotUnavailableForAdminMeeting,
            statusDetailsMeeting?.id,
            statusDetailsMeeting?.salesperson_id,
            statusDraftDatePart,
            statusDraftTimePart,
            statusTimeOptions
        ]
    )
    const unavailableTimeSlots = useMemo(
        () =>
            new Set(
                meetingTimeOptions.filter((slot) =>
                    isSlotUnavailableForAdminMeeting(
                        editData.salesperson_id ? Number(editData.salesperson_id) : null,
                        scheduledDatePart,
                        slot,
                        editing?.id ?? null
                    )
                )
            ),
        [editData.salesperson_id, editing?.id, isSlotUnavailableForAdminMeeting, meetingTimeOptions, scheduledDatePart]
    )
    const isMeetingFormValid = useMemo(() => {
        const hasValidDate = Boolean(meetingFormDateValue && !Number.isNaN(meetingFormDateValue.getTime()))
        const hasFutureDate = Boolean(hasValidDate && !isScheduledTermInPast(editData.scheduled_at))
        const hasWorker = Boolean(editData.salesperson_id && workers.some((item) => String(item.id) === editData.salesperson_id))
        const hasLeadSource = Boolean(editData.lead_source.trim())
        const hasClientName = Boolean(editData.client_name.trim())
        const hasPhone = editData.phone.replace(/\D+/g, '').length >= 9
        const hasAddress = Boolean(editData.address.trim())
        const hasRegion = Boolean(editData.region.trim())

        const hasAvailableSlot = !isSlotUnavailableForAdminMeeting(
            editData.salesperson_id ? Number(editData.salesperson_id) : null,
            scheduledDatePart,
            scheduledTimePart,
            editing?.id ?? null
        )

        return hasValidDate && hasFutureDate && hasWorker && hasLeadSource && hasClientName && hasPhone && hasAddress && hasRegion && hasAvailableSlot
    }, [
        editData.address,
        editData.client_name,
        editData.lead_source,
        editData.phone,
        editData.region,
        editData.salesperson_id,
        editData.scheduled_at,
        editing?.id,
        isSlotUnavailableForAdminMeeting,
        meetingFormDateValue,
        scheduledDatePart,
        scheduledTimePart,
        workers
    ])
    const localityOptions = useMemo(
        () =>
            Array.from(
                new Set(
                    meetings
                        .map((meeting) => getSalesMeetingLocalityLabel(meeting))
                        .filter(Boolean)
                )
            ).sort((left, right) => left.localeCompare(right, 'pl')),
        [meetings]
    )
    const visibleMeetings = useMemo(() => {
        const nextMeetings = meetings
            .filter((meeting) => {
                if (hideCancelled && meeting.status === 'cancelled') return false
                if (hideCompleted && isMeetingLockedForAdmin(meeting) && meeting.status !== 'cancelled') return false
                if (localityFilter !== 'all' && getSalesMeetingLocalityLabel(meeting) !== localityFilter) return false
                if (addressPrecisionFilter === 'exact' && needsSalesMeetingAddressClarification(meeting)) return false
                if (addressPrecisionFilter === 'needs_clarification' && !needsSalesMeetingAddressClarification(meeting)) return false
                if (!selectedWorker) return true

                const byId =
                    typeof meeting.salesperson_id === 'number' &&
                    typeof selectedWorker.id === 'number' &&
                    meeting.salesperson_id === selectedWorker.id
                const byName = normalizeForKey(meeting.salesperson_name ?? '') === normalizeForKey(selectedWorker.name ?? '')
                const byLogin = normalizeForKey(meeting.salesperson_name ?? '') === normalizeForKey(selectedWorker.login ?? '')

                return byId || byName || byLogin
            })
            .slice()

        nextMeetings.sort((left, right) => {
            const timeDiff = new Date(left.scheduled_at).getTime() - new Date(right.scheduled_at).getTime()
            if (timeDiff !== 0) return timeDiff
            return normalizeForKey(left.client_name).localeCompare(normalizeForKey(right.client_name), 'pl')
        })

        return nextMeetings
    }, [addressPrecisionFilter, hideCancelled, hideCompleted, localityFilter, meetings, selectedWorker])
    const visibleMeetingGroups = useMemo(() => {
        const groups: { key: string; hourLabel: string; meetings: SalesMeeting[] }[] = []
        let currentGroup: { key: string; hourLabel: string; meetings: SalesMeeting[] } | null = null

        visibleMeetings.forEach((meeting) => {
            const scheduledAt = new Date(meeting.scheduled_at)
            const hourLabel = `${String(scheduledAt.getHours()).padStart(2, '0')}:00`
            const groupKey = `${selectedDateIso}-${hourLabel}`

            if (!currentGroup || currentGroup.key !== groupKey) {
                currentGroup = { key: groupKey, hourLabel, meetings: [] }
                groups.push(currentGroup)
            }

            currentGroup.meetings.push(meeting)
        })

        return groups
    }, [selectedDateIso, visibleMeetings])
    const meetingStats = useMemo(
        () => ({
            total: meetings.length,
            visible: visibleMeetings.length,
            groups: visibleMeetingGroups.length,
            clarification: visibleMeetings.filter((meeting) => needsSalesMeetingAddressClarification(meeting)).length
        }),
        [meetings.length, visibleMeetingGroups.length, visibleMeetings]
    )

    const fetchWorkers = useCallback(async (): Promise<User[]> => {
        const { data, error } = await supabase.from('users').select('*').eq('role', 'worker').order('name', { ascending: true })
        if (error) {
            toast.error(`Nie udało się pobrać listy handlowców: ${error.message}`)
            return []
        }
        return data || []
    }, [])

    const loadWorkers = useCallback(async () => {
        const nextWorkers = await fetchWorkers()
        setWorkers(nextWorkers)
    }, [fetchWorkers])

    const loadMeetings = useCallback(async () => {
        setLoading(true)
        const from = `${selectedDateIso}T00:00:00`
        const to = `${selectedDateIso}T23:59:59`

        let query = supabase
            .from('sales_meetings')
            .select('*')
            .gte('scheduled_at', from)
            .lte('scheduled_at', to)
            .order('scheduled_at', { ascending: true })

        if (statusFilter !== 'all') query = query.eq('status', statusFilter)

        const { data, error } = await query
        if (error) {
            toast.error(`Nie udało się pobrać spotkań: ${error.message}`)
            setLoading(false)
            return
        }

        setMeetings((data || []) as SalesMeeting[])
        setLoading(false)
    }, [selectedDateIso, statusFilter])

    useEffect(() => {
        void loadWorkers()
    }, [loadWorkers])

    useEffect(() => {
        void loadMeetings()
    }, [loadMeetings])

    useEffect(() => {
        if (!isFormOpen) return
        setMeetingPickerMonth(scheduledDateValue)
    }, [isFormOpen, scheduledDateValue])

    const parseImportFile = async (availableWorkers: User[] = workers): Promise<{ rows: ImportPayload[]; errors: string[] }> => {
        if (!file) return { rows: [], errors: ['Brak pliku CSV do importu.'] }
        if (availableWorkers.length === 0) {
            return {
                rows: [],
                errors: ['Lista handlowcow nie jest jeszcze gotowa. Poczekaj chwile na zaladowanie kont i sprobuj ponownie.']
            }
        }
        const text = (await file.text()).replace(/\r/g, '').trim()
        if (!text) return { rows: [], errors: ['Plik CSV jest pusty.'] }

        const lines = text.split('\n').filter((line) => line.trim().length > 0)
        if (lines.length < 2) return { rows: [], errors: ['Plik CSV musi miec naglowek i przynajmniej 1 wiersz danych.'] }

        const delimiter = detectDelimiter(lines[0])
        const headers = parseCsvLine(lines[0], delimiter)
        const idxSalesperson = getHeaderIndex(headers, HEADER_ALIASES.salesperson)
        const idxLeadSource = getHeaderIndex(headers, HEADER_ALIASES.leadSource)
        const idxDateTime = getHeaderIndex(headers, HEADER_ALIASES.dateTime)
        const idxDate = getHeaderIndex(headers, HEADER_ALIASES.date)
        const idxTime = getHeaderIndex(headers, HEADER_ALIASES.time)
        const idxPhone = getHeaderIndex(headers, HEADER_ALIASES.phone)
        const idxName = getHeaderIndex(headers, HEADER_ALIASES.name)
        const idxFirstName = getHeaderIndex(headers, HEADER_ALIASES.firstName)
        const idxLastName = getHeaderIndex(headers, HEADER_ALIASES.lastName)
        const idxRegion = getHeaderIndex(headers, HEADER_ALIASES.region)
        const idxAddress = getHeaderIndex(headers, HEADER_ALIASES.address)
        const idxNote = getHeaderIndex(headers, HEADER_ALIASES.note)

        const errors: string[] = []
        const rows: ImportPayload[] = []

        if (idxSalesperson < 0) errors.push('Brak kolumny "Handlowiec".')
        if (idxLeadSource < 0) errors.push('Brak kolumny "Źródło pozyskania leada".')
        if (idxDateTime < 0 && idxDate < 0) errors.push('Brak kolumny "Data i godzina spotkania" albo zestawu "Data" + "Godzina".')
        if (idxName < 0 && idxFirstName < 0 && idxLastName < 0) {
            errors.push('Brak kolumny "Imie i nazwisko" albo kolumn "Imie" / "Nazwisko".')
        }
        if (idxAddress < 0) errors.push('Brak kolumny "Adres".')
        if (errors.length > 0) return { rows, errors }

        lines.slice(1).forEach((line, index) => {
            const rowNo = index + 2
            const cols = parseCsvLine(line, delimiter)
            const rawSalesperson = idxSalesperson >= 0 ? cols[idxSalesperson] ?? '' : ''
            const rawLeadSource = idxLeadSource >= 0 ? cols[idxLeadSource] ?? '' : ''
            const rawDateTime = idxDateTime >= 0 ? cols[idxDateTime] ?? '' : ''
            const rawDate = idxDate >= 0 ? cols[idxDate] ?? '' : ''
            const rawTime = idxTime >= 0 ? cols[idxTime] ?? '' : ''
            const rawName = idxName >= 0 ? cols[idxName] ?? '' : ''
            const rawFirstName = idxFirstName >= 0 ? cols[idxFirstName] ?? '' : ''
            const rawLastName = idxLastName >= 0 ? cols[idxLastName] ?? '' : ''
            const rawAddress = cols[idxAddress] ?? ''
            const rawPhone = idxPhone >= 0 ? cols[idxPhone] ?? '' : ''
            const rawRegion = idxRegion >= 0 ? cols[idxRegion] ?? '' : ''
            const rawNote = idxNote >= 0 ? cols[idxNote] ?? '' : ''

            const meetingDateTime = getMeetingDateTimeValue(rawDateTime, rawDate, rawTime)
            const scheduledAt = parseDateTime(meetingDateTime)
            if (!scheduledAt) {
                errors.push(`Wiersz ${rowNo}: niepoprawna data/godzina "${meetingDateTime || rawDateTime}".`)
                return
            }

            const clientName = getClientName(rawName, rawFirstName, rawLastName)
            if (!clientName) {
                errors.push(`Wiersz ${rowNo}: puste imie i nazwisko.`)
                return
            }

            const address = rawAddress.trim()
            if (!address) {
                errors.push(`Wiersz ${rowNo}: pusty adres.`)
                return
            }

            const salespersonLabel = rawSalesperson.trim()
            const workerMatch = salespersonLabel ? findWorkerByValue(availableWorkers, salespersonLabel) : { kind: 'empty' as const }

            if (!salespersonLabel) {
                errors.push(`Wiersz ${rowNo}: pusta wartosc w kolumnie "Handlowiec".`)
                return
            }

            if (workerMatch.kind === 'ambiguous') {
                const candidates = workerMatch.candidates?.join(', ') ?? 'kilku handlowcow'
                errors.push(`Wiersz ${rowNo}: wartosc "${salespersonLabel}" pasuje do wielu kont: ${candidates}.`)
                return
            }

            if (workerMatch.kind !== 'matched') {
                errors.push(
                    `Wiersz ${rowNo}: nie znaleziono konta handlowca "${salespersonLabel}". Uzyj loginu albo imienia i nazwiska z istniejacego profilu.`
                )
                return
            }

            const resolvedWorker = workerMatch.worker

            const normalizedAddress = normalizeSalesMeetingAddress(address) || address
            const importKey = buildSalesMeetingImportKey({
                salespersonId: resolvedWorker.id,
                scheduledAt,
                clientName,
                address: normalizedAddress
            })

            rows.push({
                import_key: importKey,
                salesperson_id: resolvedWorker.id,
                salesperson_name: resolvedWorker.name,
                lead_source: normalizeSalesMeetingInlineText(rawLeadSource) || null,
                scheduled_at: scheduledAt,
                phone: rawPhone.trim() || null,
                client_name: clientName,
                region: rawRegion.trim() || null,
                address: normalizedAddress,
                note: normalizeSalesMeetingInlineText(rawNote) || null,
                status: 'planned',
                imported_at: new Date().toISOString()
            })
        })

        const occupiedSlots = new Map<string, ImportPayload>()
        rows.forEach((row) => {
            const slotKey = buildSalesMeetingSlotKey(row.salesperson_id ?? null, row.scheduled_at)
            const existingRow = occupiedSlots.get(slotKey)
            if (existingRow && existingRow.import_key !== row.import_key) {
                errors.push(
                    `Konflikt terminów: ${row.salesperson_name} ma więcej niż jedno spotkanie na ${format(new Date(row.scheduled_at), 'dd.MM.yyyy HH:mm')}.`
                )
                return
            }

            occupiedSlots.set(slotKey, row)
        })

        return { rows, errors }
    }

    const validateImportedSlotConflicts = useCallback(async (rows: ImportPayload[]): Promise<string[]> => {
        const salespersonIds = Array.from(
            new Set(
                rows
                    .map((row) => row.salesperson_id)
                    .filter((value): value is number => typeof value === 'number')
            )
        )
        if (salespersonIds.length === 0) return []

        const scheduledValues = rows
            .map((row) => new Date(row.scheduled_at).toISOString())
            .sort((left, right) => left.localeCompare(right))
        if (scheduledValues.length === 0) return []

        const { data, error } = await supabase
            .from('sales_meetings')
            .select('id, import_key, salesperson_id, salesperson_name, scheduled_at, client_name, address, status')
            .in('salesperson_id', salespersonIds)
            .gte('scheduled_at', scheduledValues[0])
            .lte('scheduled_at', scheduledValues[scheduledValues.length - 1])
            .neq('status', 'cancelled')

        if (error) throw error

        const importedBySlot = new Map(rows.map((row) => [buildSalesMeetingSlotKey(row.salesperson_id ?? null, row.scheduled_at), row] as const))
        const conflicts = new Set<string>()

        ;((data || []) as SalesMeeting[]).forEach((meeting) => {
            const importedRow = importedBySlot.get(buildSalesMeetingSlotKey(meeting.salesperson_id ?? null, meeting.scheduled_at))
            if (!importedRow || importedRow.import_key === meeting.import_key) return

            conflicts.add(
                `Konflikt terminów: ${meeting.salesperson_name || importedRow.salesperson_name} ma już spotkanie ${format(new Date(meeting.scheduled_at), 'dd.MM.yyyy HH:mm')} (${meeting.client_name}).`
            )
        })

        return Array.from(conflicts)
    }, [])

    const persistImportedRows = async (rows: ImportPayload[]): Promise<SalesMeeting[]> => {
        const importKeys = rows.map((row) => row.import_key)
        const { data: existingRows, error: existingError } = await supabase
            .from('sales_meetings')
            .select('*')
            .in('import_key', importKeys)

        if (existingError) throw existingError

        const mergedRows = rows.map((row) =>
            mergeImportedRowWithExistingMeeting(
                row,
                ((existingRows || []) as SalesMeeting[]).find((meeting) => meeting.import_key === row.import_key) || null
            )
        )

        const { error } = await supabase.from('sales_meetings').upsert(mergedRows, { onConflict: 'import_key' })

        if (!error) {
            const { data: savedMeetings, error: savedMeetingsError } = await supabase
                .from('sales_meetings')
                .select('*')
                .in('import_key', importKeys)

            if (savedMeetingsError) throw savedMeetingsError
            return (savedMeetings || []) as SalesMeeting[]
        }

        if (!shouldFallbackToManualImport(error)) {
            throw error
        }

        const existingByKey = new Map(
            ((existingRows || []) as SalesMeeting[])
                .filter((row): row is SalesMeeting & { id: number } => typeof row.id === 'number' && typeof row.import_key === 'string')
                .map((row) => [row.import_key, row])
        )

        for (const row of mergedRows) {
            const existingMeeting = existingByKey.get(row.import_key)
            const existingId = existingMeeting?.id

            if (existingId) {
                const { error: updateError } = await supabase.from('sales_meetings').update(row).eq('id', existingId)
                if (updateError) throw updateError
                continue
            }

            const { error: insertError } = await supabase.from('sales_meetings').insert(row)
            if (insertError) throw insertError
        }

        const { data: savedMeetings, error: savedMeetingsError } = await supabase
            .from('sales_meetings')
            .select('*')
            .in('import_key', importKeys)

        if (savedMeetingsError) throw savedMeetingsError
        return (savedMeetings || []) as SalesMeeting[]
    }

    const handleImport = async () => {
        setImporting(true)

        try {
            const latestWorkers = await fetchWorkers()
            setWorkers(latestWorkers)
            const { rows, errors } = await parseImportFile(latestWorkers)
            if (errors.length > 0 || rows.length === 0) {
                toast.error(
                    errors.length > 0 ? renderImportIssuesToast(errors) : 'Nie znaleziono poprawnych rekordów do importu.',
                    { duration: 6500 }
                )
                setImporting(false)
                return
            }

            const conflictErrors = await validateImportedSlotConflicts(rows)
            if (conflictErrors.length > 0) {
                toast.error(renderImportIssuesToast(conflictErrors), { duration: 6500 })
                setImporting(false)
                return
            }

            const savedMeetings = await persistImportedRows(rows)
            try {
                await syncPoleAssignmentsForMeetings(savedMeetings)
            } catch (syncError) {
                console.warn('Imported meetings were saved, but pole assignment sync failed:', syncError)
                toast('Spotkania zapisane, ale część wpisów w tabeli działek nie zsynchronizowała się automatycznie.', {
                    icon: 'ℹ️'
                })
            }

            toast.success(`Zaimportowano/zaaktualizowano ${rows.length} spotkań.`)
            setFile(null)
            await loadMeetings()
        } catch (error) {
            console.error('Meeting import failed:', error)
            toast.error(`Import nie powiódł się: ${mapSalesMeetingsMutationError(error)}`)
        } finally {
            setImporting(false)
        }
    }

    const startEdit = (meeting: SalesMeeting) => {
        if (isMeetingLockedForAdmin(meeting)) {
            toast.error('To spotkanie jest już zamknięte i nie można go edytować.')
            return
        }
        setIsCreateOpen(false)
        setEditing(meeting)
        setEditData({
            salesperson_id: String(meeting.salesperson_id ?? ''),
            lead_source: normalizeSalesMeetingInlineText(meeting.lead_source),
            scheduled_at: toDateTimeLocalInput(meeting.scheduled_at),
            phone: meeting.phone ?? '',
            client_name: meeting.client_name,
            region: meeting.region ?? '',
            address: meeting.address,
            note: normalizeSalesMeetingInlineText(meeting.note)
        })
    }

    const closeMeetingForm = useCallback(() => {
        if (formSaving) return
        setEditing(null)
        setIsCreateOpen(false)
        setEditData(createMeetingFormData(selectedDateIso, selectedWorker?.id))
    }, [formSaving, selectedDateIso, selectedWorker])

    const openCreateModal = useCallback(() => {
        setEditing(null)
        setEditData(createMeetingFormData(selectedDateIso, selectedWorker?.id))
        setIsCreateOpen(true)
    }, [selectedDateIso, selectedWorker])

    const openMeetingSettings = (meeting: SalesMeeting) => {
        setSettingsDialog(meeting)
    }

    const closeMeetingSettings = () => {
        setSettingsDialog(null)
    }

    const handleSettingsEdit = () => {
        if (!settingsDialog) return
        const meeting = settingsDialog
        setSettingsDialog(null)
        startEdit(meeting)
    }

    const handleSettingsOpenDetails = async () => {
        if (!settingsDialog) return
        const meeting = settingsDialog
        setSettingsDialog(null)
        await openMeetingDetails(meeting)
    }

    const handleSettingsDelete = () => {
        if (!settingsDialog) return
        const meeting = settingsDialog
        setSettingsDialog(null)
        deleteMeeting(meeting)
    }

    const openStatusPicker = (meeting?: SalesMeeting | null) => {
        const targetMeeting = meeting ?? settingsDialog
        if (!targetMeeting) return
        setStatusPickerMeeting(targetMeeting)
        if (!meeting) {
            setSettingsDialog(null)
        }
    }

    const closeStatusPicker = () => {
        if (statusSaving) return
        setStatusPickerMeeting(null)
    }

    const openStatusDetails = (meeting: SalesMeeting, status: AdminSettableMeetingStatus) => {
        const nextScheduledAt =
            status === 'follow_up'
                ? getNextFollowUpDateTimeInput(meeting)
                : toDateTimeLocalInput(meeting.scheduled_at)

        setSelectedStatus(status)
        setStatusDraftNote(getSalesMeetingCleanStatusNote(meeting.status_note) ?? '')
        setStatusDraftScheduledAt(nextScheduledAt)
        setStatusPickerMonth(toLocalDate(getScheduledDatePart(nextScheduledAt)))
        setStatusDetailsMeeting(meeting)
        setStatusPickerMeeting(null)
    }

    const closeStatusDetails = () => {
        if (statusSaving) return
        setStatusDetailsMeeting(null)
        setSelectedStatus(null)
        setStatusDraftNote('')
        setStatusDraftScheduledAt(getDefaultMeetingDateTimeInput())
    }

    const handleStatusDateChange = (date?: Date) => {
        if (!date || !statusDetailsMeeting?.id) return
        const today = toLocalDate(getTodayDateInput())
        if (date < today) return

        const nextDatePart = format(date, 'yyyy-MM-dd')
        const nextTime = unavailableStatusTimeSlots.has(statusDraftTimePart)
            ? getFirstAvailableSlot(nextDatePart) ?? statusDraftTimePart
            : statusDraftTimePart

        setStatusPickerMonth(new Date(date.getFullYear(), date.getMonth(), 1))
        setStatusDraftScheduledAt(combineScheduledDateTime(nextDatePart, nextTime))
    }

    const handleStatusTimeChange = (slot: string) => {
        if (unavailableStatusTimeSlots.has(slot)) return
        setStatusDraftScheduledAt(combineScheduledDateTime(statusDraftDatePart, slot))
    }

    const resolveLatestShiftId = async (meeting: SalesMeeting): Promise<number | null> => {
        if (typeof meeting.salesperson_id !== 'number') return null

        const { data, error } = await supabase
            .from('shifts')
            .select('id')
            .eq('user_id', meeting.salesperson_id)
            .order('start_time', { ascending: false })
            .limit(1)
            .maybeSingle()

        if (error) {
            toast.error(`Nie udało się ustalić zmiany handlowca: ${error.message}`)
            return null
        }

        return typeof data?.id === 'number' ? data.id : null
    }

    const saveMeetingStatus = async () => {
        if (!statusDetailsMeeting?.id || !selectedStatus) return

        const meeting = statusDetailsMeeting
        const meetingId = meeting.id
        const note = statusDraftNote.trim()
        const surveyStatus = mapMeetingStatusToSurveyStatus(selectedStatus)
        const refusalStage = selectedStatus === 'refused' ? 'before_meeting' : null
        const rescheduledAt =
            selectedStatus === 'follow_up'
                ? new Date(statusDraftScheduledAt)
                : null

        if (adminStatusRequiresNote(selectedStatus) && !note) {
            toast.error('Dodaj notatkę do wybranego statusu.')
            return
        }

        if (selectedStatus === 'follow_up') {
            if (!rescheduledAt || Number.isNaN(rescheduledAt.getTime())) {
                toast.error('Wybierz poprawny termin kontaktu ponownego.')
                return
            }

            if (new Date(meeting.scheduled_at).getTime() === rescheduledAt.getTime()) {
                toast.error('Ustaw nowy termin kontaktu ponownego.')
                return
            }

            const slotConflict = await findSalesMeetingSlotConflict({
                salespersonId: meeting.salesperson_id,
                scheduledAt: rescheduledAt.toISOString(),
                excludeMeetingId: meeting.id
            })
            if (slotConflict) {
                toast.error(`Ten handlowiec ma już spotkanie na ten termin: ${slotConflict.client_name}.`)
                return
            }
        }

        setStatusSaving(true)
        try {
            let linkedSurveyId = meeting.linked_survey_id ?? null
            const surveyAnswers: Record<string, string> = {
                pole_status: mapMeetingStatusToPoleStatus(selectedStatus, refusalStage),
                source: 'sales_meeting_admin',
                meeting_id: String(meetingId),
                imported_note: meeting.note || ''
            }

            if (meeting.lead_source) {
                surveyAnswers.lead_source = meeting.lead_source
            }
            if (refusalStage) {
                surveyAnswers.refusal_stage = refusalStage
            }
            if (note) {
                surveyAnswers.status_note = note
            }
            if (selectedStatus === 'follow_up' && note) {
                surveyAnswers.notatka_z_kontaktu = note
            }

            const normalizedAddress = normalizeSalesMeetingAddress(meeting.address) || meeting.address || 'Brak adresu'
            const preferredDate = rescheduledAt ? format(rescheduledAt, 'yyyy-MM-dd') : undefined
            const preferredTime = rescheduledAt
                ? rescheduledAt.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })
                : undefined

            if (linkedSurveyId && selectedStatus !== 'follow_up' && surveyStatus) {
                const { error: updateSurveyError } = await supabase
                    .from('surveys')
                    .update({
                        status: surveyStatus,
                        respondent_name: meeting.client_name || undefined,
                        respondent_phone: meeting.phone || undefined,
                        address: normalizedAddress,
                        answers: surveyAnswers,
                        respondent_preferred_date: undefined,
                        respondent_preferred_time: undefined
                    })
                    .eq('id', linkedSurveyId)

                if (updateSurveyError) {
                    linkedSurveyId = null
                }
            }

            if ((!linkedSurveyId || selectedStatus === 'follow_up') && surveyStatus) {
                const latestShiftId = await resolveLatestShiftId(meeting)

                if (latestShiftId) {
                    const { data: insertedSurvey, error: insertSurveyError } = await supabase
                        .from('surveys')
                        .insert({
                            shift_id: latestShiftId,
                            user_id: meeting.salesperson_id ?? 0,
                            user_name: meeting.salesperson_name || 'Nieznany',
                            created_at: new Date().toISOString(),
                            status: surveyStatus,
                            respondent_name: meeting.client_name || undefined,
                            respondent_phone: meeting.phone || undefined,
                            address: normalizedAddress,
                            answers: surveyAnswers,
                            respondent_preferred_date: selectedStatus === 'follow_up' ? preferredDate : undefined,
                            respondent_preferred_time: selectedStatus === 'follow_up' ? preferredTime : undefined
                        })
                        .select('id')
                        .single()

                    if (insertSurveyError) {
                        throw insertSurveyError
                    }

                    linkedSurveyId = insertedSurvey.id
                } else {
                    toast('Nie znaleziono zmiany handlowca. Status zapisze się bez nowego wpisu w historii.', {
                        icon: 'ℹ️'
                    })
                }
            }

            const meetingUpdate: Partial<SalesMeeting> & { linked_survey_id?: number | null } = {
                status: selectedStatus,
                status_updated_at: new Date().toISOString(),
                linked_survey_id: linkedSurveyId
            }

            if (selectedStatus === 'refused') {
                meetingUpdate.status_note = buildSalesMeetingRefusalNote('before_meeting', note)
            } else if (selectedStatus === 'follow_up' && rescheduledAt) {
                meetingUpdate.scheduled_at = rescheduledAt.toISOString()
                meetingUpdate.status_note = buildSalesMeetingRescheduledNote(meeting.scheduled_at, rescheduledAt.toISOString(), note)
            } else {
                meetingUpdate.status_note = note || null
            }

            const { error: updateMeetingError } = await supabase
                .from('sales_meetings')
                .update(meetingUpdate)
                .eq('id', meetingId)

            if (updateMeetingError) {
                throw updateMeetingError
            }

            try {
                await syncPoleAssignmentsForMeetings([{
                    ...meeting,
                    ...meetingUpdate,
                    scheduled_at: meetingUpdate.scheduled_at || meeting.scheduled_at,
                    status: (meetingUpdate.status as SalesMeetingStatus) || meeting.status
                }])
            } catch (syncError) {
                console.warn('Meeting status saved without pole assignment sync:', syncError)
            }

            toast.success('Status spotkania zapisany.')
            closeStatusDetails()
            await loadMeetings()
        } catch (error) {
            toast.error(mapSalesMeetingsMutationError(error))
        } finally {
            setStatusSaving(false)
        }
    }

    const saveMeetingForm = async () => {
        const salespersonId = editData.salesperson_id ? Number(editData.salesperson_id) : null
        const worker = workers.find((item) => item.id === salespersonId)
        const dateValue = meetingFormDateValue

        if (!dateValue || Number.isNaN(dateValue.getTime())) {
            toast.error('Podaj poprawną datę i godzinę spotkania.')
            return
        }
        if (isScheduledTermInPast(editData.scheduled_at)) {
            toast.error('Nie można ustawić spotkania w przeszłości.')
            return
        }
        if (!salespersonId || !worker) {
            toast.error('Wybierz dostępnego handlowca.')
            return
        }
        if (!editData.lead_source.trim()) {
            toast.error('Wybierz źródło pozyskania leada.')
            return
        }
        if (!editData.client_name.trim()) {
            toast.error('Imię i nazwisko jest wymagane.')
            return
        }
        if (editData.phone.replace(/\D+/g, '').length < 9) {
            toast.error('Podaj poprawny numer telefonu.')
            return
        }
        if (!editData.address.trim()) {
            toast.error('Adres jest wymagany.')
            return
        }
        if (!editData.region.trim()) {
            toast.error('Wybierz województwo.')
            return
        }

        const normalizedAddress = normalizeSalesMeetingAddress(editData.address) || editData.address.trim()
        const scheduledAtIso = dateValue.toISOString()
        const slotConflict = await findSalesMeetingSlotConflict({
            salespersonId,
            scheduledAt: scheduledAtIso,
            excludeMeetingId: editing?.id ?? null
        })
        if (slotConflict) {
            toast.error(`Ten termin jest już zajęty przez: ${slotConflict.client_name}.`)
            return
        }

        const payload = {
            salesperson_id: salespersonId,
            salesperson_name: worker.name,
            lead_source: normalizeSalesMeetingInlineText(editData.lead_source) || null,
            scheduled_at: scheduledAtIso,
            phone: editData.phone.trim() || null,
            client_name: editData.client_name.trim(),
            region: editData.region.trim() || null,
            address: normalizedAddress,
            note: normalizeSalesMeetingInlineText(editData.note) || null
        }

        setFormSaving(true)
        try {
            let savedWithoutLeadSource = false
            let savedMeeting: SalesMeeting | null = null

            if (editing?.id) {
                let response = await supabase.from('sales_meetings').update(payload).eq('id', editing.id).select('*').single()
                let { error } = response
                if (error && isMissingSalesMeetingsLeadSourceColumnError(error)) {
                    savedWithoutLeadSource = true
                    response = await supabase.from('sales_meetings').update(omitLeadSource(payload)).eq('id', editing.id).select('*').single()
                    error = response.error
                }
                if (error) {
                    toast.error(`Nie udało się zapisać zmian: ${mapSalesMeetingsMutationError(error)}`)
                    return
                }
                savedMeeting = (response.data as SalesMeeting | null) ?? null

                closeMeetingForm()
                toast.success(
                    savedWithoutLeadSource
                        ? 'Zapisano zmiany spotkania, ale bez pola "Źródło pozyskania leada" - w bazie brakuje kolumny "lead_source".'
                        : 'Zapisano zmiany spotkania.'
                )
            } else {
                const insertPayload = {
                    ...payload,
                    status: 'planned' as SalesMeetingStatus,
                    imported_at: new Date().toISOString(),
                    import_key: buildSalesMeetingImportKey({
                        salespersonId,
                        scheduledAt: payload.scheduled_at,
                        clientName: payload.client_name,
                        address: payload.address
                    })
                }

                let response = await supabase
                    .from('sales_meetings')
                    .upsert(insertPayload, { onConflict: 'import_key' })
                    .select('*')
                    .single()
                let { error } = response
                if (error && isMissingSalesMeetingsLeadSourceColumnError(error)) {
                    savedWithoutLeadSource = true
                    response = await supabase
                        .from('sales_meetings')
                        .upsert(omitLeadSource(insertPayload), { onConflict: 'import_key' })
                        .select('*')
                        .single()
                    error = response.error
                }
                if (error) {
                    toast.error(`Nie udało się dodać spotkania: ${mapSalesMeetingsMutationError(error)}`)
                    return
                }
                savedMeeting = (response.data as SalesMeeting | null) ?? null

                closeMeetingForm()
                toast.success(
                    savedWithoutLeadSource
                        ? 'Spotkanie dodane, ale bez pola "Źródło pozyskania leada" - w bazie brakuje kolumny "lead_source".'
                        : 'Spotkanie dodane.'
                )
            }

            if (savedMeeting) {
                try {
                    await syncPoleAssignmentsForMeetings([savedMeeting])
                } catch (syncError) {
                    console.warn('Meeting saved without pole assignment sync:', syncError)
                    toast('Spotkanie zapisane, ale wpis w tabeli działek nie zsynchronizował się automatycznie.', {
                        icon: 'ℹ️'
                    })
                }
            }

            await loadMeetings()
        } finally {
            setFormSaving(false)
        }
    }

    const confirmCancelMeeting = async () => {
        if (!cancelDialog?.meeting.id) return
        setCancelSaving(true)
        const sourceMeeting = cancelDialog.meeting
        const payload = {
            status: 'cancelled' as SalesMeetingStatus,
            cancelled_reason: cancelDialog.reason.trim() || null,
            status_updated_at: new Date().toISOString()
        }
        const { error } = await supabase.from('sales_meetings').update(payload).eq('id', cancelDialog.meeting.id)
        if (error) {
            toast.error(`Nie udało się anulować spotkania: ${error.message}`)
            setCancelSaving(false)
            return
        }
        try {
            await syncPoleAssignmentsForMeetings([{
                ...sourceMeeting,
                ...payload
            }])
        } catch (syncError) {
            console.warn('Meeting cancellation saved without pole assignment sync:', syncError)
        }
        toast.success('Spotkanie zostalo anulowane.')
        setCancelDialog(null)
        setCancelSaving(false)
        await loadMeetings()
    }

    const cancelMeeting = (meeting: SalesMeeting) => {
        if (isMeetingLockedForAdmin(meeting)) {
            toast.error('To spotkanie jest już zamknięte i nie można go anulować.')
            return
        }
        setCancelDialog({
            meeting,
            reason: meeting.cancelled_reason ?? ''
        })
    }

    const deleteMeeting = (meeting: SalesMeeting) => {
        setDeleteDialog(meeting)
    }

    const openMeetingDetails = async (meeting: SalesMeeting) => {
        setDetailsDialog({ meeting, survey: null, loading: Boolean(meeting.linked_survey_id) })

        if (!meeting.linked_survey_id) return

        const { data, error } = await supabase.from('surveys').select('*').eq('id', meeting.linked_survey_id).maybeSingle()
        if (error) {
            toast.error(`Nie udało się pobrać szczegółów spotkania: ${error.message}`)
            setDetailsDialog((prev) =>
                prev && prev.meeting.id === meeting.id
                    ? { ...prev, survey: null, loading: false }
                    : prev
            )
            return
        }

        setDetailsDialog((prev) =>
            prev && prev.meeting.id === meeting.id
                ? { ...prev, survey: (data as Survey | null) ?? null, loading: false }
                : prev
        )
    }

    const confirmDeleteMeeting = async () => {
        if (!deleteDialog?.id) return
        setDeleteSaving(true)

        const { error } = await supabase.from('sales_meetings').delete().eq('id', deleteDialog.id)
        if (error) {
            toast.error(`Nie udało się usunąć wiersza: ${error.message}`)
            setDeleteSaving(false)
            return
        }

        toast.success('Wiersz zostal usuniety.')
        setDeleteDialog(null)
        setDeleteSaving(false)
        await loadMeetings()
    }

    const handleScheduledDateChange = (date?: Date) => {
        if (!date) return
        const today = toLocalDate(getTodayDateInput())
        if (date < today) return

        const year = date.getFullYear()
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        const nextDatePart = `${year}-${month}-${day}`

        setEditData((prev) => ({
            ...prev,
            scheduled_at: combineScheduledDateTime(
                nextDatePart,
                isSlotUnavailableForAdminMeeting(
                    prev.salesperson_id ? Number(prev.salesperson_id) : null,
                    nextDatePart,
                    getScheduledTimePart(prev.scheduled_at),
                    editing?.id ?? null
                )
                    ? getFirstAvailableAdminSlot(
                        prev.salesperson_id ? Number(prev.salesperson_id) : null,
                        nextDatePart,
                        editing?.id ?? null
                    ) ?? getScheduledTimePart(prev.scheduled_at)
                    : getScheduledTimePart(prev.scheduled_at)
            )
        }))
    }

    const handleScheduledTimeChange = (time: string) => {
        if (isSlotUnavailableForAdminMeeting(
            editData.salesperson_id ? Number(editData.salesperson_id) : null,
            getScheduledDatePart(editData.scheduled_at),
            time,
            editing?.id ?? null
        )) return
        setEditData((prev) => ({
            ...prev,
            scheduled_at: combineScheduledDateTime(getScheduledDatePart(prev.scheduled_at), time)
        }))
    }

    return (
        <div className="space-y-4">
            <div className={`${card} p-4 space-y-4`}>
                <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                    <div className="min-w-0">
                        <h3 className="text-sm font-black text-slate-800 dark:text-white uppercase tracking-widest">Zaplanowane spotkania</h3>
                        <p className="mt-1 text-xs font-semibold text-slate-500 dark:text-slate-300">
                            Widok jest teraz szeroki i czytelny, bez wciskania głównej sekcji w boczną kolumnę.
                        </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 xl:min-w-[520px] xl:grid-cols-4">
                        <div className="rounded-2xl border border-cyan-300/70 bg-cyan-50/80 px-3 py-3 text-cyan-700 dark:border-cyan-400/20 dark:bg-cyan-500/10 dark:text-cyan-200">
                            <p className="text-[10px] font-black uppercase tracking-[0.18em] opacity-75">Widoczne</p>
                            <p className="mt-2 text-2xl font-black leading-none">{meetingStats.visible}</p>
                        </div>
                        <div className="rounded-2xl border border-violet-300/70 bg-violet-50/80 px-3 py-3 text-violet-700 dark:border-violet-400/20 dark:bg-violet-500/10 dark:text-violet-200">
                            <p className="text-[10px] font-black uppercase tracking-[0.18em] opacity-75">Sloty</p>
                            <p className="mt-2 text-2xl font-black leading-none">{meetingStats.groups}</p>
                        </div>
                        <div className="rounded-2xl border border-emerald-300/70 bg-emerald-50/80 px-3 py-3 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-500/10 dark:text-emerald-200">
                            <p className="text-[10px] font-black uppercase tracking-[0.18em] opacity-75">Łącznie</p>
                            <p className="mt-2 text-2xl font-black leading-none">{meetingStats.total}</p>
                        </div>
                        <div className="rounded-2xl border border-rose-300/70 bg-rose-50/80 px-3 py-3 text-rose-700 dark:border-rose-400/20 dark:bg-rose-500/10 dark:text-rose-200">
                            <p className="text-[10px] font-black uppercase tracking-[0.18em] opacity-75">Adresy</p>
                            <p className="mt-2 text-2xl font-black leading-none">{meetingStats.clarification}</p>
                        </div>
                    </div>
                </div>

                <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_220px_220px]">
                    <label className="min-w-0">
                        <input
                            type="file"
                            accept=".csv,text/csv"
                            onChange={(event) => setFile(event.target.files?.[0] || null)}
                            className="hidden"
                        />
                        <span className="w-full h-11 px-4 inline-flex items-center rounded-xl border border-dashed border-cyan-300 bg-cyan-50 dark:bg-cyan-900/20 text-cyan-700 dark:text-cyan-300 text-sm font-bold cursor-pointer">
                            {file ? `Plik: ${file.name}` : 'Wybierz plik CSV do importu'}
                        </span>
                    </label>
                    <button
                        type="button"
                        onClick={openCreateModal}
                        className="ui-pressable h-11 px-5 rounded-xl border border-emerald-300/40 bg-emerald-500 text-white font-black text-xs uppercase tracking-widest shadow-xl shadow-emerald-500/20 hover:bg-emerald-400"
                    >
                        + Dodaj spotkanie
                    </button>
                    <button
                        type="button"
                        disabled={!file || importing}
                        onClick={handleImport}
                        className="ui-pressable h-11 px-5 rounded-xl border border-cyan-300/40 bg-cyan-500 text-white font-black text-xs uppercase tracking-widest shadow-xl shadow-cyan-500/20 hover:bg-cyan-400 disabled:opacity-40"
                    >
                        {importing ? 'Importowanie...' : 'Importuj spotkania'}
                    </button>
                </div>
            </div>

            <div className={`${card} p-4 space-y-4`}>
                <div className="flex flex-wrap items-center gap-3">
                    <h3 className="shrink-0 whitespace-nowrap text-[10px] font-black text-gray-400 uppercase tracking-widest">
                        Spotkania na dzien {selectedDateIso} ({visibleMeetings.length})
                    </h3>
                    <div className="ml-auto flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
                        <label className="inline-flex items-center gap-2 text-[10px] font-black text-gray-300 uppercase tracking-wider whitespace-nowrap">
                            <input
                                type="checkbox"
                                checked={hideCancelled}
                                onChange={(event) => setHideCancelled(event.target.checked)}
                                className="h-4 w-4 rounded border-gray-300 text-cyan-500 focus:ring-cyan-500"
                            />
                            Ukryj anulowane
                        </label>
                        <label className="inline-flex items-center gap-2 text-[10px] font-black text-gray-300 uppercase tracking-wider whitespace-nowrap">
                            <input
                                type="checkbox"
                                checked={hideCompleted}
                                onChange={(event) => setHideCompleted(event.target.checked)}
                                className="h-4 w-4 rounded border-gray-300 text-cyan-500 focus:ring-cyan-500"
                            />
                            Ukryj odbyte
                        </label>
                        <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-2">
                            <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider">Status</label>
                            <select
                                value={statusFilter}
                                onChange={(event) => setStatusFilter(event.target.value as 'all' | SalesMeetingStatus)}
                                className="h-9 min-w-[132px] border border-gray-200 dark:border-slate-600 bg-gray-50 dark:bg-slate-700/50 rounded-lg px-3 text-xs dark:text-white"
                            >
                                <option value="all">Wszystkie</option>
                                {SALES_MEETING_STATUSES.map((status) => (
                                    <option key={status.key} value={status.key}>
                                        {status.label}
                                    </option>
                                ))}
                            </select>
                            <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider">Handlowiec</label>
                            <select
                                value={salespersonFilter}
                                onChange={(event) => setSalespersonFilter(event.target.value)}
                                className="h-9 min-w-[170px] border border-gray-200 dark:border-slate-600 bg-gray-50 dark:bg-slate-700/50 rounded-lg px-3 text-xs dark:text-white"
                            >
                                <option value="all">Wszystkie konta</option>
                                {workers
                                    .filter((worker): worker is User & { id: number } => typeof worker.id === 'number')
                                    .map((worker) => (
                                        <option key={worker.id} value={String(worker.id)}>
                                            {worker.name}
                                        </option>
                                    ))}
                            </select>
                            <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider">Miejscowość</label>
                            <select
                                value={localityFilter}
                                onChange={(event) => setLocalityFilter(event.target.value)}
                                className="h-9 min-w-[170px] border border-gray-200 dark:border-slate-600 bg-gray-50 dark:bg-slate-700/50 rounded-lg px-3 text-xs dark:text-white"
                            >
                                <option value="all">Wszystkie</option>
                                {localityOptions.map((locality) => (
                                    <option key={locality} value={locality}>
                                        {locality}
                                    </option>
                                    ))}
                            </select>
                            <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider">Adres</label>
                            <select
                                value={addressPrecisionFilter}
                                onChange={(event) => setAddressPrecisionFilter(event.target.value as AddressPrecisionFilter)}
                                className="h-9 min-w-[170px] border border-gray-200 dark:border-slate-600 bg-gray-50 dark:bg-slate-700/50 rounded-lg px-3 text-xs dark:text-white"
                            >
                                <option value="all">Wszystkie</option>
                                <option value="needs_clarification">Do doprecyzowania</option>
                                <option value="exact">Dokładne</option>
                            </select>
                        </div>
                    </div>
                </div>

                {loading ? (
                    <p className="text-xs text-gray-400 font-bold uppercase tracking-wider">Ładowanie spotkań...</p>
                ) : (
                    <div className="space-y-5 max-h-[60vh] overflow-y-auto pr-1">
                        {visibleMeetingGroups.map((group) => (
                            <div key={group.key} className="grid gap-3 md:grid-cols-[76px_minmax(0,1fr)] md:gap-4">
                                <div className="md:pt-3">
                                    <div className="inline-flex items-center rounded-xl border border-cyan-300/40 bg-cyan-50/80 px-3 py-2 shadow-sm dark:border-cyan-400/20 dark:bg-cyan-500/10">
                                        <span className="text-base font-black tracking-tight text-cyan-700 dark:text-cyan-200">{group.hourLabel}</span>
                                    </div>
                                </div>

                                <div className="space-y-3 md:border-l md:border-slate-200 md:pl-4 md:dark:border-slate-700">
                                    {group.meetings.map((meeting) => {
                                        const statusMeta = getSalesMeetingDisplayMeta(meeting)
                                        const isLockedMeeting = isMeetingLockedForAdmin(meeting)
                                        const isCancelledMeeting = statusMeta.baseKey === 'cancelled'
                                        const isMissedMeeting = statusMeta.isMissed
                                        const requiresAddressClarification = needsSalesMeetingAddressClarification(meeting)
                                        const scheduledAt = new Date(meeting.scheduled_at)
                                        const scheduledTimeLabel = scheduledAt.toLocaleTimeString('pl-PL', {
                                            hour: '2-digit',
                                            minute: '2-digit'
                                        })
                                        const lockedRowShellClass = isLockedMeeting
                                            ? isCancelledMeeting
                                                ? 'border-rose-400/70 bg-[linear-gradient(135deg,rgba(244,63,94,0.18),rgba(255,255,255,0.9))] ring-1 ring-inset ring-rose-400/25 dark:border-rose-500/40 dark:bg-[linear-gradient(135deg,rgba(244,63,94,0.16),rgba(15,23,42,0.86))] dark:ring-rose-400/20'
                                                : 'border-sky-300/80 bg-[linear-gradient(135deg,rgba(14,165,233,0.16),rgba(255,255,255,0.92))] ring-1 ring-inset ring-sky-300/35 dark:border-sky-500/35 dark:bg-[linear-gradient(135deg,rgba(14,165,233,0.12),rgba(15,23,42,0.9))] dark:ring-sky-400/20'
                                            : isMissedMeeting
                                                ? 'border-amber-500/80 bg-[linear-gradient(135deg,rgba(245,158,11,0.26),rgba(255,255,255,0.94))] ring-1 ring-inset ring-amber-400/35 dark:border-amber-400/45 dark:bg-[linear-gradient(135deg,rgba(245,158,11,0.22),rgba(15,23,42,0.9))] dark:ring-amber-300/20'
                                                : 'border-gray-200/80 bg-white dark:border-slate-600 dark:bg-slate-700/40'
                                        const addressAlertShellClass = requiresAddressClarification
                                            ? 'border-rose-400/80 ring-2 ring-inset ring-rose-300/35 dark:border-rose-400/40 dark:ring-rose-400/20'
                                            : ''
                                        const normalizedLeadSource = normalizeSalesMeetingInlineText(meeting.lead_source)
                                        const assignmentBadges = getSalesMeetingAssignmentBadges(meeting)
                                        const statusStripLines = getMeetingStatusStripLines(
                                            statusMeta.baseKey,
                                            statusMeta.isInProgress,
                                            isMissedMeeting
                                        )
                                        const statusStripClass = statusMeta.isInProgress
                                            ? 'border-cyan-500/80 bg-cyan-600 text-white dark:border-cyan-400/60 dark:bg-cyan-500'
                                            : isMissedMeeting
                                                ? 'border-amber-500/80 bg-amber-500 text-white dark:border-amber-400/60 dark:bg-amber-400'
                                            : statusMeta.baseKey === 'planned'
                                                ? 'border-slate-500/80 bg-slate-600 text-white dark:border-slate-400/60 dark:bg-slate-500'
                                                : statusMeta.baseKey === 'signed'
                                                    ? 'border-emerald-500/80 bg-emerald-600 text-white dark:border-emerald-400/60 dark:bg-emerald-500'
                                                    : statusMeta.baseKey === 'refused'
                                                        ? 'border-red-500/80 bg-red-600 text-white dark:border-red-400/60 dark:bg-red-500'
                                                        : statusMeta.baseKey === 'no_cooperation'
                                                            ? 'border-rose-500/80 bg-rose-600 text-white dark:border-rose-400/60 dark:bg-rose-500'
                                                            : statusMeta.baseKey === 'not_home'
                                                                ? 'border-blue-500/80 bg-blue-600 text-white dark:border-blue-400/60 dark:bg-blue-500'
                                                                : statusMeta.baseKey === 'follow_up'
                                                                    ? 'border-amber-500/80 bg-amber-500 text-white dark:border-amber-400/60 dark:bg-amber-400'
                                                                    : 'border-rose-500/80 bg-rose-600 text-white dark:border-rose-400/60 dark:bg-rose-500'

                                        return (
                                            <div
                                                key={meeting.id}
                                                className={`relative overflow-hidden rounded-2xl border pr-4 pl-20 py-3.5 shadow-sm ${lockedRowShellClass} ${addressAlertShellClass}`}
                                            >
                                                <span className="absolute -left-[22px] top-6 hidden h-3 w-3 rounded-full border-2 border-white bg-cyan-500 shadow-sm md:block dark:border-slate-800" />
                                                <div className={`pointer-events-none absolute -bottom-px -left-px -top-px flex w-16 items-center justify-center overflow-hidden rounded-l-2xl border-r border-white/15 px-1 shadow-sm ${statusStripClass}`}>
                                                    <div className="-rotate-90 origin-center space-y-1">
                                                        {statusStripLines.map((line) => (
                                                            <span
                                                                key={line}
                                                                className="block whitespace-nowrap text-center text-[12px] font-black uppercase leading-none tracking-[0.03em]"
                                                            >
                                                                {line}
                                                            </span>
                                                        ))}
                                                    </div>
                                                </div>

                                                <div className="grid gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(300px,1fr)_auto] lg:items-center lg:gap-5">
                                                    <div className={`min-w-0 space-y-2.5 ${isLockedMeeting || isMissedMeeting ? 'opacity-[0.98]' : ''}`}>
                                                        <div className="flex flex-wrap items-center gap-2.5">
                                                            <p className="text-lg font-black text-slate-800 dark:text-white">{meeting.client_name}</p>
                                                            <span className={`text-[10px] font-black uppercase px-2.5 py-1 rounded-full ${statusMeta.badgeClass}`}>
                                                                {statusMeta.label}
                                                            </span>
                                                            {requiresAddressClarification && (
                                                                <span className="rounded-full border border-rose-300/80 bg-rose-50 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-rose-700 dark:border-rose-400/25 dark:bg-rose-500/10 dark:text-rose-200">
                                                                    Adres do doprecyzowania
                                                                </span>
                                                            )}
                                                        </div>

                                                        <p className="text-base font-semibold leading-snug text-slate-700 dark:text-slate-200">
                                                            {getSalesMeetingEnhancedAddress(meeting).main}
                                                        </p>
                                                        {getSalesMeetingEnhancedAddress(meeting).suggestion && (
                                                            <p className="text-[11px] font-bold text-cyan-600 dark:text-cyan-400 uppercase tracking-tight">
                                                                Sugerowana nawigacja: {getSalesMeetingEnhancedAddress(meeting).suggestion}
                                                            </p>
                                                        )}

                                                        <div className="flex flex-wrap gap-2">
                                                            {getSalesMeetingLocationBadges(meeting).map((badge) => (
                                                                <span
                                                                    key={`${meeting.id || meeting.import_key}-${badge}`}
                                                                    className="rounded-lg border border-cyan-300/70 bg-cyan-50 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-cyan-700 dark:border-cyan-400/25 dark:bg-cyan-500/10 dark:text-cyan-200"
                                                                >
                                                                    {badge}
                                                                </span>
                                                            ))}
                                                            {assignmentBadges.map((badge) => (
                                                                <span
                                                                    key={`${meeting.id || meeting.import_key}-assignment-${badge}`}
                                                                    className="rounded-lg border border-amber-300/70 bg-amber-50 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-amber-700 dark:border-amber-400/25 dark:bg-amber-500/10 dark:text-amber-200"
                                                                >
                                                                    {badge}
                                                                </span>
                                                            ))}
                                                            {meeting.phone && (
                                                                <span className="rounded-lg border border-emerald-300/70 bg-emerald-50 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-500/10 dark:text-emerald-200">
                                                                    Tel. {meeting.phone}
                                                                </span>
                                                            )}
                                                            {normalizedLeadSource && (
                                                                <span className="rounded-lg border border-slate-300 bg-slate-100 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-slate-700 dark:border-slate-500/30 dark:bg-slate-800/70 dark:text-slate-200">
                                                                    Źródło: {normalizedLeadSource}
                                                                </span>
                                                            )}
                                                            {requiresAddressClarification && (
                                                                <span className="rounded-lg border border-rose-300/80 bg-rose-50 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-rose-700 dark:border-rose-400/25 dark:bg-rose-500/10 dark:text-rose-200">
                                                                    Sama ulica lub brak numeru
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>

                                                    <div
                                                        className={`rounded-2xl border p-2.5 ${
                                                            isLockedMeeting
                                                                ? 'border-white/35 bg-white/55 dark:border-slate-500/40 dark:bg-slate-900/40'
                                                                : isMissedMeeting
                                                                    ? 'border-amber-300/55 bg-amber-50/65 dark:border-amber-400/25 dark:bg-slate-900/42'
                                                                    : 'border-slate-200/80 bg-slate-50/70 dark:border-slate-600/60 dark:bg-slate-800/45'
                                                        }`}
                                                    >
                                                        <div className="grid gap-2 sm:grid-cols-[92px_minmax(0,1fr)]">
                                                            <div className="rounded-xl border border-violet-300/60 bg-violet-50/80 px-3 py-2 dark:border-violet-400/20 dark:bg-violet-500/10">
                                                                <p className="text-[9px] font-black uppercase tracking-[0.22em] text-violet-600 dark:text-violet-200">Godzina</p>
                                                                <p className="mt-1 text-sm font-black text-violet-700 dark:text-white">{scheduledTimeLabel}</p>
                                                            </div>
                                                            <div className="rounded-xl border border-slate-300/70 bg-slate-100/90 px-3 py-2 dark:border-slate-500/30 dark:bg-slate-800/80">
                                                                <p className="text-[9px] font-black uppercase tracking-[0.22em] text-slate-500 dark:text-slate-300">Handlowiec</p>
                                                                <p
                                                                    title={meeting.salesperson_name || 'Nieprzypisany'}
                                                                    className="mt-1 text-sm font-black leading-tight text-slate-700 dark:text-slate-100 wrap-break-word"
                                                                >
                                                                    {meeting.salesperson_name || 'Nieprzypisany'}
                                                                </p>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <div className="flex flex-col items-stretch gap-2 lg:w-[128px] lg:self-stretch lg:justify-center lg:border-l lg:border-slate-200/80 lg:pl-4 dark:lg:border-slate-600/60">
                                                        <button
                                                            type="button"
                                                            onClick={() => openMeetingSettings(meeting)}
                                                            className={`${detailsButtonClass} w-full min-w-0`}
                                                        >
                                                            Ustawienia
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => openStatusPicker(meeting)}
                                                            className={`${statusButtonClass} w-full min-w-0`}
                                                        >
                                                            {isLockedMeeting ? 'Zmień status' : 'Ustaw status'}
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        )
                                    })}
                                </div>
                            </div>
                        ))}
                        {visibleMeetings.length === 0 && (
                            <p className="text-xs text-gray-400 font-bold uppercase tracking-wider py-6 text-center">
                                Brak spotkań dla wybranego dnia i filtra.
                            </p>
                        )}
                    </div>
                )}
            </div>
            {settingsDialog && (
                <div className="fixed inset-0 z-100 flex items-center justify-center p-4">
                    <button
                        type="button"
                        onClick={closeMeetingSettings}
                        className="ui-modal-backdrop absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
                        aria-label="Zamknij ustawienia spotkania"
                    />
                    <div className="ui-modal-panel relative w-full max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-800">
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <h3 className="text-sm font-black uppercase tracking-widest text-slate-800 dark:text-white">Ustawienia spotkania</h3>
                                <p className="mt-2 text-2xl font-black text-slate-800 dark:text-white">{settingsDialog.client_name}</p>
                                <p className="mt-1 text-sm font-semibold leading-snug text-slate-500 dark:text-slate-300">
                                    {getSalesMeetingEnhancedAddress(settingsDialog).main}
                                </p>
                                {getSalesMeetingEnhancedAddress(settingsDialog).suggestion && (
                                    <p className="mt-1 text-[11px] font-bold text-cyan-600 dark:text-cyan-400 uppercase tracking-tight">
                                        Sugerowana nawigacja: {getSalesMeetingEnhancedAddress(settingsDialog).suggestion}
                                    </p>
                                )}
                            </div>
                            <button
                                type="button"
                                onClick={closeMeetingSettings}
                                className="rounded-xl border border-slate-200 px-3 py-2 text-[10px] font-black uppercase tracking-wider text-slate-500 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700"
                            >
                                Zamknij
                            </button>
                        </div>

                        <div className="mt-6 space-y-3">
                            {!isMeetingLockedForAdmin(settingsDialog) && (
                                <>
                                    <button
                                        type="button"
                                        onClick={handleSettingsEdit}
                                        className={`${modalPrimaryButtonClass} w-full`}
                                    >
                                        Edytuj
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const meeting = settingsDialog
                                            setSettingsDialog(null)
                                            cancelMeeting(meeting)
                                        }}
                                        className={`${modalDangerButtonClass} w-full`}
                                    >
                                        Anuluj
                                    </button>
                                </>
                            )}
                            {isMeetingLockedForAdmin(settingsDialog) && (
                                <button
                                    type="button"
                                    onClick={() => void handleSettingsOpenDetails()}
                                    className={`${modalSecondaryButtonClass} w-full`}
                                >
                                    Szczegóły
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={handleSettingsDelete}
                                className={`${modalDeleteButtonClass} w-full`}
                            >
                                Usuń wiersz
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {statusPickerMeeting && (
                <div className="fixed inset-0 z-100 flex items-center justify-center p-4">
                    <button
                        type="button"
                        onClick={closeStatusPicker}
                        className="ui-modal-backdrop absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
                        aria-label="Zamknij wybór statusu"
                    />
                    <div className="ui-modal-panel relative w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-800">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-sm font-black uppercase tracking-widest text-slate-800 dark:text-white">Wybierz status spotkania</h3>
                                <p className="mt-1 text-sm font-semibold text-slate-500 dark:text-slate-300">
                                    {statusPickerMeeting.client_name} · {getSalesMeetingEnhancedAddress(statusPickerMeeting).main}
                                </p>
                                {getSalesMeetingEnhancedAddress(statusPickerMeeting).suggestion && (
                                    <p className="mt-1 text-[11px] font-bold text-cyan-600 dark:text-cyan-400 uppercase tracking-tight">
                                        Sugerowana nawigacja: {getSalesMeetingEnhancedAddress(statusPickerMeeting).suggestion}
                                    </p>
                                )}
                            </div>
                            <button
                                type="button"
                                onClick={closeStatusPicker}
                                className="rounded-xl border border-slate-200 px-3 py-2 text-[10px] font-black uppercase tracking-wider text-slate-500 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700"
                            >
                                Zamknij
                            </button>
                        </div>

                        <div className="mt-5 grid gap-3 sm:grid-cols-2">
                            {ADMIN_STATUS_OPTIONS.map((option) => (
                                <button
                                    key={option.key}
                                    type="button"
                                    onClick={() => openStatusDetails(statusPickerMeeting, option.key)}
                                    className="ui-pressable rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-left text-sm font-black uppercase tracking-[0.12em] text-slate-700 shadow-sm transition-all hover:border-cyan-400/35 hover:text-cyan-600 dark:border-slate-600 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:text-cyan-300"
                                >
                                    {option.label}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}
            {statusDetailsMeeting && selectedStatus && (
                <div className="fixed inset-0 z-100 flex items-center justify-center p-4">
                    <button
                        type="button"
                        onClick={closeStatusDetails}
                        className="ui-modal-backdrop absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
                        aria-label="Zamknij formularz statusu"
                    />
                    <div className="ui-modal-panel relative w-full max-w-3xl rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-800">
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <h3 className="text-sm font-black uppercase tracking-widest text-slate-800 dark:text-white">{getAdminStatusTitle(selectedStatus)}</h3>
                                <p className="mt-1 text-sm font-semibold text-slate-500 dark:text-slate-300">
                                    {statusDetailsMeeting.client_name} · {normalizeSalesMeetingAddress(statusDetailsMeeting.address) || statusDetailsMeeting.address}
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={closeStatusDetails}
                                className="rounded-xl border border-slate-200 px-3 py-2 text-[10px] font-black uppercase tracking-wider text-slate-500 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700"
                            >
                                Zamknij
                            </button>
                        </div>

                        {selectedStatus === 'follow_up' && (
                            <div className="mt-5 rounded-[28px] border border-slate-200/80 bg-slate-50/80 p-4 shadow-inner dark:border-slate-700 dark:bg-slate-900/35">
                                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_200px]">
                                    <div className="rounded-2xl border border-slate-200/80 bg-white/85 p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900/60">
                                        <p className="text-[10px] font-black uppercase tracking-[0.22em] text-cyan-500">Wybrany termin</p>
                                        <p className="mt-1 text-sm font-black text-slate-900 dark:text-white">
                                            {new Date(statusDraftScheduledAt).toLocaleDateString('pl-PL', {
                                                day: 'numeric',
                                                month: 'long',
                                                year: 'numeric'
                                            })}
                                        </p>
                                    </div>
                                    <div className="rounded-2xl border border-violet-400/20 bg-violet-500/10 px-4 py-3 shadow-sm dark:border-violet-400/20 dark:bg-violet-500/12">
                                        <p className="text-[10px] font-black uppercase tracking-[0.22em] text-violet-500">Godzina</p>
                                        <p className="mt-1 text-base font-black text-violet-700 dark:text-violet-200">{statusDraftTimePart}</p>
                                    </div>
                                </div>

                                <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
                                    <div className="rounded-[24px] border border-slate-200/80 bg-white/90 p-3 shadow-sm dark:border-slate-700 dark:bg-slate-950/45">
                                        <DayPicker
                                            animate
                                            locale={pl}
                                            mode="single"
                                            month={statusPickerMonth}
                                            navLayout="around"
                                            selected={statusDraftDateValue}
                                            showOutsideDays
                                            disabled={{ before: toLocalDate(getTodayDateInput()) }}
                                            onMonthChange={setStatusPickerMonth}
                                            onSelect={handleStatusDateChange}
                                        />
                                    </div>
                                    <div className="rounded-[24px] border border-slate-200/80 bg-white/90 p-3 shadow-sm dark:border-slate-700 dark:bg-slate-950/45">
                                        <div className="mb-2 flex items-center justify-between">
                                            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-400">Godzina spotkania</p>
                                            <span className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-cyan-500">
                                                30 min
                                            </span>
                                        </div>
                                        <div className="grid grid-cols-2 gap-2">
                                            {statusTimeOptions.map((slot) => {
                                                const isSelected = statusDraftTimePart === slot
                                                const isUnavailable = unavailableStatusTimeSlots.has(slot)
                                                return (
                                                    <button
                                                        key={slot}
                                                        type="button"
                                                        disabled={isUnavailable}
                                                        onClick={() => handleStatusTimeChange(slot)}
                                                        className={`rounded-lg border px-2 py-2 text-[13px] font-black leading-none transition-all ${
                                                            isUnavailable
                                                                ? 'cursor-not-allowed border-slate-200/70 bg-slate-100 text-slate-400 opacity-45 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-500'
                                                                : isSelected
                                                                    ? 'border-cyan-400/35 bg-cyan-500 text-white shadow-lg shadow-cyan-500/20'
                                                                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-cyan-400/35 hover:text-cyan-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:text-cyan-300'
                                                        }`}
                                                    >
                                                        {slot}
                                                    </button>
                                                )
                                            })}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        <div className="mt-5">
                            <label className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
                                {getAdminStatusNoteLabel(selectedStatus)}
                                {adminStatusRequiresNote(selectedStatus) ? ' *' : ''}
                            </label>
                            <textarea
                                value={statusDraftNote}
                                onChange={(event) => setStatusDraftNote(event.target.value)}
                                placeholder={getAdminStatusPlaceholder(selectedStatus)}
                                rows={selectedStatus === 'follow_up' ? 4 : 5}
                                className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700 shadow-inner outline-none transition focus:border-cyan-400/35 focus:ring-2 focus:ring-cyan-500/20 dark:border-slate-600 dark:bg-slate-900/55 dark:text-slate-100"
                            />
                        </div>

                        <div className="mt-6 flex gap-3">
                            <button
                                type="button"
                                onClick={closeStatusDetails}
                                disabled={statusSaving}
                                className={modalSecondaryButtonClass}
                            >
                                Anuluj
                            </button>
                            <button
                                type="button"
                                onClick={() => void saveMeetingStatus()}
                                disabled={statusSaving || (adminStatusRequiresNote(selectedStatus) && !statusDraftNote.trim())}
                                className={modalPrimaryButtonClass}
                            >
                                {statusSaving ? 'Zapisywanie...' : 'Zapisz status'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {detailsDialog && (
                (() => {
                    const assignmentMetaRows = getSalesMeetingAssignmentMetaRows(detailsDialog.meeting)
                    const executionMetaRows = getSalesMeetingExecutionMetaRows(detailsDialog.meeting)

                    return (
                    <div className="fixed inset-0 z-100 flex items-center justify-center p-4">
                        <button
                            type="button"
                            onClick={() => setDetailsDialog(null)}
                        className="ui-modal-backdrop absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
                        aria-label="Zamknij szczegóły spotkania"
                    />
                    <div className="ui-modal-panel relative w-full max-w-2xl rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-800">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-sm font-black uppercase tracking-widest text-slate-800 dark:text-white">Szczegóły spotkania</h3>
                                <p className="mt-1 text-base font-black text-slate-800 dark:text-white">{detailsDialog.meeting.client_name}</p>
                                <p className="mt-1 text-sm font-semibold text-slate-500 dark:text-slate-300">{getSalesMeetingEnhancedAddress(detailsDialog.meeting).main}</p>
                                {getSalesMeetingEnhancedAddress(detailsDialog.meeting).suggestion && (
                                    <p className="mt-1 text-[11px] font-bold text-cyan-600 dark:text-cyan-400 uppercase tracking-tight">
                                        Sugerowana nawigacja: {getSalesMeetingEnhancedAddress(detailsDialog.meeting).suggestion}
                                    </p>
                                )}
                            </div>
                            <button
                                type="button"
                                onClick={() => setDetailsDialog(null)}
                                className="rounded-xl border border-slate-200 px-3 py-2 text-[10px] font-black uppercase tracking-wider text-slate-500 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700"
                            >
                                Zamknij
                            </button>
                        </div>

                        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-slate-600 dark:bg-slate-900/40">
                                <p className="text-[9px] font-black uppercase tracking-[0.22em] text-slate-400">Status</p>
                                <p className="mt-1 text-sm font-black text-slate-800 dark:text-white">{getSalesMeetingDisplayMeta(detailsDialog.meeting).label}</p>
                            </div>
                            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-slate-600 dark:bg-slate-900/40">
                                <p className="text-[9px] font-black uppercase tracking-[0.22em] text-slate-400">Termin</p>
                                <p className="mt-1 text-sm font-black text-slate-800 dark:text-white">{new Date(detailsDialog.meeting.scheduled_at).toLocaleString('pl-PL')}</p>
                            </div>
                            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-slate-600 dark:bg-slate-900/40">
                                <p className="text-[9px] font-black uppercase tracking-[0.22em] text-slate-400">Handlowiec</p>
                                <p className="mt-1 text-sm font-black text-slate-800 dark:text-white">{detailsDialog.meeting.salesperson_name || 'Brak'}</p>
                            </div>
                            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-slate-600 dark:bg-slate-900/40">
                                <p className="text-[9px] font-black uppercase tracking-[0.22em] text-slate-400">Aktualizacja</p>
                                <p className="mt-1 text-sm font-black text-slate-800 dark:text-white">
                                    {detailsDialog.meeting.status_updated_at ? new Date(detailsDialog.meeting.status_updated_at).toLocaleString('pl-PL') : 'Brak'}
                                </p>
                            </div>
                        </div>

                            <div className="mt-4 grid gap-3 sm:grid-cols-2">
                                <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-600 dark:bg-slate-900/35">
                                    <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">Dane kontaktowe</p>
                                    <div className="mt-3 space-y-2 text-sm">
                                    <p className="font-semibold text-slate-700 dark:text-slate-200">Telefon: <span className="font-black">{detailsDialog.meeting.phone || 'Brak'}</span></p>
                                    <p className="font-semibold text-slate-700 dark:text-slate-200">Źródło: <span className="font-black">{normalizeSalesMeetingInlineText(detailsDialog.meeting.lead_source) || 'Brak'}</span></p>
                                    <p className="font-semibold text-slate-700 dark:text-slate-200">Województwo: <span className="font-black">{detailsDialog.meeting.region || 'Brak'}</span></p>
                                    <p className="font-semibold text-slate-700 dark:text-slate-200">Obszar: <span className="font-black">{getSalesMeetingLocalityLabel(detailsDialog.meeting) || 'Brak'}</span></p>
                                    <p className="font-semibold text-slate-700 dark:text-slate-200">Powiązanie słupa: <span className="font-black">{getSalesMeetingLocationBadges(detailsDialog.meeting).join(', ') || 'Brak'}</span></p>
                                </div>
                            </div>
                                <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-600 dark:bg-slate-900/35">
                                    <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">Notatki i wynik</p>
                                    <div className="mt-3 space-y-2 text-sm text-slate-700 dark:text-slate-200">
                                        <p><span className="font-semibold">Komentarz spotkania:</span> <span className="font-black">{normalizeSalesMeetingInlineText(detailsDialog.meeting.note) || 'Brak'}</span></p>
                                        <p><span className="font-semibold">Informacja statusu:</span> <span className="font-black">{getSalesMeetingCleanStatusNote(detailsDialog.meeting.status_note) || 'Brak'}</span></p>
                                        <p><span className="font-semibold">Powód anulowania:</span> <span className="font-black">{detailsDialog.meeting.cancelled_reason || 'Brak'}</span></p>
                                        {executionMetaRows.map((row) => (
                                            <p key={row.label}>
                                                <span className="font-semibold">{row.label}:</span> <span className="font-black">{row.value}</span>
                                            </p>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            {assignmentMetaRows.length > 0 && (
                                <div className="mt-4 rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-600 dark:bg-slate-900/35">
                                    <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">Dane z dzialek</p>
                                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                        {assignmentMetaRows.map((row) => (
                                            <div key={row.label} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-900/40">
                                                <p className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-400">{row.label}</p>
                                                <p className="mt-1 text-sm font-black text-slate-800 dark:text-white">{row.value}</p>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                        {needsSalesMeetingAddressClarification(detailsDialog.meeting) && (
                            <div className="mt-4 rounded-xl border border-rose-300/80 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-400/25 dark:bg-rose-500/10 dark:text-rose-100">
                                <p className="font-black uppercase tracking-[0.18em]">Adres do doprecyzowania</p>
                                <p className="mt-2 font-semibold">
                                    Ten wpis wygląda na samą ulicę albo adres bez numeru. Tę pozycję warto odfiltrować i przypisać do kontaktu w celu ustalenia dokładnego miejsca działki.
                                </p>
                            </div>
                        )}

                        <div className="mt-4 rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-600 dark:bg-slate-900/35">
                            <div className="flex items-center justify-between gap-3">
                                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">Formularz spotkania</p>
                                {detailsDialog.loading && <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Ładowanie...</span>}
                            </div>
                            {detailsDialog.survey ? (
                                <div className="mt-3 space-y-3">
                                    <div className="grid gap-3 sm:grid-cols-3">
                                        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/60">
                                            <p className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-400">Start</p>
                                            <p className="mt-1 text-sm font-black text-slate-800 dark:text-white">{formatSurveyDateTime(getSurveyTimingMeta(detailsDialog.survey).startedAt)}</p>
                                        </div>
                                        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/60">
                                            <p className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-400">Koniec</p>
                                            <p className="mt-1 text-sm font-black text-slate-800 dark:text-white">{formatSurveyDateTime(getSurveyTimingMeta(detailsDialog.survey).finishedAt)}</p>
                                        </div>
                                        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/60">
                                            <p className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-400">Czas</p>
                                            <p className="mt-1 text-sm font-black text-slate-800 dark:text-white">{getSurveyTimingMeta(detailsDialog.survey).durationLabel || 'Brak'}</p>
                                        </div>
                                    </div>
                                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 dark:border-slate-700 dark:bg-slate-800/60">
                                        <p className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-400">Snapshot umowy / formularza</p>
                                        <p className="mt-2 whitespace-pre-wrap text-sm font-semibold text-slate-700 dark:text-slate-200">
                                            {typeof detailsDialog.survey.answers?.contract_snapshot === 'string' && detailsDialog.survey.answers.contract_snapshot.trim()
                                                ? detailsDialog.survey.answers.contract_snapshot
                                                : 'Brak rozszerzonego podsumowania formularza.'}
                                        </p>
                                    </div>
                                </div>
                            ) : (
                                !detailsDialog.loading && (
                                    <p className="mt-3 text-sm font-semibold text-slate-500 dark:text-slate-300">
                                        Brak powiązanego formularza spotkania albo szczegóły nie są jeszcze zapisane.
                                    </p>
                                )
                            )}
                        </div>
                        </div>
                    </div>
                    )
                })()
            )}
            {cancelDialog && (
                <div className="fixed inset-0 z-100 flex items-center justify-center p-4">
                    <button
                        type="button"
                        onClick={() => {
                            if (!cancelSaving) setCancelDialog(null)
                        }}
                        className="ui-modal-backdrop absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
                        aria-label="Zamknij anulowanie spotkania"
                    />
                    <div className="ui-modal-panel relative w-full max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-800">
                        <h3 className="text-sm font-black uppercase tracking-widest text-slate-800 dark:text-white">Anulowanie spotkania</h3>
                        <p className="mt-2 text-sm font-bold text-slate-700 dark:text-slate-200">{cancelDialog.meeting.client_name}</p>
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                            {new Date(cancelDialog.meeting.scheduled_at).toLocaleString('pl-PL', {
                                year: 'numeric',
                                month: '2-digit',
                                day: '2-digit',
                                hour: '2-digit',
                                minute: '2-digit'
                            })}
                        </p>
                        <div className="mt-4">
                            <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1 block">Powod anulacji</label>
                            <input
                                type="text"
                                value={cancelDialog.reason}
                                onChange={(event) =>
                                    setCancelDialog((prev) => (prev ? { ...prev, reason: event.target.value } : prev))
                                }
                                placeholder="Opcjonalnie"
                                className={input}
                            />
                        </div>
                        <div className="mt-5 flex gap-3">
                            <button
                                type="button"
                                onClick={() => setCancelDialog(null)}
                                disabled={cancelSaving}
                                className={modalSecondaryButtonClass}
                            >
                                Zamknij
                            </button>
                            <button
                                type="button"
                                onClick={() => void confirmCancelMeeting()}
                                disabled={cancelSaving}
                                className={modalDangerButtonClass}
                            >
                                {cancelSaving ? 'Zapisywanie...' : 'Anuluj spotkanie'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {isFormOpen && (
                <div className="fixed inset-0 z-100 flex items-center justify-center p-4">
                    <button
                        type="button"
                        onClick={closeMeetingForm}
                        className="ui-modal-backdrop absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
                        aria-label={editing ? 'Zamknij edycję spotkania' : 'Zamknij dodawanie spotkania'}
                    />
                    <div className="ui-modal-panel relative w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-white dark:bg-slate-800 rounded-2xl border border-gray-200 dark:border-slate-700 p-4 sm:p-5 shadow-2xl">
                        <h3 className="text-sm font-black uppercase tracking-widest text-slate-800 dark:text-white mb-4">
                            {editing ? 'Edycja spotkania' : 'Nowe spotkanie'}
                        </h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pb-2 pt-2">
                            <div className="md:col-span-2">
                                <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1 block">Handlowiec</label>
                                <SelectInput
                                    value={editData.salesperson_id}
                                    onChange={(value) => setEditData((prev) => ({ ...prev, salesperson_id: value }))}
                                    options={workers.map((worker) => ({ value: String(worker.id), label: worker.name }))}
                                    placeholder="Wybierz handlowca"
                                    className={input}
                                />
                            </div>
                            <div className="md:col-span-1">
                                <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1 block">Źródło pozyskania leada</label>
                                <SelectInput
                                    value={editData.lead_source}
                                    onChange={(value) => setEditData((prev) => ({ ...prev, lead_source: value }))}
                                    options={SALES_MEETING_LEAD_SOURCE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                                    placeholder="Wybierz źródło"
                                    className={input}
                                />
                            </div>
                            <div className="md:col-span-2">
                                <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1 block">Data i godzina</label>
                                <div className="rounded-2xl border border-slate-200/80 bg-slate-50/85 p-3 shadow-inner dark:border-slate-700 dark:bg-slate-950/45">
                                    <div className="mb-2.5 grid gap-2 sm:grid-cols-[minmax(0,1fr)_116px]">
                                        <div className="rounded-xl border border-cyan-400/15 bg-white/90 px-3 py-2.5 shadow-sm dark:border-cyan-400/10 dark:bg-slate-800/90">
                                            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-cyan-500">Wybrany termin</p>
                                            <p className="mt-1 text-sm font-black text-slate-900 dark:text-white">
                                                {format(scheduledDateValue, 'dd MMMM yyyy', { locale: pl })}
                                            </p>
                                        </div>
                                        <div className="rounded-xl border border-violet-300/25 bg-violet-500/10 px-3 py-2 text-center dark:border-violet-400/20">
                                            <p className="text-[9px] font-black uppercase tracking-[0.22em] text-violet-500">Godzina</p>
                                            <p className="mt-1 text-base font-black text-violet-700 dark:text-violet-200">{scheduledTimePart}</p>
                                        </div>
                                    </div>

                                    <div className="grid gap-2.5 lg:grid-cols-[minmax(0,1fr)_174px]">
                                        <div className="meeting-date-picker date-range-picker rounded-2xl border border-slate-200/80 bg-white/85 p-2 shadow-sm dark:border-slate-700 dark:bg-slate-900/65">
                                            <DayPicker
                                                animate
                                                locale={pl}
                                                mode="single"
                                                month={meetingPickerMonth}
                                                navLayout="around"
                                                selected={scheduledDateValue}
                                                showOutsideDays
                                                disabled={{ before: toLocalDate(getTodayDateInput()) }}
                                                onMonthChange={setMeetingPickerMonth}
                                                onSelect={handleScheduledDateChange}
                                            />
                                        </div>

                                        <div className="rounded-2xl border border-slate-200/80 bg-white/85 p-2.5 shadow-sm dark:border-slate-700 dark:bg-slate-900/65">
                                            <div className="mb-2 flex items-center justify-between">
                                                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-400">Godzina spotkania</p>
                                                <span className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-cyan-500">
                                                    30 min
                                                </span>
                                            </div>
                                            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 lg:grid-cols-3">
                                                {meetingTimeOptions.map((slot) => {
                                                    const isSelected = scheduledTimePart === slot
                                                    const isUnavailable = unavailableTimeSlots.has(slot)
                                                    return (
                                                        <button
                                                            key={slot}
                                                            type="button"
                                                            disabled={isUnavailable}
                                                            onClick={() => handleScheduledTimeChange(slot)}
                                                            className={`rounded-lg border px-1.5 py-2 text-[13px] font-black leading-none transition-all ${
                                                                isUnavailable
                                                                    ? 'cursor-not-allowed border-slate-200/70 bg-slate-100 text-slate-400 opacity-45 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-500'
                                                                    :
                                                                isSelected
                                                                    ? 'border-cyan-400/35 bg-cyan-500 text-white shadow-lg shadow-cyan-500/20'
                                                                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-cyan-400/35 hover:text-cyan-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:text-cyan-300'
                                                            }`}
                                                        >
                                                            {slot}
                                                        </button>
                                                    )
                                                })}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div className="md:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1 block">Imie i nazwisko</label>
                                    <input
                                        type="text"
                                        value={editData.client_name}
                                        onChange={(event) => setEditData((prev) => ({ ...prev, client_name: event.target.value }))}
                                        className={input}
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1 block">Numer telefonu</label>
                                    <input
                                        type="text"
                                        value={editData.phone}
                                        onChange={(event) => setEditData((prev) => ({ ...prev, phone: event.target.value }))}
                                        className={input}
                                    />
                                </div>
                            </div>
                            <div className="md:col-span-2">
                                <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1 block">Adres</label>
                                <input
                                    type="text"
                                    value={editData.address}
                                    onChange={(event) => setEditData((prev) => ({ ...prev, address: event.target.value }))}
                                    className={input}
                                />
                            </div>
                            <div className="md:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1 block">Wojewodztwo</label>
                                    <SelectInput
                                        value={editData.region}
                                        onChange={(value) => setEditData((prev) => ({ ...prev, region: value }))}
                                        options={[
                                            { value: 'dolnoslaskie', label: 'Dolnośląskie' },
                                            { value: 'kujawsko_pomorskie', label: 'Kujawsko-Pomorskie' },
                                            { value: 'lubelskie', label: 'Lubelskie' },
                                            { value: 'lubuskie', label: 'Lubuskie' },
                                            { value: 'lodzkie', label: 'Łódzkie' },
                                            { value: 'malopolskie', label: 'Małopolskie' },
                                            { value: 'mazowieckie', label: 'Mazowieckie' },
                                            { value: 'opolskie', label: 'Opolskie' },
                                            { value: 'podkarpackie', label: 'Podkarpackie' },
                                            { value: 'podlaskie', label: 'Podlaskie' },
                                            { value: 'pomorskie', label: 'Pomorskie' },
                                            { value: 'slaskie', label: 'Śląskie' },
                                            { value: 'mazowieckie', label: 'Mazowieckie' },
                                            { value: 'warminsko_mazurskie', label: 'Warmińsko-Mazurskie' },
                                            { value: 'wielkopolskie', label: 'Wielkopolskie' },
                                            { value: 'zachodniopomorskie', label: 'Zachodniopomorskie' }
                                        ]}
                                        placeholder="Wybierz województwo"
                                        className={input}
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1 block">Notatka</label>
                                    <input
                                        value={editData.note}
                                        onChange={(event) => setEditData((prev) => ({ ...prev, note: event.target.value }))}
                                        className={input}
                                    />
                                </div>
                            </div>
                        </div>
                        <div className="flex gap-3 mt-5">
                            <button
                                type="button"
                                onClick={closeMeetingForm}
                                disabled={formSaving}
                                className={modalSecondaryButtonClass}
                            >
                                Anuluj
                            </button>
                            <button
                                type="button"
                                onClick={() => void saveMeetingForm()}
                                disabled={formSaving || !isMeetingFormValid}
                                className={modalPrimaryButtonClass}
                            >
                                {formSaving ? 'Zapisywanie...' : editing ? 'Zapisz zmiany' : 'Dodaj spotkanie'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {deleteDialog && (
                <div className="fixed inset-0 z-100 flex items-center justify-center p-4">
                    <button
                        type="button"
                        onClick={() => {
                            if (!deleteSaving) setDeleteDialog(null)
                        }}
                        className="ui-modal-backdrop absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
                        aria-label="Zamknij usuwanie wiersza"
                    />
                    <div className="ui-modal-panel relative w-full max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-800">
                        <h3 className="text-sm font-black uppercase tracking-widest text-slate-800 dark:text-white">Usunięcie wiersza</h3>
                        <p className="mt-2 text-sm font-bold text-slate-700 dark:text-slate-200">{deleteDialog.client_name}</p>
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                            Ten wiersz zostanie usunięty z listy zaplanowanych spotkań.
                        </p>
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                            {new Date(deleteDialog.scheduled_at).toLocaleString('pl-PL', {
                                year: 'numeric',
                                month: '2-digit',
                                day: '2-digit',
                                hour: '2-digit',
                                minute: '2-digit'
                            })}
                        </p>
                        <div className="mt-5 flex gap-3">
                            <button
                                type="button"
                                onClick={() => setDeleteDialog(null)}
                                disabled={deleteSaving}
                                className={modalSecondaryButtonClass}
                            >
                                Zamknij
                            </button>
                            <button
                                type="button"
                                onClick={() => void confirmDeleteMeeting()}
                                disabled={deleteSaving}
                                className={modalDeleteButtonClass}
                            >
                                {deleteSaving ? 'Usuwanie...' : 'Usuń wiersz'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
