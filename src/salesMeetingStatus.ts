import type { SalesMeeting, SalesMeetingStatus, Survey } from './db'

type SurveyStatusValue = NonNullable<Survey['status']>
export type WorkerSettableMeetingStatus = SalesMeetingStatus | 'missed'

export interface SalesMeetingStatusMeta {
    key: SalesMeetingStatus
    label: string
    shortLabel: string
    badgeClass: string
}

export interface SalesMeetingDisplayMeta {
    key: SalesMeetingStatus | 'in_progress' | 'missed'
    baseKey: SalesMeetingStatus
    label: string
    shortLabel: string
    badgeClass: string
    isInProgress: boolean
    isMissed: boolean
}

export const SALES_MEETING_IN_PROGRESS_FLAG = '__VISIT_IN_PROGRESS__'
export const SALES_MEETING_MISSED_FLAG = '__VISIT_MISSED__'
export const SALES_MEETING_REFUSED_BEFORE_FLAG = '__REFUSAL_BEFORE_MEETING__'
export const SALES_MEETING_REFUSED_AFTER_FLAG = '__REFUSAL_AFTER_MEETING__'
export const SALES_MEETING_RESCHEDULED_PREFIX = 'Przełożone przez handlowca:'
type SalesMeetingDisplaySource = Pick<SalesMeeting, 'status' | 'status_note'>
export type SalesMeetingRefusalStage = 'before_meeting' | 'after_meeting'

export const SALES_MEETING_STATUSES: SalesMeetingStatusMeta[] = [
    {
        key: 'planned',
        label: 'Zaplanowane',
        shortLabel: 'Plan',
        badgeClass: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
    },
    {
        key: 'signed',
        label: 'Umowa podpisana',
        shortLabel: 'Umowa',
        badgeClass: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
    },
    {
        key: 'refused',
        label: 'Odmowa klienta',
        shortLabel: 'Odmowa',
        badgeClass: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
    },
    {
        key: 'no_cooperation',
        label: 'Brak wspolpracy',
        shortLabel: 'INNE',
        badgeClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300'
    },
    {
        key: 'not_home',
        label: 'Nie było nikogo',
        shortLabel: 'Nie było',
        badgeClass: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
    },
    {
        key: 'follow_up',
        label: 'Kontakt ponowny',
        shortLabel: 'Ponowny',
        badgeClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
    },
    {
        key: 'cancelled',
        label: 'Anulowane',
        shortLabel: 'Anul',
        badgeClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400'
    }
]

const META_MAP = new Map<SalesMeetingStatus, SalesMeetingStatusMeta>(
    SALES_MEETING_STATUSES.map((item) => [item.key, item])
)

export const getSalesMeetingStatusMeta = (status: SalesMeetingStatus): SalesMeetingStatusMeta =>
    META_MAP.get(status) || SALES_MEETING_STATUSES[0]

export const buildSalesMeetingInProgressNote = (note?: string | null): string => {
    const normalizedNote = (note || '').trim()
    return normalizedNote
        ? `${SALES_MEETING_IN_PROGRESS_FLAG}::${normalizedNote}`
        : SALES_MEETING_IN_PROGRESS_FLAG
}

export const buildSalesMeetingMissedNote = (note?: string | null): string => {
    const normalizedNote = (note || '').trim()
    return normalizedNote
        ? `${SALES_MEETING_MISSED_FLAG}::${normalizedNote}`
        : SALES_MEETING_MISSED_FLAG
}

export const buildSalesMeetingRefusalNote = (
    stage: SalesMeetingRefusalStage,
    note?: string | null
): string => {
    const flag = stage === 'before_meeting' ? SALES_MEETING_REFUSED_BEFORE_FLAG : SALES_MEETING_REFUSED_AFTER_FLAG
    const normalizedNote = (note || '').trim()
    return normalizedNote ? `${flag}::${normalizedNote}` : flag
}

const extractFlaggedStatusNote = (statusNote: string, flag: string): string | null => {
    if (statusNote === flag) return null

    const prefixedFlag = `${flag}::`
    if (!statusNote.startsWith(prefixedFlag)) return statusNote

    const cleanNote = statusNote.slice(prefixedFlag.length).trim()
    return cleanNote || null
}

export const getSalesMeetingCleanStatusNote = (statusNote?: string | null): string | null => {
    const normalizedNote = (statusNote || '').trim()
    if (!normalizedNote) return null

    const withoutInProgressFlag = extractFlaggedStatusNote(normalizedNote, SALES_MEETING_IN_PROGRESS_FLAG)
    if (withoutInProgressFlag === null) return null

    const withoutMissedFlag = extractFlaggedStatusNote(withoutInProgressFlag, SALES_MEETING_MISSED_FLAG)
    if (withoutMissedFlag === null) return null

    const withoutBeforeRefusalFlag = extractFlaggedStatusNote(withoutMissedFlag, SALES_MEETING_REFUSED_BEFORE_FLAG)
    if (withoutBeforeRefusalFlag === null) return null

    return extractFlaggedStatusNote(withoutBeforeRefusalFlag, SALES_MEETING_REFUSED_AFTER_FLAG)
}

const splitSalesMeetingCleanNote = (statusNote?: string | null): string[] => {
    const cleanNote = getSalesMeetingCleanStatusNote(statusNote)
    if (!cleanNote) return []

    return cleanNote
        .split(/\r?\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
}

export const getSalesMeetingRefusalStage = (
    meeting: Pick<SalesMeeting, 'status' | 'status_note'> | null | undefined
): SalesMeetingRefusalStage | null => {
    if (!meeting || meeting.status !== 'refused') return null
    const normalizedNote = (meeting.status_note || '').trim()
    if (!normalizedNote) return null
    if (normalizedNote.startsWith(SALES_MEETING_REFUSED_BEFORE_FLAG)) return 'before_meeting'
    if (normalizedNote.startsWith(SALES_MEETING_REFUSED_AFTER_FLAG)) return 'after_meeting'
    return null
}

const getSalesMeetingRefusalLabel = (stage: SalesMeetingRefusalStage | null) => {
    switch (stage) {
        case 'before_meeting':
            return { label: 'Odmowa przed spotkaniem', shortLabel: 'Odm. przed' }
        case 'after_meeting':
            return { label: 'Odmowa po spotkaniu', shortLabel: 'Odm. po' }
        default:
            return { label: 'Odmowa klienta', shortLabel: 'Odmowa' }
    }
}

const formatSalesMeetingRescheduleDate = (value: Date): string =>
    value.toLocaleDateString('pl-PL', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    })

const formatSalesMeetingRescheduleTime = (value: Date): string =>
    value.toLocaleTimeString('pl-PL', {
        hour: '2-digit',
        minute: '2-digit'
    })

const parsePolishDateTimeParts = (datePart: string, timePart: string): Date | null => {
    const [day, month, year] = datePart.split('.').map(Number)
    const [hours, minutes] = timePart.split(':').map(Number)
    if (![day, month, year, hours, minutes].every(Number.isFinite)) return null
    const parsed = new Date(year, month - 1, day, hours, minutes, 0, 0)
    return Number.isNaN(parsed.getTime()) ? null : parsed
}

const parseLegacyFollowUpTarget = (statusNote: string | null | undefined, scheduledAt: string): Date | null => {
    const cleanNote = getSalesMeetingCleanStatusNote(statusNote)
    if (!cleanNote) return null

    const sourceDate = new Date(scheduledAt)
    if (Number.isNaN(sourceDate.getTime())) return null

    const match = cleanNote
        .replace(/\s+/g, ' ')
        .match(/kontakt(?:\s+ponowny)?[^0-9]{0,20}(\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?)(?:\s*(?:r\.?)?)?(?:\s*(?:o|godz(?:ina)?\.?|godz\.?|na)?\s*(\d{1,2}[:.]\d{2}))?/i)
    if (!match) return null

    const rawDatePart = match[1]?.replace(/[^\d./-]/g, '') || ''
    const dateParts = rawDatePart.split(/[./-]/).map(Number)
    if (dateParts.length < 2) return null

    const [day, month, maybeYear] = dateParts
    if (!Number.isFinite(day) || !Number.isFinite(month)) return null

    let year = Number.isFinite(maybeYear) ? maybeYear : sourceDate.getFullYear()
    if (year < 100) year += 2000

    let hours = sourceDate.getHours()
    let minutes = sourceDate.getMinutes()

    if (match[2]) {
        const [parsedHours, parsedMinutes] = match[2].replace('.', ':').split(':').map(Number)
        if (![parsedHours, parsedMinutes].every(Number.isFinite)) return null
        hours = parsedHours
        minutes = parsedMinutes
    }

    const parsed = new Date(year, month - 1, day, hours, minutes, 0, 0)
    if (
        Number.isNaN(parsed.getTime()) ||
        parsed.getDate() !== day ||
        parsed.getMonth() !== month - 1
    ) {
        return null
    }

    if (!Number.isFinite(maybeYear) && parsed.getTime() < sourceDate.getTime() - 36 * 60 * 60 * 1000) {
        parsed.setFullYear(parsed.getFullYear() + 1)
    }

    return Number.isNaN(parsed.getTime()) ? null : parsed
}

const parseSalesMeetingRescheduleTarget = (label: string): Date | null => {
    const sameDayMatch = label.match(/^(\d{2}\.\d{2}\.\d{4}) z (\d{2}:\d{2}) na (\d{2}:\d{2})$/)
    if (sameDayMatch) {
        return parsePolishDateTimeParts(sameDayMatch[1], sameDayMatch[3])
    }

    const otherDayMatch = label.match(/^(\d{2}\.\d{2}\.\d{4}) (\d{2}:\d{2}) na (\d{2}\.\d{2}\.\d{4}) (\d{2}:\d{2})$/)
    if (otherDayMatch) {
        return parsePolishDateTimeParts(otherDayMatch[3], otherDayMatch[4])
    }

    const isoArrowMatch = label.match(/->\s*(.+)$/)
    if (isoArrowMatch) {
        const ms = Date.parse(isoArrowMatch[1].trim())
        return Number.isFinite(ms) ? new Date(ms) : null
    }

    return null
}

const parseSalesMeetingReschedulePair = (label: string): { previous: Date; next: Date } | null => {
    const sameDayMatch = label.match(/^(\d{2}\.\d{2}\.\d{4}) z (\d{2}:\d{2}) na (\d{2}:\d{2})$/)
    if (sameDayMatch) {
        const previous = parsePolishDateTimeParts(sameDayMatch[1], sameDayMatch[2])
        const next = parsePolishDateTimeParts(sameDayMatch[1], sameDayMatch[3])
        return previous && next ? { previous, next } : null
    }

    const otherDayMatch = label.match(/^(\d{2}\.\d{2}\.\d{4}) (\d{2}:\d{2}) na (\d{2}\.\d{2}\.\d{4}) (\d{2}:\d{2})$/)
    if (otherDayMatch) {
        const previous = parsePolishDateTimeParts(otherDayMatch[1], otherDayMatch[2])
        const next = parsePolishDateTimeParts(otherDayMatch[3], otherDayMatch[4])
        return previous && next ? { previous, next } : null
    }

    return null
}

const buildSalesMeetingRescheduleSummary = (previousScheduledAt: string, nextScheduledAt: string): string => {
    const previousDate = new Date(previousScheduledAt)
    const nextDate = new Date(nextScheduledAt)

    if (Number.isNaN(previousDate.getTime()) || Number.isNaN(nextDate.getTime())) {
        return `${previousScheduledAt} -> ${nextScheduledAt}`
    }

    const previousDateLabel = formatSalesMeetingRescheduleDate(previousDate)
    const nextDateLabel = formatSalesMeetingRescheduleDate(nextDate)
    const previousTimeLabel = formatSalesMeetingRescheduleTime(previousDate)
    const nextTimeLabel = formatSalesMeetingRescheduleTime(nextDate)

    if (previousDateLabel === nextDateLabel) {
        return `${nextDateLabel} z ${previousTimeLabel} na ${nextTimeLabel}`
    }

    return `${previousDateLabel} ${previousTimeLabel} na ${nextDateLabel} ${nextTimeLabel}`
}

export const getSalesMeetingRescheduleInfo = (statusNote?: string | null): string | null => {
    const [firstLine] = splitSalesMeetingCleanNote(statusNote)
    if (!firstLine || !firstLine.startsWith(SALES_MEETING_RESCHEDULED_PREFIX)) return null
    return firstLine
}

export const getSalesMeetingRescheduleLabel = (statusNote?: string | null): string | null => {
    const rescheduleInfo = getSalesMeetingRescheduleInfo(statusNote)
    if (!rescheduleInfo) return null
    return rescheduleInfo.slice(SALES_MEETING_RESCHEDULED_PREFIX.length).trim() || null
}

export const getSalesMeetingEffectiveScheduledAt = (
    meeting: Pick<SalesMeeting, 'status' | 'scheduled_at' | 'status_note'>
): string => {
    if (meeting.status !== 'follow_up') return meeting.scheduled_at

    const rescheduleLabel = getSalesMeetingRescheduleLabel(meeting.status_note)
    const parsedTarget =
        (rescheduleLabel ? parseSalesMeetingRescheduleTarget(rescheduleLabel) : null) ||
        parseLegacyFollowUpTarget(meeting.status_note, meeting.scheduled_at)
    if (!parsedTarget) return meeting.scheduled_at

    const currentMs = Date.parse(meeting.scheduled_at)
    if (Number.isFinite(currentMs) && parsedTarget.getTime() === currentMs) {
        return meeting.scheduled_at
    }

    return parsedTarget.toISOString()
}

export const getSalesMeetingOriginalScheduledAt = (
    meeting: Pick<SalesMeeting, 'status' | 'scheduled_at' | 'status_note'>
): string => {
    const rescheduleLabel = getSalesMeetingRescheduleLabel(meeting.status_note)
    const parsedPair = rescheduleLabel ? parseSalesMeetingReschedulePair(rescheduleLabel) : null
    if (parsedPair) return parsedPair.previous.toISOString()

    if (meeting.status !== 'follow_up') return meeting.scheduled_at

    const parsedTarget = parseLegacyFollowUpTarget(meeting.status_note, meeting.scheduled_at)
    if (!parsedTarget) return meeting.scheduled_at

    const currentMs = Date.parse(meeting.scheduled_at)
    if (!Number.isFinite(currentMs) || parsedTarget.getTime() === currentMs) {
        return meeting.scheduled_at
    }

    return meeting.scheduled_at
}

export const getSalesMeetingEffectiveRescheduleInfo = (
    meeting: Pick<SalesMeeting, 'status' | 'scheduled_at' | 'status_note'>
): string | null => {
    const explicitInfo = getSalesMeetingRescheduleInfo(meeting.status_note)
    if (explicitInfo) return explicitInfo
    if (meeting.status !== 'follow_up') return null

    const parsedTarget = parseLegacyFollowUpTarget(meeting.status_note, meeting.scheduled_at)
    if (!parsedTarget) return null

    const currentMs = Date.parse(meeting.scheduled_at)
    if (Number.isFinite(currentMs) && parsedTarget.getTime() === currentMs) return null

    return `${SALES_MEETING_RESCHEDULED_PREFIX} ${buildSalesMeetingRescheduleSummary(
        meeting.scheduled_at,
        parsedTarget.toISOString()
    )} (z notatki)`
}

export const getSalesMeetingEffectiveRescheduleLabel = (
    meeting: Pick<SalesMeeting, 'status' | 'scheduled_at' | 'status_note'>
): string | null => {
    const rescheduleInfo = getSalesMeetingEffectiveRescheduleInfo(meeting)
    if (!rescheduleInfo) return null
    return rescheduleInfo.slice(SALES_MEETING_RESCHEDULED_PREFIX.length).trim() || null
}

export const getSalesMeetingNoteWithoutRescheduleInfo = (statusNote?: string | null): string | null => {
    const lines = splitSalesMeetingCleanNote(statusNote)
    if (lines.length === 0) return null

    if (lines[0].startsWith(SALES_MEETING_RESCHEDULED_PREFIX)) {
        lines.shift()
    }

    return lines.length > 0 ? lines.join('\n') : null
}

export const buildSalesMeetingRescheduledNote = (
    previousScheduledAt: string,
    nextScheduledAt: string,
    existingStatusNote?: string | null
): string => {
    const summaryLine = `${SALES_MEETING_RESCHEDULED_PREFIX} ${buildSalesMeetingRescheduleSummary(previousScheduledAt, nextScheduledAt)}`
    const preservedNote = getSalesMeetingNoteWithoutRescheduleInfo(existingStatusNote)

    return preservedNote ? `${summaryLine}\n${preservedNote}` : summaryLine
}

export const isSalesMeetingInProgress = (
    meeting: Pick<SalesMeeting, 'status' | 'status_note'> | null | undefined
): boolean => {
    if (!meeting) return false
    if (meeting.status !== 'planned' && meeting.status !== 'follow_up') return false
    return typeof meeting.status_note === 'string' && meeting.status_note.trim().startsWith(SALES_MEETING_IN_PROGRESS_FLAG)
}

export const isSalesMeetingMarkedMissed = (
    meeting: Pick<SalesMeeting, 'status' | 'status_note'> | null | undefined
): boolean => {
    if (!meeting) return false
    if (meeting.status !== 'planned' && meeting.status !== 'follow_up') return false
    return typeof meeting.status_note === 'string' && meeting.status_note.trim().startsWith(SALES_MEETING_MISSED_FLAG)
}

export const isSalesMeetingMissed = (meeting: SalesMeetingDisplaySource): boolean => isSalesMeetingMarkedMissed(meeting)

export const getSalesMeetingDisplayMeta = (
    meeting: SalesMeetingDisplaySource,
    now = new Date()
): SalesMeetingDisplayMeta => {
    void now
    if (isSalesMeetingInProgress(meeting)) {
        return {
            key: 'in_progress',
            baseKey: meeting.status,
            label: 'W trakcie wizyty',
            shortLabel: 'W trakcie',
            badgeClass: 'bg-cyan-200/95 text-cyan-800 dark:bg-cyan-500/25 dark:text-cyan-100 ring-1 ring-inset ring-cyan-300/80 dark:ring-cyan-400/20',
            isInProgress: true,
            isMissed: false
        }
    }

    if (isSalesMeetingMissed(meeting)) {
        return {
            key: 'missed',
            baseKey: 'planned',
            label: 'Nieodbyte',
            shortLabel: 'Nieodbyte',
            badgeClass: 'bg-amber-200/95 text-amber-900 dark:bg-amber-500/25 dark:text-amber-100 ring-1 ring-inset ring-amber-300/85 dark:ring-amber-400/20',
            isInProgress: false,
            isMissed: true
        }
    }

    const meta = getSalesMeetingStatusMeta(meeting.status)
    if (meeting.status === 'refused') {
        const refusalLabel = getSalesMeetingRefusalLabel(getSalesMeetingRefusalStage(meeting))
        return {
            ...meta,
            label: refusalLabel.label,
            shortLabel: refusalLabel.shortLabel,
            baseKey: meta.key,
            isInProgress: false,
            isMissed: false
        }
    }

    return {
        ...meta,
        baseKey: meta.key,
        isInProgress: false,
        isMissed: false
    }
}

export const mapMeetingStatusToSurveyStatus = (status: SalesMeetingStatus): SurveyStatusValue | null => {
    switch (status) {
        case 'signed':
            return 'completed'
        case 'refused':
            return 'refused'
        case 'no_cooperation':
            return 'no_cooperation'
        case 'not_home':
            return 'not_home'
        case 'follow_up':
            return 'attempted'
        default:
            return null
    }
}

export const mapSurveyStatusToMeetingStatus = (status: Survey['status']): SalesMeetingStatus | null => {
    switch (status) {
        case 'completed':
            return 'signed'
        case 'attempted':
            return 'follow_up'
        case 'refused':
            return 'refused'
        case 'no_cooperation':
            return 'no_cooperation'
        case 'not_home':
            return 'not_home'
        default:
            return null
    }
}

export const mapMeetingStatusToPoleStatus = (
    status: SalesMeetingStatus,
    refusalStage?: SalesMeetingRefusalStage | null
): string => {
    switch (status) {
        case 'signed':
            return 'Spotkanie zrealizowane'
        case 'refused':
            return refusalStage === 'before_meeting'
                ? 'Odmowa przed spotkaniem'
                : refusalStage === 'after_meeting'
                    ? 'Odmowa po spotkaniu'
                    : 'Odmowa klienta'
        case 'no_cooperation':
            return 'Brak wspolpracy'
        case 'not_home':
            return 'Nie bylo nikogo'
        case 'follow_up':
            return 'Kontakt ponowny'
        case 'cancelled':
            return 'Anulowane'
        default:
            return 'Zaplanowane'
    }
}

export const WORKER_SETTABLE_STATUSES: SalesMeetingStatus[] = ['signed', 'refused', 'no_cooperation', 'not_home', 'follow_up']
export const WORKER_SETTABLE_STATUS_OPTIONS: Array<{ key: WorkerSettableMeetingStatus; label: string }> = [
    ...SALES_MEETING_STATUSES
        .filter((status) => WORKER_SETTABLE_STATUSES.includes(status.key))
        .map((status) => ({
            key: status.key,
            label: status.key === 'refused' ? 'Odmowa przed spotkaniem' : status.label
        })),
    { key: 'missed', label: 'Nieodbyte' }
]
