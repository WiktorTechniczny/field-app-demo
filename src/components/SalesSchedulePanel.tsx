import { useCallback, useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import { pl } from 'date-fns/locale'
import { DayPicker } from 'react-day-picker'
import { supabase } from '../supabase'
import type { SalesMeeting, SalesMeetingStatus, Shift, User } from '../db'
import { APPOINTMENT_SLOTS } from '../appointmentSlots'
import {
    buildSalesMeetingRefusalNote,
    buildSalesMeetingMissedNote,
    buildSalesMeetingRescheduledNote,
    WORKER_SETTABLE_STATUSES,
    WORKER_SETTABLE_STATUS_OPTIONS,
    type WorkerSettableMeetingStatus,
    getSalesMeetingCleanStatusNote,
    getSalesMeetingDisplayMeta,
    getSalesMeetingEffectiveScheduledAt,
    isSalesMeetingMissed,
    mapMeetingStatusToPoleStatus,
    mapMeetingStatusToSurveyStatus
} from '../salesMeetingStatus'
import {
    isMissingSalesMeetingsLeadSourceColumnError,
    mapSalesMeetingsMutationError,
    omitLeadSource
} from '../salesMeetingsErrors'
import { getStartOfDayISO } from '../dateUtils'
import {
    getSalesMeetingAssignmentBadges,
    getSalesMeetingAssignmentMetaRows
} from '../poleAssignments'
import {
    DEFAULT_WORKER_MEETING_LEAD_SOURCE,
    SALES_MEETING_LEAD_SOURCE_OPTIONS,
    normalizeSalesMeetingAddress,
    normalizeSalesMeetingInlineText
} from '../salesMeetingText'
import { buildSalesMeetingImportKey } from '../salesMeetingIdentity'
import { findSalesMeetingSlotConflict } from '../salesMeetingConflicts'
import { syncPoleAssignmentsForMeetings } from '../salesMeetingPoleAssignments'
import toast from 'react-hot-toast'
import { SelectInput } from './SelectInput'
import { mergeSalesMeetingPatch, sortSalesMeetingsByScheduledAt } from '../salesMeetingCollections'
import { buildGoogleMapsDirectionsHref, buildPhoneHref } from '../contactLinks'
import { getSalesMeetingEnhancedAddress, getSalesMeetingPrimaryLocationLabel } from '../salesMeetingLocation'

const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-gray-200/50 dark:border-slate-700/80 shadow-lg'
const input =
    'w-full border border-gray-200 dark:border-slate-600 bg-gray-50 dark:bg-slate-700/50 rounded-xl px-3 py-2.5 text-sm focus:ring-2 focus:ring-violet-500 outline-none transition-all dark:text-white dark:[color-scheme:dark]'
const primaryButtonClass =
    'ui-pressable rounded-xl border border-violet-400/35 bg-violet-600 text-white shadow-lg shadow-violet-600/20 hover:bg-violet-500 font-black uppercase tracking-widest'
const secondaryButtonClass =
    'ui-pressable rounded-2xl border border-gray-200 bg-white text-gray-700 shadow-sm hover:bg-gray-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 font-black uppercase tracking-widest'
type DraftState = {
    status: WorkerSettableMeetingStatus
    note: string
    scheduledAt: string
}

type NewMeetingForm = {
    client_name: string
    address: string
    region: string
    phone: string
    lead_source: string
    scheduled_at: string
    note: string
}

const VOIVODESHIPS = [
    'Dolnośląskie',
    'Kujawsko-pomorskie',
    'Lubelskie',
    'Lubuskie',
    'Łódzkie',
    'Małopolskie',
    'Mazowieckie',
    'Opolskie',
    'Podkarpackie',
    'Podlaskie',
    'Pomorskie',
    'Śląskie',
    'Mazowieckie',
    'Warmińsko-mazurskie',
    'Wielkopolskie',
    'Zachodniopomorskie'
]

type RescheduleMode = 'meeting' | 'follow_up'
type WorkerQuickStatus = Extract<WorkerSettableMeetingStatus, 'follow_up' | 'refused' | 'no_cooperation' | 'not_home'>

const WORKER_QUICK_STATUS_OPTIONS: Array<{ key: WorkerQuickStatus; label: string }> = [
    { key: 'follow_up', label: 'Kontakt ponowny' },
    { key: 'refused', label: 'Odmowa / przerwanie kontaktu przed spotkaniem' },
    { key: 'no_cooperation', label: 'Brak wspolpracy' },
    { key: 'not_home', label: 'Nie było nikogo' }
]

const workerStatusRequiresNote = (status: WorkerSettableMeetingStatus): boolean =>
    status === 'follow_up' || status === 'refused' || status === 'no_cooperation' || status === 'not_home'

const getWorkerQuickStatusTitle = (status: WorkerQuickStatus): string => {
    switch (status) {
        case 'follow_up':
            return 'Formularz nowo ustalonego kontaktu ponownego'
        case 'refused':
            return 'Formularz odmowy / przerwania kontaktu przed spotkaniem'
        case 'no_cooperation':
            return 'Formularz braku wspolpracy'
        case 'not_home':
            return 'Formularz statusu: nie było nikogo'
        default:
            return 'Formularz statusu spotkania'
    }
}

const getWorkerQuickStatusNoteLabel = (status: WorkerQuickStatus): string => {
    switch (status) {
        case 'follow_up':
            return 'Notatka do nowo ustalonego kontaktu ponownego'
        case 'refused':
            return 'Notatka do odmowy / przerwania kontaktu przed spotkaniem'
        case 'no_cooperation':
            return 'Notatka do odmowy INNE'
        case 'not_home':
            return 'Notatka (opcjonalnie)'
        default:
            return 'Notatka'
    }
}

const getWorkerQuickStatusPlaceholder = (status: WorkerQuickStatus): string => {
    switch (status) {
        case 'follow_up':
            return 'Opisz ustalenia i nowy kontakt ponowny'
        case 'refused':
            return 'Opisz, dlaczego kontakt został przerwany przed spotkaniem'
        case 'no_cooperation':
            return 'Opisz powod braku wspolpracy'
        case 'not_home':
            return 'Krótka notatka, jeśli chcesz ją dodać'
        default:
            return 'Dodaj notatkę'
    }
}

const toDateLabel = (value: string): string =>
    new Date(value).toLocaleDateString('pl-PL', { year: 'numeric', month: '2-digit', day: '2-digit' })

const toTimeLabel = (value: string): string =>
    new Date(value).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })

const getTodayDateInput = (): string => {
    const date = new Date()
    const yyyy = date.getFullYear()
    const mm = String(date.getMonth() + 1).padStart(2, '0')
    const dd = String(date.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
}

const toLocalDate = (value: string): Date => {
    const [year, month, day] = value.split('-').map(Number)
    return new Date(year, month - 1, day)
}

const addDaysToDateInput = (datePart: string, days: number): string => {
    const date = toLocalDate(datePart)
    date.setDate(date.getDate() + days)
    const yyyy = date.getFullYear()
    const mm = String(date.getMonth() + 1).padStart(2, '0')
    const dd = String(date.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
}

const getScheduledDatePart = (value: string): string => {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) {
        const yyyy = date.getFullYear()
        const mm = String(date.getMonth() + 1).padStart(2, '0')
        const dd = String(date.getDate()).padStart(2, '0')
        return `${yyyy}-${mm}-${dd}`
    }

    const match = value.match(/^(\d{4}-\d{2}-\d{2})/)
    return match?.[1] || getTodayDateInput()
}

const getScheduledTimePart = (value: string): string => {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) {
        const hh = String(date.getHours()).padStart(2, '0')
        const mm = String(date.getMinutes()).padStart(2, '0')
        return `${hh}:${mm}`
    }

    const match = value.match(/T(\d{2}:\d{2})/)
    return match?.[1] || '10:00'
}

const combineScheduledDateTime = (datePart: string, timePart: string): string => `${datePart}T${timePart}`

const buildLocalScheduledAt = (datePart: string, timePart: string): Date => {
    const [year, month, day] = datePart.split('-').map(Number)
    const [hours, minutes] = timePart.split(':').map(Number)
    return new Date(year, month - 1, day, hours, minutes, 0, 0)
}

const isMeetingOnOrAfterToday = (value: string): boolean => {
    const scheduledAtMs = Date.parse(value)
    const startOfTodayMs = Date.parse(getStartOfDayISO())

    if (!Number.isFinite(scheduledAtMs) || !Number.isFinite(startOfTodayMs)) {
        return false
    }

    return scheduledAtMs >= startOfTodayMs
}

const getRangeStart = (): string => {
    const now = new Date()
    now.setDate(now.getDate() - 2)
    now.setHours(0, 0, 0, 0)
    return now.toISOString()
}

const getRangeEnd = (): string => {
    const now = new Date()
    now.setDate(now.getDate() + 30)
    now.setHours(23, 59, 59, 999)
    return now.toISOString()
}

const toDateTimeLocalInput = (): string => {
    const d = new Date()
    d.setMinutes(Math.ceil(d.getMinutes() / 30) * 30, 0, 0)
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const min = String(d.getMinutes()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}T${hh}:${min}`
}

const toDateTimeLocalValue = (value?: string | null): string => {
    if (!value) return toDateTimeLocalInput()

    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return toDateTimeLocalInput()

    const yyyy = date.getFullYear()
    const mm = String(date.getMonth() + 1).padStart(2, '0')
    const dd = String(date.getDate()).padStart(2, '0')
    const hh = String(date.getHours()).padStart(2, '0')
    const min = String(date.getMinutes()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}T${hh}:${min}`
}

const resolveGps = async (lastPos: [number, number] | null): Promise<{ lat: number; lng: number } | null> => {
    if (lastPos) return { lat: lastPos[0], lng: lastPos[1] }
    if (!navigator.geolocation) return null
    try {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
            navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 7000, enableHighAccuracy: true })
        )
        return { lat: pos.coords.latitude, lng: pos.coords.longitude }
    } catch {
        return null
    }
}

// Status color config for left border
const STATUS_BORDER: Record<string, string> = {
    planned: 'border-l-violet-400',
    completed: 'border-l-emerald-500',
    refused: 'border-l-rose-500',
    not_home: 'border-l-blue-400',
    follow_up: 'border-l-amber-400',
    cancelled: 'border-l-slate-400',
    no_cooperation: 'border-l-rose-500',
    missed: 'border-l-amber-500',
}

export default function SalesSchedulePanel({
    user,
    activeShift,
    lastPos,
    externalMeetingPatch,
    onMeetingsChange,
    onFocusMeeting,
    onStartMeeting,
    getStartAvailability,
    allowManualAdd = true,
    informationalOnly = false
}: {
    user: User
    activeShift: Shift | null
    lastPos: [number, number] | null
    externalMeetingPatch?: SalesMeeting | null
    onMeetingsChange?: (meetings: SalesMeeting[]) => void
    onFocusMeeting?: (meeting: SalesMeeting) => void
    onStartMeeting?: (meeting: SalesMeeting) => void
    getStartAvailability?: (meeting: SalesMeeting) => { allowed: boolean; reason: string | null }
    allowManualAdd?: boolean
    informationalOnly?: boolean
}) {
    const [meetings, setMeetings] = useState<SalesMeeting[]>([])
    const [loading, setLoading] = useState(false)
    const [savingId, setSavingId] = useState<number | null>(null)
    const [drafts, setDrafts] = useState<Record<number, DraftState>>({})
    const [expandedId, setExpandedId] = useState<number | null>(null)
    const [statusEditorId, setStatusEditorId] = useState<number | null>(null)
    const [statusPickerMeeting, setStatusPickerMeeting] = useState<SalesMeeting | null>(null)
    const [statusDetailsMeeting, setStatusDetailsMeeting] = useState<SalesMeeting | null>(null)
    const [statusDetailsDate, setStatusDetailsDate] = useState(getTodayDateInput())
    const [statusDetailsTime, setStatusDetailsTime] = useState('10:00')
    const [statusDetailsPickerMonth, setStatusDetailsPickerMonth] = useState<Date>(() => toLocalDate(getTodayDateInput()))
    const [showAddModal, setShowAddModal] = useState(false)
    const [addLoading, setAddLoading] = useState(false)
    const [newMeetingPickerMonth, setNewMeetingPickerMonth] = useState<Date>(() => toLocalDate(getTodayDateInput()))
    const [rescheduleMeeting, setRescheduleMeeting] = useState<SalesMeeting | null>(null)
    const [rescheduleMode, setRescheduleMode] = useState<RescheduleMode>('meeting')
    const [rescheduleDate, setRescheduleDate] = useState(getTodayDateInput())
    const [rescheduleTime, setRescheduleTime] = useState('10:00')
    const [reschedulePickerMonth, setReschedulePickerMonth] = useState<Date>(() => toLocalDate(getTodayDateInput()))
    const [newMeeting, setNewMeeting] = useState<NewMeetingForm>({
        client_name: '',
        address: '',
        region: '',
        phone: '',
        lead_source: DEFAULT_WORKER_MEETING_LEAD_SOURCE,
        scheduled_at: toDateTimeLocalInput(),
        note: '',
    })
    const meetingActionsLocked = !activeShift
    const meetingActionsLockReason = 'Najpierw rozpocznij pracę.'

    const buildDraftState = useCallback(
        (meeting: SalesMeeting): DraftState => ({
            status: getSalesMeetingDisplayMeta(meeting).isMissed ? 'missed' : meeting.status,
            note: getSalesMeetingCleanStatusNote(meeting.status_note) ?? '',
            scheduledAt: toDateTimeLocalValue(meeting.scheduled_at)
        }),
        []
    )

    const ensureShiftStartedForMeetingAction = useCallback(
        (message: string): boolean => {
            if (activeShift) return true
            toast.error(message)
            return false
        },
        [activeShift]
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

    const isSlotUnavailableForMeeting = useCallback(
        (datePart: string, timePart: string, currentMeetingId?: number | null, now = new Date()): boolean => {
            const scheduledAt = buildLocalScheduledAt(datePart, timePart)
            if (scheduledAt.getTime() <= now.getTime()) return true

            return effectiveMeetings.some((meeting) => {
                if (!meeting.id || meeting.id === currentMeetingId || meeting.status === 'cancelled') return false
                return (
                    getScheduledDatePart(meeting.scheduled_at) === datePart &&
                    getScheduledTimePart(meeting.scheduled_at) === timePart
                )
            })
        },
        [effectiveMeetings]
    )

    const getFirstAvailableSlot = useCallback(
        (datePart: string, currentMeetingId?: number | null, now = new Date()): string | null =>
            APPOINTMENT_SLOTS.find((slot) => !isSlotUnavailableForMeeting(datePart, slot, currentMeetingId, now)) ?? null,
        [isSlotUnavailableForMeeting]
    )

    const getNextAvailableScheduledAt = useCallback(
        (preferredDate: string, currentMeetingId?: number | null, now = new Date()): string | null => {
            let datePart = preferredDate < getTodayDateInput() ? getTodayDateInput() : preferredDate

            for (let offset = 0; offset < 366; offset += 1) {
                const slot = getFirstAvailableSlot(datePart, currentMeetingId, now)
                if (slot) return combineScheduledDateTime(datePart, slot)
                datePart = addDaysToDateInput(datePart, 1)
            }

            return null
        },
        [getFirstAvailableSlot]
    )

    const getNextAvailableScheduledAtAfter = useCallback(
        (currentScheduledAt: string, currentMeetingId?: number | null, now = new Date()): string | null => {
            const initialDatePart = getScheduledDatePart(currentScheduledAt)
            const baseline = buildLocalScheduledAt(initialDatePart, getScheduledTimePart(currentScheduledAt))
            let datePart = initialDatePart < getTodayDateInput() ? getTodayDateInput() : initialDatePart

            for (let offset = 0; offset < 366; offset += 1) {
                for (const slot of APPOINTMENT_SLOTS) {
                    const candidate = buildLocalScheduledAt(datePart, slot)
                    if (candidate.getTime() <= baseline.getTime()) continue
                    if (candidate.getTime() <= now.getTime()) continue
                    if (!isSlotUnavailableForMeeting(datePart, slot, currentMeetingId, now)) {
                        return combineScheduledDateTime(datePart, slot)
                    }
                }

                datePart = addDaysToDateInput(datePart, 1)
            }

            return null
        },
        [isSlotUnavailableForMeeting]
    )

    const closeRescheduleModal = useCallback(() => {
        if (savingId !== null) return
        setRescheduleMeeting(null)
        setRescheduleMode('meeting')
    }, [savingId])

    const openRescheduleModal = useCallback(
        (meeting: SalesMeeting, mode: RescheduleMode = 'meeting') => {
            const blockedMessage =
                mode === 'follow_up'
                    ? 'Najpierw rozpocznij pracę, aby ustawić termin kontaktu.'
                    : 'Najpierw rozpocznij pracę, aby przełożyć termin spotkania.'
            if (!ensureShiftStartedForMeetingAction(blockedMessage)) return

            const draft = meeting.id ? drafts[meeting.id] || buildDraftState(meeting) : buildDraftState(meeting)
            const sourceScheduledAt =
                mode === 'follow_up' && draft.scheduledAt
                    ? draft.scheduledAt
                    : meeting.scheduled_at
            const currentDatePart = getScheduledDatePart(sourceScheduledAt)
            const currentTimePart = getScheduledTimePart(sourceScheduledAt)
            const nextScheduledAt = isSlotUnavailableForMeeting(currentDatePart, currentTimePart, meeting.id ?? null)
                ? getNextAvailableScheduledAt(currentDatePart, meeting.id ?? null)
                : combineScheduledDateTime(currentDatePart, currentTimePart)

            const nextDatePart = nextScheduledAt ? getScheduledDatePart(nextScheduledAt) : currentDatePart
            const nextTimePart = nextScheduledAt ? getScheduledTimePart(nextScheduledAt) : currentTimePart

            setRescheduleMeeting(meeting)
            setRescheduleMode(mode)
            setRescheduleDate(nextDatePart)
            setRescheduleTime(nextTimePart)
            setReschedulePickerMonth(toLocalDate(nextDatePart))
        },
        [buildDraftState, drafts, ensureShiftStartedForMeetingAction, getNextAvailableScheduledAt, isSlotUnavailableForMeeting]
    )

    const resetMeetingDraft = useCallback(
        (meeting: SalesMeeting) => {
            if (!meeting.id) return
            setDrafts((prev) => ({
                ...prev,
                [meeting.id!]: buildDraftState(meeting)
            }))
        },
        [buildDraftState]
    )

    const closeStatusPicker = useCallback(() => {
        if (savingId !== null) return
        setStatusEditorId(null)
        setStatusPickerMeeting(null)
    }, [savingId])

    const closeStatusDetails = useCallback(
        (options?: { resetDraft?: boolean }) => {
            if (savingId !== null) return
            if (options?.resetDraft !== false && statusDetailsMeeting) {
                resetMeetingDraft(statusDetailsMeeting)
            }
            setStatusEditorId(null)
            setStatusDetailsMeeting(null)
        },
        [resetMeetingDraft, savingId, statusDetailsMeeting]
    )

    const openStatusPicker = useCallback(
        (meeting: SalesMeeting) => {
            if (!meeting.id) return
            if (!ensureShiftStartedForMeetingAction('Najpierw rozpocznij pracę, aby ustawić status spotkania.')) return
            setDrafts((prev) => ({
                ...prev,
                [meeting.id!]: prev[meeting.id!] || buildDraftState(meeting)
            }))
            setStatusEditorId(null)
            setStatusPickerMeeting(meeting)
        },
        [buildDraftState, ensureShiftStartedForMeetingAction]
    )

    const openStatusDetails = useCallback(
        (meeting: SalesMeeting, status: WorkerQuickStatus) => {
            if (!meeting.id) return
            if (!ensureShiftStartedForMeetingAction('Najpierw rozpocznij pracę, aby ustawić status spotkania.')) return

            const currentDraft = drafts[meeting.id] || buildDraftState(meeting)
            const nextDraft: DraftState = {
                ...currentDraft,
                status
            }

            if (status === 'follow_up') {
                const preferredScheduledAt =
                    currentDraft.status === 'follow_up' && currentDraft.scheduledAt && currentDraft.scheduledAt !== meeting.scheduled_at
                        ? currentDraft.scheduledAt
                        : getNextAvailableScheduledAtAfter(meeting.scheduled_at, meeting.id ?? null) ??
                          getNextAvailableScheduledAt(getTodayDateInput(), meeting.id ?? null) ??
                          combineScheduledDateTime(getTodayDateInput(), APPOINTMENT_SLOTS[0] || '10:00')

                nextDraft.scheduledAt = preferredScheduledAt
                setStatusDetailsDate(getScheduledDatePart(preferredScheduledAt))
                setStatusDetailsTime(getScheduledTimePart(preferredScheduledAt))
                setStatusDetailsPickerMonth(toLocalDate(getScheduledDatePart(preferredScheduledAt)))
            }

            setDrafts((prev) => ({
                ...prev,
                [meeting.id!]: nextDraft
            }))
            setStatusEditorId(null)
            setStatusPickerMeeting(null)
            setStatusDetailsMeeting(meeting)
        },
        [buildDraftState, drafts, ensureShiftStartedForMeetingAction, getNextAvailableScheduledAt, getNextAvailableScheduledAtAfter]
    )

    const loadMeetings = useCallback(async (options?: { silent?: boolean }) => {
        if (!user.id) return
        const silent = options?.silent ?? false
        if (!silent) setLoading(true)
        const { data, error } = await supabase
            .from('sales_meetings')
            .select('*')
            .eq('salesperson_id', user.id)
            .gte('scheduled_at', getRangeStart())
            .lte('scheduled_at', getRangeEnd())
            .order('scheduled_at', { ascending: true })

        if (error) {
            toast.error(`Nie udało się pobrać grafiku: ${error.message}`)
            setLoading(false)
            return
        }

        const nextMeetings = mergeSalesMeetingPatch((data || []) as SalesMeeting[], externalMeetingPatch)
        setMeetings(nextMeetings)
        onMeetingsChange?.(nextMeetings)
        setLoading(false)
    }, [externalMeetingPatch, onMeetingsChange, user.id])

    useEffect(() => {
        setMeetings((prev) => {
            const nextMeetings = mergeSalesMeetingPatch(prev, externalMeetingPatch)
            if (nextMeetings !== prev) {
                onMeetingsChange?.(nextMeetings)
            }
            return nextMeetings
        })
    }, [externalMeetingPatch, onMeetingsChange])

    useEffect(() => {
        void loadMeetings()

        const meetingsChannel = supabase
            .channel(`sales_meetings_worker_${user.id}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'sales_meetings'
                },
                () => {
                    void loadMeetings({ silent: true })
                }
            )
            .subscribe()

        const handleVisibilitySync = () => {
            if (document.visibilityState === 'visible') {
                void loadMeetings({ silent: true })
            }
        }

        window.addEventListener('focus', handleVisibilitySync)
        document.addEventListener('visibilitychange', handleVisibilitySync)

        return () => {
            window.removeEventListener('focus', handleVisibilitySync)
            document.removeEventListener('visibilitychange', handleVisibilitySync)
            supabase.removeChannel(meetingsChannel)
        }
    }, [loadMeetings, user.id])

    useEffect(() => {
        setDrafts((prev) => {
            const next = { ...prev }
            effectiveMeetings.forEach((meeting) => {
                if (!meeting.id) return
                if (!next[meeting.id]) {
                    next[meeting.id] = buildDraftState(meeting)
                }
            })
            return next
        })
    }, [buildDraftState, effectiveMeetings])

    const openMeetings = useMemo(
        () =>
            effectiveMeetings
                .filter(
                    (meeting) =>
                        (meeting.status === 'planned' || meeting.status === 'follow_up') &&
                        !isSalesMeetingMissed(meeting) &&
                        isMeetingOnOrAfterToday(meeting.scheduled_at)
                )
                .sort((left, right) => new Date(left.scheduled_at).getTime() - new Date(right.scheduled_at).getTime()),
        [effectiveMeetings]
    )
    const groupedMeetings = useMemo(() => {
        const map = new Map<string, SalesMeeting[]>()
        openMeetings.forEach((meeting) => {
            const key = toDateLabel(meeting.scheduled_at)
            const arr = map.get(key) || []
            arr.push(meeting)
            map.set(key, arr)
        })
        return Array.from(map.entries())
    }, [openMeetings])
    const newMeetingDatePart = useMemo(() => getScheduledDatePart(newMeeting.scheduled_at), [newMeeting.scheduled_at])
    const newMeetingTimePart = useMemo(() => getScheduledTimePart(newMeeting.scheduled_at), [newMeeting.scheduled_at])
    const newMeetingDateValue = useMemo(() => toLocalDate(newMeetingDatePart), [newMeetingDatePart])
    const newMeetingTimeOptions = useMemo(
        () => Array.from(new Set([newMeetingTimePart, ...APPOINTMENT_SLOTS])).sort((left, right) => left.localeCompare(right)),
        [newMeetingTimePart]
    )
    const unavailableNewMeetingSlots = useMemo(
        () => new Set(newMeetingTimeOptions.filter((slot) => isSlotUnavailableForMeeting(newMeetingDatePart, slot))),
        [isSlotUnavailableForMeeting, newMeetingDatePart, newMeetingTimeOptions]
    )
    const newMeetingScheduledAtValue = useMemo(() => new Date(newMeeting.scheduled_at), [newMeeting.scheduled_at])
    const isNewMeetingFormValid = useMemo(() => {
        const hasClientName = Boolean(newMeeting.client_name.trim())
        const hasLeadSource = Boolean(newMeeting.lead_source.trim())
        const hasPhone = newMeeting.phone.replace(/\D+/g, '').length >= 9
        const hasAddress = Boolean(newMeeting.address.trim())
        const hasRegion = Boolean(newMeeting.region.trim())
        const hasValidScheduledAt = Number.isFinite(newMeetingScheduledAtValue.getTime())
        const isFutureMeeting = hasValidScheduledAt && newMeetingScheduledAtValue.getTime() > Date.now()
        const isAvailableSlot = !isSlotUnavailableForMeeting(newMeetingDatePart, newMeetingTimePart)

        return hasClientName && hasLeadSource && hasPhone && hasAddress && hasRegion && hasValidScheduledAt && isFutureMeeting && isAvailableSlot
    }, [
        isSlotUnavailableForMeeting,
        newMeeting.address,
        newMeeting.client_name,
        newMeeting.lead_source,
        newMeeting.phone,
        newMeeting.region,
        newMeetingDatePart,
        newMeetingScheduledAtValue,
        newMeetingTimePart
    ])
    const rescheduleDateValue = useMemo(() => toLocalDate(rescheduleDate), [rescheduleDate])
    const rescheduleTimeOptions = useMemo(
        () => Array.from(new Set([rescheduleTime, ...APPOINTMENT_SLOTS])).sort((left, right) => left.localeCompare(right)),
        [rescheduleTime]
    )
    const unavailableRescheduleSlots = useMemo(
        () =>
            new Set(
                rescheduleTimeOptions.filter((slot) =>
                    isSlotUnavailableForMeeting(rescheduleDate, slot, rescheduleMeeting?.id ?? null)
                )
            ),
        [isSlotUnavailableForMeeting, rescheduleDate, rescheduleMeeting?.id, rescheduleTimeOptions]
    )
    const statusDetailsDateValue = useMemo(() => toLocalDate(statusDetailsDate), [statusDetailsDate])
    const statusDetailsTimeOptions = useMemo(
        () => Array.from(new Set([statusDetailsTime, ...APPOINTMENT_SLOTS])).sort((left, right) => left.localeCompare(right)),
        [statusDetailsTime]
    )
    const unavailableStatusDetailsSlots = useMemo(
        () =>
            new Set(
                statusDetailsTimeOptions.filter((slot) =>
                    isSlotUnavailableForMeeting(statusDetailsDate, slot, statusDetailsMeeting?.id ?? null)
                )
            ),
        [isSlotUnavailableForMeeting, statusDetailsDate, statusDetailsMeeting?.id, statusDetailsTimeOptions]
    )

    useEffect(() => {
        if (informationalOnly) {
            setExpandedId(null)
            return
        }

        if (expandedId !== null && !openMeetings.some((meeting) => meeting.id === expandedId)) {
            setExpandedId(null)
        }
    }, [expandedId, informationalOnly, openMeetings])

    const handleRescheduleDateChange = (date?: Date) => {
        if (!date) return
        const today = toLocalDate(getTodayDateInput())
        if (date < today) return

        const year = date.getFullYear()
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        const nextDatePart = `${year}-${month}-${day}`
        const nextTime = isSlotUnavailableForMeeting(nextDatePart, rescheduleTime, rescheduleMeeting?.id ?? null)
            ? getFirstAvailableSlot(nextDatePart, rescheduleMeeting?.id ?? null) ?? rescheduleTime
            : rescheduleTime

        setRescheduleDate(nextDatePart)
        setRescheduleTime(nextTime)
    }

    const handleRescheduleTimeChange = (slot: string) => {
        if (unavailableRescheduleSlots.has(slot)) return
        setRescheduleTime(slot)
    }

    const handleStatusDetailsDateChange = (date?: Date) => {
        if (!date || !statusDetailsMeeting?.id) return
        const today = toLocalDate(getTodayDateInput())
        if (date < today) return

        const year = date.getFullYear()
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        const nextDatePart = `${year}-${month}-${day}`
        const nextTime = isSlotUnavailableForMeeting(nextDatePart, statusDetailsTime, statusDetailsMeeting.id)
            ? getFirstAvailableSlot(nextDatePart, statusDetailsMeeting.id) ?? statusDetailsTime
            : statusDetailsTime

        setStatusDetailsPickerMonth(new Date(date.getFullYear(), date.getMonth(), 1))
        setStatusDetailsDate(nextDatePart)
        setStatusDetailsTime(nextTime)
        updateDraft(statusDetailsMeeting.id, {
            scheduledAt: combineScheduledDateTime(nextDatePart, nextTime)
        })
    }

    const handleStatusDetailsTimeChange = (slot: string) => {
        if (!statusDetailsMeeting?.id || unavailableStatusDetailsSlots.has(slot)) return
        setStatusDetailsTime(slot)
        updateDraft(statusDetailsMeeting.id, {
            scheduledAt: combineScheduledDateTime(statusDetailsDate, slot)
        })
    }

    const handleNewMeetingDateChange = (date?: Date) => {
        if (!date) return
        const today = toLocalDate(getTodayDateInput())
        if (date < today) return

        const year = date.getFullYear()
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        const nextDatePart = `${year}-${month}-${day}`
        const nextTime = isSlotUnavailableForMeeting(nextDatePart, newMeetingTimePart)
            ? getFirstAvailableSlot(nextDatePart) ?? newMeetingTimePart
            : newMeetingTimePart

        setNewMeetingPickerMonth(new Date(date.getFullYear(), date.getMonth(), 1))
        setNewMeeting((prev) => ({
            ...prev,
            scheduled_at: combineScheduledDateTime(nextDatePart, nextTime)
        }))
    }

    const handleNewMeetingTimeChange = (slot: string) => {
        if (unavailableNewMeetingSlots.has(slot)) return
        setNewMeeting((prev) => ({
            ...prev,
            scheduled_at: combineScheduledDateTime(newMeetingDatePart, slot)
        }))
    }

    const updateDraft = (meetingId: number, patch: Partial<DraftState>) => {
        setDrafts((prev) => ({ ...prev, [meetingId]: { ...prev[meetingId], ...patch } }))
    }

    const saveMeetingStatus = async (meeting: SalesMeeting) => {
        if (!meeting.id) return
        const meetingId = meeting.id
        if (!activeShift?.id || !user.id) {
            toast.error('Najpierw rozpocznij pracę, aby zapisać status spotkania.')
            return
        }

        const draft = drafts[meetingId] || {
            status: getSalesMeetingDisplayMeta(meeting).isMissed ? 'missed' : meeting.status,
            note: getSalesMeetingCleanStatusNote(meeting.status_note) ?? '',
            scheduledAt: toDateTimeLocalValue(meeting.scheduled_at)
        }
        const isDraftMissed = draft.status === 'missed'
        if (!isDraftMissed && !WORKER_SETTABLE_STATUSES.includes(draft.status as SalesMeetingStatus)) {
            toast.error('Wybierz status dostępny dla handlowca.')
            return
        }

        setSavingId(meetingId)
        try {
            const gps = await resolveGps(lastPos)
            const resolvedDraftStatus: SalesMeetingStatus | null = draft.status === 'missed' ? null : draft.status
            if (resolvedDraftStatus === 'signed') {
                toast.error('Umowę zapisujesz przez rozpoczęcie spotkania.')
                return
            }
            const surveyStatus = resolvedDraftStatus ? mapMeetingStatusToSurveyStatus(resolvedDraftStatus) : null
            const refusalStage = resolvedDraftStatus === 'refused' ? 'before_meeting' : null
            let linkedSurveyId = meeting.linked_survey_id ?? null
            const rescheduledAt =
                resolvedDraftStatus === 'follow_up' && draft.scheduledAt
                    ? new Date(draft.scheduledAt)
                    : null
            if (resolvedDraftStatus && workerStatusRequiresNote(resolvedDraftStatus) && !draft.note.trim()) {
                toast.error('Dodaj notatkę do wybranego statusu.')
                return
            }

            if (resolvedDraftStatus === 'follow_up' && (!rescheduledAt || Number.isNaN(rescheduledAt.getTime()))) {
                toast.error('Wybierz poprawną nową datę i godzinę spotkania.')
                return
            }

            if (resolvedDraftStatus === 'follow_up' && new Date(meeting.scheduled_at).getTime() === rescheduledAt?.getTime()) {
                toast.error('Ustaw nowy termin ponownego kontaktu.')
                return
            }

            if (resolvedDraftStatus === 'follow_up' && rescheduledAt) {
                const slotConflict = await findSalesMeetingSlotConflict({
                    salespersonId: user.id,
                    scheduledAt: rescheduledAt.toISOString(),
                    excludeMeetingId: meeting.id
                })
                if (slotConflict) {
                    toast.error(`Ten termin jest już zajęty przez: ${slotConflict.client_name}.`)
                    return
                }
            }

            if (surveyStatus) {
                const createdAt = new Date().toISOString()
                const answers: Record<string, string> = {
                    pole_status: mapMeetingStatusToPoleStatus(resolvedDraftStatus!, refusalStage),
                    source: 'sales_meeting',
                    meeting_id: String(meetingId),
                    imported_note: meeting.note || ''
                }
                if (refusalStage) {
                    answers.refusal_stage = refusalStage
                }
                if (meeting.lead_source) {
                    answers.lead_source = meeting.lead_source
                }
                if (draft.note.trim()) {
                    answers.status_note = draft.note.trim()
                }
                if (resolvedDraftStatus === 'follow_up' && draft.note.trim()) {
                    answers.notatka_z_kontaktu = draft.note.trim()
                }

                const preferredDate = rescheduledAt
                    ? rescheduledAt.toLocaleDateString('sv-SE')
                    : new Date(meeting.scheduled_at).toLocaleDateString('sv-SE')
                const preferredTime = rescheduledAt
                    ? rescheduledAt.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })
                    : toTimeLabel(meeting.scheduled_at)
                const surveyAddress =
                    normalizeSalesMeetingAddress(meeting.address) || (gps ? `GPS: ${gps.lat.toFixed(6)}, ${gps.lng.toFixed(6)}` : 'Brak adresu')

                if (linkedSurveyId && resolvedDraftStatus !== 'follow_up') {
                    const { error: updateSurveyError } = await supabase
                        .from('surveys')
                        .update({
                            status: surveyStatus,
                            respondent_name: meeting.client_name || undefined,
                            respondent_phone: meeting.phone || undefined,
                            address: surveyAddress,
                            answers,
                            latitude: gps?.lat,
                            longitude: gps?.lng,
                            respondent_preferred_date: undefined,
                            respondent_preferred_time: undefined
                        })
                        .eq('id', linkedSurveyId)
                    if (updateSurveyError) linkedSurveyId = null
                }

                if (!linkedSurveyId || draft.status === 'follow_up') {
                    const { data: insertedSurvey, error: insertSurveyError } = await supabase
                        .from('surveys')
                        .insert({
                            shift_id: activeShift.id,
                            user_id: user.id,
                            user_name: user.name,
                            created_at: createdAt,
                            status: surveyStatus,
                            respondent_name: meeting.client_name || undefined,
                            respondent_phone: meeting.phone || undefined,
                            address: surveyAddress,
                            answers,
                            latitude: gps?.lat,
                            longitude: gps?.lng,
                            respondent_preferred_date: draft.status === 'follow_up' ? preferredDate : undefined,
                            respondent_preferred_time: draft.status === 'follow_up' ? preferredTime : undefined
                        })
                        .select('id')
                        .single()
                    if (insertSurveyError) throw insertSurveyError
                    linkedSurveyId = insertedSurvey.id
                }
            }

            const meetingUpdate: Record<string, string | number | null> = {
                status: isDraftMissed ? meeting.status : draft.status,
                status_note: isDraftMissed
                    ? buildSalesMeetingMissedNote(draft.note)
                    : resolvedDraftStatus === 'refused'
                        ? buildSalesMeetingRefusalNote('before_meeting', draft.note)
                        : draft.note.trim() || null,
                status_updated_at: new Date().toISOString(),
                linked_survey_id: linkedSurveyId
            }

            if (resolvedDraftStatus === 'follow_up' && rescheduledAt) {
                meetingUpdate.scheduled_at = rescheduledAt.toISOString()
            }

            const { error: updateMeetingError } = await supabase
                .from('sales_meetings')
                .update(meetingUpdate)
                .eq('id', meetingId)

            if (updateMeetingError) throw updateMeetingError

            try {
                await syncPoleAssignmentsForMeetings([{
                    ...meeting,
                    ...meetingUpdate,
                    scheduled_at: (meetingUpdate.scheduled_at as string | undefined) || meeting.scheduled_at,
                    status: (meetingUpdate.status as SalesMeetingStatus) || meeting.status
                }])
            } catch (syncError) {
                console.warn('Meeting status saved without pole assignment sync:', syncError)
            }

            setDrafts((prev) => ({
                ...prev,
                [meetingId]: {
                    ...(prev[meetingId] || buildDraftState(meeting)),
                    status: draft.status,
                    note: draft.note,
                    scheduledAt: rescheduledAt ? toDateTimeLocalValue(rescheduledAt.toISOString()) : draft.scheduledAt
                }
            }))
            toast.success('Status spotkania zapisany.')
            setStatusEditorId(null)
            setStatusPickerMeeting(null)
            setStatusDetailsMeeting(null)
            setExpandedId(null)
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'Nieznany błąd zapisu statusu.'
            toast.error(mapSalesMeetingsMutationError(error))
            void msg
        } finally {
            setSavingId(null)
        }
    }

    const saveMeetingReschedule = async () => {
        if (!rescheduleMeeting?.id) return
        const meeting = rescheduleMeeting
        const meetingId = meeting.id
        if (meetingId === undefined) return
        if (
            !ensureShiftStartedForMeetingAction(
                rescheduleMode === 'follow_up'
                    ? 'Najpierw rozpocznij pracę, aby zapisać termin kontaktu.'
                    : 'Najpierw rozpocznij pracę, aby zapisać nowy termin spotkania.'
            )
        ) {
            return
        }

        if (!rescheduleDate || !rescheduleTime) {
            toast.error('Wybierz poprawną datę i godzinę nowego terminu.')
            return
        }

        if (isSlotUnavailableForMeeting(rescheduleDate, rescheduleTime, meetingId)) {
            toast.error('Ten termin nie jest już dostępny. Wybierz inną godzinę.')
            return
        }

        const rescheduledAt = buildLocalScheduledAt(rescheduleDate, rescheduleTime)
        if (Number.isNaN(rescheduledAt.getTime())) {
            toast.error('Wybierz poprawną datę i godzinę nowego terminu.')
            return
        }

        const slotConflict = await findSalesMeetingSlotConflict({
            salespersonId: user.id,
            scheduledAt: rescheduledAt.toISOString(),
            excludeMeetingId: meeting.id
        })
        if (slotConflict) {
            toast.error(`Ten termin jest już zajęty przez: ${slotConflict.client_name}.`)
            return
        }

        if (new Date(meeting.scheduled_at).getTime() === rescheduledAt.getTime()) {
            toast.error('Wybierz inny termin niż obecnie zaplanowany.')
            return
        }

        setSavingId(meetingId)
        try {
            const nextScheduledAtIso = rescheduledAt.toISOString()
            if (rescheduleMode === 'follow_up') {
                setDrafts((prev) => ({
                    ...prev,
                    [meetingId]: {
                        ...(prev[meetingId] || buildDraftState(meeting)),
                        status: 'follow_up',
                        scheduledAt: toDateTimeLocalValue(nextScheduledAtIso)
                    }
                }))
                toast.success('Termin ponownego kontaktu ustawiony.')
                setRescheduleMeeting(null)
                setRescheduleMode('meeting')
                return
            }
            const statusUpdatedAtIso = new Date().toISOString()
            const updatePayload: Record<string, string | null> = {
                scheduled_at: nextScheduledAtIso,
                status_note: buildSalesMeetingRescheduledNote(meeting.scheduled_at, nextScheduledAtIso, meeting.status_note),
                status_updated_at: statusUpdatedAtIso
            }

            if (meeting.linked_survey_id) {
                const preferredDate = rescheduledAt.toLocaleDateString('sv-SE')
                const preferredTime = rescheduledAt.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })

                const { error: updateSurveyError } = await supabase
                    .from('surveys')
                    .update({
                        respondent_preferred_date: preferredDate,
                        respondent_preferred_time: preferredTime
                    })
                    .eq('id', meeting.linked_survey_id)

                if (updateSurveyError) throw updateSurveyError
            }

            const { error } = await supabase
                .from('sales_meetings')
                .update(updatePayload)
                .eq('id', meetingId)

            if (error) throw error

            const updatedMeeting: SalesMeeting = {
                ...meeting,
                scheduled_at: nextScheduledAtIso,
                status_note: updatePayload.status_note,
                status_updated_at: statusUpdatedAtIso
            }
            const nextMeetings = sortSalesMeetingsByScheduledAt(
                meetings.map((item) => (item.id === meetingId ? updatedMeeting : item))
            )
            setMeetings(nextMeetings)
            onMeetingsChange?.(nextMeetings)

            try {
                await syncPoleAssignmentsForMeetings([updatedMeeting])
            } catch (syncError) {
                console.warn('Meeting reschedule saved without pole assignment sync:', syncError)
            }

            setDrafts((prev) => ({
                ...prev,
                [meetingId]: {
                    ...(prev[meetingId] || buildDraftState(meeting)),
                    scheduledAt: toDateTimeLocalValue(nextScheduledAtIso)
                }
            }))
            toast.success('Termin spotkania został przełożony.')
            setRescheduleMeeting(null)
            setRescheduleMode('meeting')
            await loadMeetings()
        } catch (error) {
            toast.error(mapSalesMeetingsMutationError(error))
        } finally {
            setSavingId(null)
        }
    }

    const handleAddMeeting = async () => {
        if (!newMeeting.lead_source.trim()) {
            toast.error('Wybierz źródło pozyskania leada.')
            return
        }
        if (!newMeeting.client_name.trim()) {
            toast.error('Wpisz imię i nazwisko lub nazwę firmy.')
            return
        }
        if (newMeeting.phone.replace(/\D+/g, '').length < 9) {
            toast.error('Podaj poprawny numer telefonu.')
            return
        }
        if (!newMeeting.address.trim()) {
            toast.error('Podaj adres spotkania.')
            return
        }
        if (!newMeeting.region.trim()) {
            toast.error('Wybierz województwo.')
            return
        }
        if (!newMeeting.scheduled_at || Number.isNaN(newMeetingScheduledAtValue.getTime())) {
            toast.error('Wybierz poprawną datę i godzinę spotkania.')
            return
        }
        if (newMeetingScheduledAtValue.getTime() <= Date.now()) {
            toast.error('Nie można dodać spotkania w przeszłości.')
            return
        }
        if (isSlotUnavailableForMeeting(newMeetingDatePart, newMeetingTimePart)) {
            toast.error('Ten termin nie jest już dostępny. Wybierz inną godzinę.')
            return
        }
        if (!user.id) return
        setAddLoading(true)
        try {
            const scheduledAt = new Date(newMeeting.scheduled_at).toISOString()
            const normalizedAddress = normalizeSalesMeetingAddress(newMeeting.address)
            const slotConflict = await findSalesMeetingSlotConflict({
                salespersonId: user.id,
                scheduledAt
            })
            if (slotConflict) {
                toast.error(`Ten termin jest już zajęty przez: ${slotConflict.client_name}.`)
                return
            }

            const importKey = buildSalesMeetingImportKey({
                salespersonId: user.id,
                scheduledAt,
                clientName: newMeeting.client_name,
                address: normalizedAddress
            })
            const payload = {
                salesperson_id: user.id,
                salesperson_name: user.name,
                lead_source: newMeeting.lead_source,
                client_name: newMeeting.client_name.trim(),
                address: normalizedAddress,
                region: newMeeting.region || null,
                phone: newMeeting.phone.trim() || null,
                note: normalizeSalesMeetingInlineText(newMeeting.note) || null,
                scheduled_at: scheduledAt,
                status: 'planned' as SalesMeetingStatus,
                imported_at: new Date().toISOString(),
                import_key: importKey,
            }
            let savedWithoutLeadSource = false
            let response = await supabase
                .from('sales_meetings')
                .upsert(payload, { onConflict: 'import_key' })
                .select('*')
                .single()
            let { error } = response
            if (error && isMissingSalesMeetingsLeadSourceColumnError(error)) {
                savedWithoutLeadSource = true
                response = await supabase
                    .from('sales_meetings')
                    .upsert(omitLeadSource(payload), { onConflict: 'import_key' })
                    .select('*')
                    .single()
                error = response.error
            }
            if (error) throw error
            const savedMeeting = (response.data as SalesMeeting | null) ?? null

            if (savedMeeting) {
                try {
                    await syncPoleAssignmentsForMeetings([savedMeeting])
                } catch (syncError) {
                    console.warn('Worker meeting saved without pole assignment sync:', syncError)
                    toast('Spotkanie zapisane, ale wpis w tabeli działek nie zsynchronizował się automatycznie.', {
                        icon: 'ℹ️'
                    })
                }
            }
            toast.success(
                savedWithoutLeadSource
                    ? 'Spotkanie dodane, ale bez pola "Źródło pozyskania leada" - w bazie brakuje kolumny "lead_source".'
                    : 'Spotkanie dodane!'
            )
            setShowAddModal(false)
            const nextScheduledAt = getNextAvailableScheduledAt(getTodayDateInput()) ?? toDateTimeLocalInput()
            setNewMeeting({
                client_name: '',
                address: '',
                region: '',
                phone: '',
                lead_source: DEFAULT_WORKER_MEETING_LEAD_SOURCE,
                scheduled_at: nextScheduledAt,
                note: ''
            })
            setNewMeetingPickerMonth(toLocalDate(getScheduledDatePart(nextScheduledAt)))
            await loadMeetings()
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Nieznany błąd.'
            toast.error(msg)
        } finally {
            setAddLoading(false)
        }
    }

    const scheduledCount = openMeetings.length

    useEffect(() => {
        if (!showAddModal) return

        const nextScheduledAt =
            !newMeeting.scheduled_at || Number.isNaN(new Date(newMeeting.scheduled_at).getTime()) || isSlotUnavailableForMeeting(newMeetingDatePart, newMeetingTimePart)
                ? getNextAvailableScheduledAt(newMeetingDatePart) ?? toDateTimeLocalInput()
                : newMeeting.scheduled_at

        if (nextScheduledAt !== newMeeting.scheduled_at) {
            setNewMeeting((prev) => ({ ...prev, scheduled_at: nextScheduledAt }))
        }

        setNewMeetingPickerMonth(toLocalDate(getScheduledDatePart(nextScheduledAt)))
    }, [
        getNextAvailableScheduledAt,
        isSlotUnavailableForMeeting,
        newMeeting.scheduled_at,
        newMeetingDatePart,
        newMeetingTimePart,
        showAddModal
    ])

    useEffect(() => {
        if (!showAddModal && !rescheduleMeeting && !statusPickerMeeting && !statusDetailsMeeting) return

        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'

        return () => {
            document.body.style.overflow = previousOverflow
        }
    }, [rescheduleMeeting, showAddModal, statusDetailsMeeting, statusPickerMeeting])

    useEffect(() => {
        if (activeShift) return
        setStatusEditorId(null)
        setStatusPickerMeeting(null)
        setStatusDetailsMeeting(null)
        setRescheduleMeeting(null)
        setRescheduleMode('meeting')
    }, [activeShift])

    const statusDetailsDraft =
        statusDetailsMeeting?.id
            ? drafts[statusDetailsMeeting.id] || buildDraftState(statusDetailsMeeting)
            : null
    const selectedStatusDetails =
        statusDetailsDraft && WORKER_QUICK_STATUS_OPTIONS.some((option) => option.key === statusDetailsDraft.status)
            ? (statusDetailsDraft.status as WorkerQuickStatus)
            : null
    const statusDetailsSelectedAt =
        selectedStatusDetails === 'follow_up' && statusDetailsDraft
            ? new Date(statusDetailsDraft.scheduledAt)
            : null
    const statusDetailsSelectedLabel =
        statusDetailsSelectedAt && !Number.isNaN(statusDetailsSelectedAt.getTime())
            ? statusDetailsSelectedAt.toLocaleString('pl-PL', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            })
            : 'Nie ustawiono terminu'

    return (
        <>
        <div className={`${card} overflow-hidden`}>
            {/* Header */}
            <div className="px-5 pt-5 pb-4 flex items-center justify-between border-b border-gray-100 dark:border-slate-700/60">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-linear-to-br from-violet-500 to-indigo-600 text-white rounded-xl flex items-center justify-center text-base shadow-md shadow-violet-500/25">
                        📅
                    </div>
                    <div>
                        <h3 className="text-sm font-black text-gray-800 dark:text-white uppercase tracking-widest leading-none">
                            {informationalOnly ? 'Lista Spotkań' : 'Tablica Spotkań'}
                        </h3>
                        <p className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mt-0.5">
                            {scheduledCount} w grafiku
                        </p>
                    </div>
                </div>
                {allowManualAdd && (
                    <button
                        onClick={() => setShowAddModal(true)}
                        className={`${primaryButtonClass} flex items-center gap-2 px-4 py-2.5 text-[11px] shadow-md shadow-violet-600/25 transition-all active:scale-95`}
                    >
                        <span className="text-base leading-none">+</span> Dodaj
                    </button>
                )}
            </div>

            {!activeShift && !informationalOnly && (
                <div className="mx-4 mt-3 px-4 py-3 rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700/30 text-amber-700 dark:text-amber-400 text-[11px] font-bold uppercase tracking-wide">
                    ⚠️ Aby zmieniać statusy spotkań, najpierw rozpocznij pracę.
                </div>
            )}

            <div className="p-4">
                {loading ? (
                    <div className="flex items-center justify-center py-10 gap-3">
                        <div className="w-5 h-5 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
                        <span className="text-xs text-gray-400 font-bold uppercase tracking-wider">Ładowanie...</span>
                    </div>
                ) : (
                    <div className="space-y-5 max-h-[60vh] overflow-y-auto pr-1">
                        {groupedMeetings.map(([day, dayMeetings]) => (
                            <div key={day}>
                                {/* Day header */}
                                <div className="flex items-center gap-3 mb-3">
                                    <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">{day}</span>
                                    <div className="flex-1 h-px bg-gray-100 dark:bg-slate-700" />
                                    <span className="text-[10px] font-black text-violet-500">{dayMeetings.length}</span>
                                </div>

                                <div className="space-y-2">
                                    {dayMeetings.map((meeting) => {
                                        if (!meeting.id) return null
                                        const statusMeta = getSalesMeetingDisplayMeta(meeting)
                                        const startAvailability = getStartAvailability?.(meeting) ?? {
                                            allowed: Boolean(activeShift),
                                            reason: activeShift ? null : 'Najpierw rozpocznij pracę.'
                                        }
                                        const isNextMeeting = false
                                        const draft = drafts[meeting.id] || buildDraftState(meeting)
                                        const meetingPhoneHref = buildPhoneHref(meeting.phone)
                                        const enhancedAddress = getSalesMeetingEnhancedAddress(meeting)
                                        const formattedMeetingAddress = enhancedAddress.main
                                        const meetingDirectionsHref = buildGoogleMapsDirectionsHref(meeting.address)
                                        const selectedQuickStatus = WORKER_QUICK_STATUS_OPTIONS.some((option) => option.key === draft.status)
                                            ? (draft.status as WorkerQuickStatus)
                                            : null
                                        const isStatusEditorOpen = statusEditorId === meeting.id
                                        const selectedFollowUpDate = selectedQuickStatus === 'follow_up' ? new Date(draft.scheduledAt) : null
                                        const followUpDraftLabel =
                                            selectedFollowUpDate && !Number.isNaN(selectedFollowUpDate.getTime())
                                                ? selectedFollowUpDate.toLocaleString('pl-PL', {
                                                    day: '2-digit',
                                                    month: '2-digit',
                                                    year: 'numeric',
                                                    hour: '2-digit',
                                                    minute: '2-digit'
                                                })
                                                : 'Nie ustawiono terminu'
                                        const assignmentBadges = getSalesMeetingAssignmentBadges(meeting)
                                        const assignmentMetaRows = getSalesMeetingAssignmentMetaRows(meeting)
                                        const isExpanded = expandedId === meeting.id
                                        const isMeetingToday = getScheduledDatePart(meeting.scheduled_at) === getTodayDateInput()
                                        const borderColor = statusMeta.isMissed
                                            ? STATUS_BORDER.missed
                                            : STATUS_BORDER[meeting.status] || 'border-l-slate-300'
                                        const showExpandedPanel = !informationalOnly && isExpanded
                                        const handleCardClick = () => {
                                            if (informationalOnly) return

                                            setExpandedId(isExpanded ? null : meeting.id!)
                                        }

                                        return (
                                            <div
                                                key={meeting.id}
                                                className={`rounded-2xl border border-gray-100 dark:border-slate-700/60 bg-white dark:bg-slate-800/50 border-l-4 ${borderColor} shadow-sm overflow-hidden transition-all`}
                                            >
                                                {/* Card header — always visible */}
                                                <button
                                                    type="button"
                                                    className="w-full px-3.5 py-3 sm:px-4 flex items-start justify-between gap-3 text-left hover:bg-gray-50 dark:hover:bg-slate-700/30 transition-colors"
                                                    onClick={handleCardClick}
                                                >
                                                    <div className="flex items-start gap-3 flex-1 min-w-0">
                                                        <div className="flex flex-col items-center pt-0.5 shrink-0 w-14">
                                                            <p className="text-base sm:text-sm font-black text-violet-600 dark:text-violet-400 leading-none">
                                                                {toTimeLabel(meeting.scheduled_at)}
                                                            </p>
                                                        </div>
                                                        <div className="min-w-0 flex-1 space-y-1">
                                                            <div className="flex items-center gap-2 min-w-0">
                                                                <p className="text-base sm:text-sm font-black dark:text-white truncate">{meeting.client_name}</p>
                                                                {isNextMeeting && (
                                                                    <span className="shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-violet-600 dark:bg-violet-500/20 dark:text-violet-300">
                                                                        Następne
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <p className="text-[12px] sm:text-[11px] text-gray-500 dark:text-gray-400 leading-snug">
                                                                📍 {formattedMeetingAddress}
                                                            </p>
                                                            {showExpandedPanel && meeting.phone && <p className="text-[11px] text-gray-400 truncate">📞 {meeting.phone}</p>}
                                                            {assignmentBadges.length > 0 && (
                                                                <div className="flex flex-wrap gap-1.5 pt-0.5">
                                                                    {assignmentBadges.map((badge) => (
                                                                        <span
                                                                            key={`${meeting.id || meeting.import_key}-assignment-${badge}`}
                                                                            className="rounded-lg border border-amber-300/70 bg-amber-50 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-amber-700 dark:border-amber-400/25 dark:bg-amber-500/10 dark:text-amber-200"
                                                                        >
                                                                            {badge}
                                                                        </span>
                                                                    ))}
                                                                </div>
                                                            )}
                                                            {showExpandedPanel && meeting.lead_source && (
                                                                <p className="text-[11px] text-gray-400 truncate">
                                                                    Źródło: {normalizeSalesMeetingInlineText(meeting.lead_source)}
                                                                </p>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <div className="flex flex-col items-end gap-1.5 shrink-0 pl-2">
                                                        <span className={`text-[10px] font-black uppercase px-2.5 py-1 rounded-full whitespace-nowrap ${statusMeta.badgeClass}`}>
                                                            {statusMeta.label}
                                                        </span>
                                                        <span className="text-[9px] text-gray-400 font-bold uppercase tracking-wider">
                                                            {informationalOnly ? 'Lista dnia' : isExpanded ? 'Ukryj' : 'Szczegóły'}
                                                        </span>
                                                    </div>
                                                </button>

                                                {/* Expandable status panel */}
                                                {showExpandedPanel && (
                                                    <div className="px-4 pb-4 pt-2 border-t border-gray-100 dark:border-slate-700/50 bg-gray-50/50 dark:bg-slate-800/30 space-y-3">
                                                        <div className="rounded-xl border border-gray-100 bg-white/80 px-3 py-3 dark:border-slate-700 dark:bg-slate-900/40">
                                                            <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Adres spotkania</p>
                                                            {meetingDirectionsHref ? (
                                                                <a
                                                                    href={meetingDirectionsHref}
                                                                    target="_blank"
                                                                    rel="noreferrer"
                                                                    className="mt-1 block text-[13px] font-semibold leading-snug text-cyan-700 underline decoration-cyan-300 underline-offset-2 dark:text-cyan-300"
                                                                >
                                                                    {formattedMeetingAddress}
                                                                </a>
                                                            ) : (
                                                                <p className="mt-1 text-[13px] font-semibold leading-snug text-gray-700 dark:text-slate-100">
                                                                    {formattedMeetingAddress}
                                                                </p>
                                                            )}
                                                            {enhancedAddress.suggestion && (
                                                                <div className="mt-2 rounded-lg border border-indigo-100 bg-indigo-50/50 px-2.5 py-2 dark:border-indigo-500/20 dark:bg-indigo-500/10">
                                                                    <p className="text-[9px] font-black uppercase tracking-widest text-indigo-500 mb-0.5">Sugerowana nawigacja</p>
                                                                    <p className="text-[11px] font-medium text-indigo-700 dark:text-indigo-300 leading-snug">
                                                                        {enhancedAddress.suggestion}
                                                                    </p>
                                                                </div>
                                                            )}
                                                        </div>
                                                        {meetingPhoneHref && (
                                                            <div className="rounded-xl border border-gray-100 bg-white/80 px-3 py-3 dark:border-slate-700 dark:bg-slate-900/40">
                                                                <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Telefon</p>
                                                                <a
                                                                    href={meetingPhoneHref}
                                                                    className="mt-1 block text-[13px] font-semibold leading-snug text-cyan-700 underline decoration-cyan-300 underline-offset-2 dark:text-cyan-300"
                                                                >
                                                                    {meeting.phone}
                                                                </a>
                                                            </div>
                                                        )}
                                                        {meeting.lead_source && (
                                                            <p className="text-[11px] text-gray-500 dark:text-gray-400">
                                                                Źródło pozyskania leada: {normalizeSalesMeetingInlineText(meeting.lead_source)}
                                                            </p>
                                                        )}
                                                        {meeting.note && (
                                                            <p className="text-[11px] text-gray-500 dark:text-gray-400 italic">Komentarz: {normalizeSalesMeetingInlineText(meeting.note)}</p>
                                                        )}
                                                        {assignmentMetaRows.length > 0 && (
                                                            <div className="rounded-xl border border-gray-100 bg-white/80 px-3 py-3 dark:border-slate-700 dark:bg-slate-900/40">
                                                                <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Dane z dzialek</p>
                                                                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                                                                    {assignmentMetaRows.map((row) => (
                                                                        <div key={row.label} className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 dark:border-slate-700 dark:bg-slate-800/60">
                                                                            <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">{row.label}</p>
                                                                            <p className="mt-1 text-[12px] font-black leading-snug text-slate-700 dark:text-slate-100">{row.value}</p>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        )}
                                                        {onStartMeeting && isMeetingToday && (
                                                            <div className="flex flex-col gap-2">
                                                                <button
                                                                    type="button"
                                                                    onClick={() => onStartMeeting?.(meeting)}
                                                                    disabled={!startAvailability.allowed}
                                                                    title={startAvailability.reason || undefined}
                                                                    className={`${primaryButtonClass} h-10 px-4 text-[10px] transition-all disabled:opacity-40`}
                                                                >
                                                                    Rozpocznij spotkanie
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => openRescheduleModal(meeting)}
                                                                    disabled={meetingActionsLocked}
                                                                    title={meetingActionsLockReason}
                                                                    className={`${secondaryButtonClass} h-10 px-4 text-[10px] transition-all disabled:cursor-not-allowed disabled:opacity-40`}
                                                                >
                                                                    Przełóż termin
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => openStatusPicker(meeting)}
                                                                    disabled={meetingActionsLocked}
                                                                    title={meetingActionsLockReason}
                                                                    className={`${secondaryButtonClass} h-10 px-4 text-[10px] transition-all disabled:cursor-not-allowed disabled:opacity-40`}
                                                                >
                                                                    Ustaw status
                                                                </button>
                                                                {isStatusEditorOpen && (
                                                                    <div className="rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3.5 space-y-3">
                                                                        <div className="grid gap-2 sm:grid-cols-2">
                                                                            {WORKER_QUICK_STATUS_OPTIONS.map((status) => {
                                                                                const isSelected = selectedQuickStatus === status.key
                                                                                return (
                                                                                    <button
                                                                                        key={status.key}
                                                                                        type="button"
                                                                                        onClick={() => updateDraft(meeting.id!, { status: status.key })}
                                                                                        className={`rounded-xl border px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.14em] transition-all ${
                                                                                            isSelected
                                                                                                ? 'border-violet-400/55 bg-violet-600 text-white shadow-lg shadow-violet-600/20'
                                                                                                : 'border-slate-600/70 bg-slate-900/50 text-slate-200 hover:border-violet-400/40 hover:text-violet-100'
                                                                                        }`}
                                                                                    >
                                                                                        {status.label}
                                                                                    </button>
                                                                                )
                                                                            })}
                                                                        </div>
                                                                        {selectedQuickStatus === 'follow_up' && (
                                                                            <div className="rounded-xl border border-cyan-400/20 bg-cyan-500/8 p-3">
                                                                                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-cyan-400">
                                                                                    Formularz nowo ustalonego kontaktu ponownego
                                                                                </p>
                                                                                <p className="mt-1 text-sm font-black text-white">{followUpDraftLabel}</p>
                                                                                <button
                                                                                    type="button"
                                                                                    onClick={() => openRescheduleModal(meeting, 'follow_up')}
                                                                                    disabled={meetingActionsLocked}
                                                                                    title={meetingActionsLockReason}
                                                                                    className={`${secondaryButtonClass} mt-3 h-10 px-4 text-[10px] transition-all disabled:cursor-not-allowed disabled:opacity-40`}
                                                                                >
                                                                                    Wybierz termin kontaktu
                                                                                </button>
                                                                            </div>
                                                                        )}
                                                                        {selectedQuickStatus && (
                                                                            <div className="space-y-2">
                                                                                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
                                                                                    {selectedQuickStatus === 'follow_up'
                                                                                        ? 'Notatka do nowo ustalonego kontaktu ponownego'
                                                                                        : 'Notatka (opcjonalnie)'}
                                                                                </p>
                                                                                <textarea
                                                                                    value={draft.note}
                                                                                    onChange={(e) => updateDraft(meeting.id!, { note: e.target.value })}
                                                                                    placeholder={
                                                                                        selectedQuickStatus === 'follow_up'
                                                                                            ? 'Opisz ustalenia i nowy kontakt ponowny'
                                                                                            : selectedQuickStatus === 'no_cooperation'
                                                                                                ? 'Opisz powod braku wspolpracy'
                                                                                            : 'Krótka notatka, jeśli chcesz ją dodać'
                                                                                    }
                                                                                    className={`${input} min-h-[96px] resize-y`}
                                                                                />
                                                                            </div>
                                                                        )}
                                                                        <div className="flex flex-col gap-2 sm:flex-row">
                                                                            <button
                                                                                type="button"
                                                                                disabled={!activeShift || savingId === meeting.id || !selectedQuickStatus}
                                                                                onClick={() => void saveMeetingStatus(meeting)}
                                                                                className={`${primaryButtonClass} h-10 flex-1 px-4 text-[10px] disabled:opacity-40 transition-all`}
                                                                            >
                                                                                {savingId === meeting.id ? 'Zapisywanie...' : 'Zapisz status'}
                                                                            </button>
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => {
                                                                                    setDrafts((prev) => ({
                                                                                        ...prev,
                                                                                        [meeting.id!]: buildDraftState(meeting)
                                                                                    }))
                                                                                    setStatusEditorId(null)
                                                                                }}
                                                                                className={`${secondaryButtonClass} h-10 flex-1 px-4 text-[10px] transition-all`}
                                                                            >
                                                                                Anuluj
                                                                            </button>
                                                                        </div>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        )}
                                                        {!onStartMeeting && (
                                                            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                                                                <div className="grid flex-1 grid-cols-1 sm:grid-cols-[1fr_1.5fr_auto] gap-2">
                                                                    <select
                                                                        value={draft.status}
                                                                        onChange={(e) => updateDraft(meeting.id!, { status: e.target.value as WorkerSettableMeetingStatus })}
                                                                        className={input}
                                                                    >
                                                                        {WORKER_SETTABLE_STATUS_OPTIONS.map((status) => (
                                                                            <option key={status.key} value={status.key}>{status.label}</option>
                                                                        ))}
                                                                    </select>
                                                                    <input
                                                                        type="text"
                                                                        placeholder={draft.status === 'missed' ? 'Powód nieodbycia (opcjonalnie)' : 'Notatka (opcjonalnie)'}
                                                                        value={draft.note}
                                                                        onChange={(e) => updateDraft(meeting.id!, { note: e.target.value })}
                                                                        className={input}
                                                                    />
                                                                    <button
                                                                        type="button"
                                                                        disabled={!activeShift || savingId === meeting.id}
                                                                        onClick={() => void saveMeetingStatus(meeting)}
                                                                        className={`${primaryButtonClass} h-10 px-5 text-[10px] disabled:opacity-40 shadow-md shadow-violet-600/20 transition-all active:scale-95`}
                                                                    >
                                                                        {savingId === meeting.id ? '...' : 'Zapisz'}
                                                                    </button>
                                                                </div>
                                                                {onFocusMeeting && (meeting.status === 'planned' || meeting.status === 'follow_up') && (
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => onFocusMeeting(meeting)}
                                                                        className={`${secondaryButtonClass} h-10 px-4 text-[10px] sm:min-w-[118px] transition-all`}
                                                                    >
                                                                        Pokaż na mapie
                                                                        </button>
                                                                    )}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        )
                                    })}
                                </div>
                            </div>
                        ))}
                        {openMeetings.length === 0 && (
                            <div className="text-center py-12 border-2 border-dashed border-gray-100 dark:border-slate-700 rounded-2xl">
                                <p className="text-3xl mb-3">📅</p>
                                <p className="text-[11px] font-black text-gray-300 dark:text-gray-600 uppercase tracking-widest">Brak aktywnych spotkań</p>
                                {allowManualAdd && (
                                    <button
                                        onClick={() => setShowAddModal(true)}
                                        className="mt-4 text-[11px] font-black text-violet-500 hover:text-violet-600 uppercase tracking-widest underline"
                                    >
                                        + Dodaj pierwsze spotkanie
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>

        {statusPickerMeeting && (
            <div className="fixed inset-0 z-500 flex items-center justify-center p-4">
                <button
                    type="button"
                    onClick={closeStatusPicker}
                    className="ui-modal-backdrop absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
                    aria-label="Zamknij wybór statusu spotkania"
                />
                <div
                    className="ui-modal-panel relative w-full max-w-lg max-h-[90vh] overflow-y-auto overscroll-contain rounded-3xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-900"
                    style={{ WebkitOverflowScrolling: 'touch' }}
                >
                    <div className="mb-4 flex items-start gap-3">
                        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-500/12 text-lg font-black text-violet-600 shadow-sm shadow-violet-500/10 dark:bg-violet-500/18 dark:text-violet-200">
                            !
                        </div>
                        <div className="min-w-0 flex-1">
                            <h3 className="text-sm font-black uppercase tracking-widest text-slate-800 dark:text-white">
                                Ustaw status spotkania
                            </h3>
                            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                                {statusPickerMeeting.client_name} · {getSalesMeetingPrimaryLocationLabel(statusPickerMeeting)}
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={closeStatusPicker}
                            className="ui-pressable ml-auto flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-gray-500 transition-all hover:bg-gray-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                        >
                            x
                        </button>
                    </div>

                    <div className="space-y-2.5">
                        {WORKER_QUICK_STATUS_OPTIONS.map((status) => (
                            <button
                                key={status.key}
                                type="button"
                                onClick={() => openStatusDetails(statusPickerMeeting, status.key)}
                                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3.5 text-left text-[11px] font-black uppercase tracking-[0.16em] text-slate-800 transition-all hover:border-violet-300 hover:text-violet-600 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-100 dark:hover:border-violet-400 dark:hover:text-violet-200"
                            >
                                {status.label}
                            </button>
                        ))}
                    </div>

                    <div className="mt-5 flex gap-3">
                        <button
                            type="button"
                            onClick={closeStatusPicker}
                            className={`${secondaryButtonClass} flex-1 h-11 text-xs transition-all`}
                        >
                            Zamknij
                        </button>
                    </div>
                </div>
            </div>
        )}
        {statusDetailsMeeting && selectedStatusDetails && statusDetailsDraft && (
            <div className="fixed inset-0 z-500 flex items-center justify-center p-4">
                <button
                    type="button"
                    onClick={() => closeStatusDetails()}
                    className="ui-modal-backdrop absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
                    aria-label="Zamknij formularz statusu spotkania"
                />
                <div
                    className="ui-modal-panel relative w-full max-w-2xl max-h-[90vh] overflow-y-auto overscroll-contain rounded-3xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-900"
                    style={{ WebkitOverflowScrolling: 'touch' }}
                >
                    <div className="mb-4 flex items-start gap-3">
                        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-500/12 text-lg font-black text-violet-600 shadow-sm shadow-violet-500/10 dark:bg-violet-500/18 dark:text-violet-200">
                            17
                        </div>
                        <div className="min-w-0 flex-1">
                            <h3 className="text-sm font-black uppercase tracking-widest text-slate-800 dark:text-white">
                                {getWorkerQuickStatusTitle(selectedStatusDetails)}
                            </h3>
                            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                                {statusDetailsMeeting.client_name} · {statusDetailsMeeting.address}
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => closeStatusDetails()}
                            className="ui-pressable ml-auto flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-gray-500 transition-all hover:bg-gray-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                        >
                            x
                        </button>
                    </div>

                    <div className="space-y-4">
                        {selectedStatusDetails === 'follow_up' && (
                            <div className="rounded-2xl border border-slate-200/80 bg-slate-50/85 p-3 shadow-inner dark:border-slate-700 dark:bg-slate-950/45">
                                <div className="mb-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_116px]">
                                    <div className="rounded-xl border border-cyan-400/15 bg-white/90 px-3 py-2.5 shadow-sm dark:border-cyan-400/10 dark:bg-slate-800/90">
                                        <p className="text-[10px] font-black uppercase tracking-[0.22em] text-cyan-500">
                                            Wybrany termin kontaktu
                                        </p>
                                        <p className="mt-1 text-sm font-black text-slate-900 dark:text-white">{statusDetailsSelectedLabel}</p>
                                    </div>
                                    <div className="rounded-xl border border-violet-300/25 bg-violet-500/10 px-3 py-2 text-center dark:border-violet-400/20">
                                        <p className="text-[9px] font-black uppercase tracking-[0.22em] text-violet-500">Godzina</p>
                                        <p className="mt-1 text-base font-black text-violet-700 dark:text-violet-200">{statusDetailsTime}</p>
                                    </div>
                                </div>

                                <div className="grid gap-2.5 lg:grid-cols-[minmax(0,1fr)_174px]">
                                    <div className="meeting-date-picker date-range-picker rounded-2xl border border-slate-200/80 bg-white/85 p-2 shadow-sm dark:border-slate-700 dark:bg-slate-900/65">
                                        <DayPicker
                                            animate
                                            locale={pl}
                                            mode="single"
                                            month={statusDetailsPickerMonth}
                                            navLayout="around"
                                            selected={statusDetailsDateValue}
                                            showOutsideDays
                                            disabled={{ before: toLocalDate(getTodayDateInput()) }}
                                            onMonthChange={setStatusDetailsPickerMonth}
                                            onSelect={handleStatusDetailsDateChange}
                                        />
                                    </div>

                                    <div className="rounded-2xl border border-slate-200/80 bg-white/85 p-2.5 shadow-sm dark:border-slate-700 dark:bg-slate-900/65">
                                        <div className="mb-2 flex items-center justify-between">
                                            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-400">
                                                Godzina kontaktu
                                            </p>
                                            <span className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-cyan-500">
                                                30 min
                                            </span>
                                        </div>
                                        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 lg:grid-cols-3">
                                            {statusDetailsTimeOptions.map((slot) => {
                                                const isSelected = statusDetailsTime === slot
                                                const isUnavailable = unavailableStatusDetailsSlots.has(slot)

                                                return (
                                                    <button
                                                        key={slot}
                                                        type="button"
                                                        disabled={isUnavailable}
                                                        onClick={() => handleStatusDetailsTimeChange(slot)}
                                                        className={`rounded-lg border px-1.5 py-2 text-[13px] font-black leading-none transition-all ${
                                                            isUnavailable
                                                                ? 'cursor-not-allowed border-slate-200/70 bg-slate-100 text-slate-400 opacity-45 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-500'
                                                                : isSelected
                                                                    ? 'border-violet-500 bg-violet-600 text-white shadow-lg shadow-violet-600/20'
                                                                    : 'border-slate-200 bg-white text-slate-700 hover:border-violet-300 hover:text-violet-600 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-200 dark:hover:border-violet-400 dark:hover:text-violet-200'
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

                        <div className="space-y-2">
                            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
                                {getWorkerQuickStatusNoteLabel(selectedStatusDetails)}
                                {workerStatusRequiresNote(selectedStatusDetails) ? ' *' : ''}
                            </p>
                            <textarea
                                value={statusDetailsDraft.note}
                                onChange={(e) => updateDraft(statusDetailsMeeting.id!, { note: e.target.value })}
                                placeholder={getWorkerQuickStatusPlaceholder(selectedStatusDetails)}
                                className={`${input} min-h-[120px] resize-y`}
                            />
                        </div>
                    </div>

                    <div className="mt-5 flex gap-3">
                        <button
                            type="button"
                            onClick={() => closeStatusDetails()}
                            disabled={savingId === statusDetailsMeeting.id}
                            className={`${secondaryButtonClass} flex-1 h-11 text-xs transition-all disabled:opacity-50`}
                        >
                            Anuluj
                        </button>
                        <button
                            type="button"
                            onClick={() => void saveMeetingStatus(statusDetailsMeeting)}
                            disabled={
                                !activeShift ||
                                savingId === statusDetailsMeeting.id ||
                                (workerStatusRequiresNote(selectedStatusDetails) && !statusDetailsDraft.note.trim())
                            }
                            className={`${primaryButtonClass} flex-1 h-11 text-xs transition-all disabled:opacity-50`}
                        >
                            {savingId === statusDetailsMeeting.id ? 'Zapisywanie...' : 'Zapisz status'}
                        </button>
                    </div>
                </div>
            </div>
        )}

        {/* Add Meeting Modal */}
        {allowManualAdd && showAddModal && (
            <div className="fixed inset-0 z-500 flex items-end sm:items-center justify-center p-4">
                <button
                    type="button"
                    onClick={() => setShowAddModal(false)}
                    className="ui-modal-backdrop absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
                    aria-label="Zamknij"
                />
                <div
                    className="ui-modal-panel relative w-full max-w-md max-h-[90vh] overflow-y-auto overscroll-contain bg-white dark:bg-slate-900 rounded-3xl border border-gray-200 dark:border-slate-700 p-6 shadow-2xl"
                    style={{ WebkitOverflowScrolling: 'touch' }}
                >
                    {/* Modal header */}
                    <div className="flex items-center gap-3 mb-5">
                        <div className="w-10 h-10 bg-linear-to-br from-violet-500 to-indigo-600 text-white rounded-xl flex items-center justify-center text-lg shadow-md shadow-violet-500/25">
                            ➕
                        </div>
                        <div>
                            <h3 className="text-sm font-black uppercase tracking-widest text-slate-800 dark:text-white leading-none">Nowe Spotkanie</h3>
                            <p className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mt-0.5">Dodaj ręcznie do tablicy</p>
                        </div>
                        <button
                            type="button"
                            onClick={() => setShowAddModal(false)}
                            className="ui-pressable ml-auto w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 dark:bg-slate-800 text-gray-500 hover:bg-gray-200 dark:hover:bg-slate-700 transition-all"
                        >
                            ✕
                        </button>
                    </div>

                    <div className="space-y-3">
                        <div>
                            <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1.5 block">Handlowiec</label>
                            <div className="rounded-2xl border border-slate-200/80 bg-slate-50 px-4 py-3 text-sm font-black text-slate-800 shadow-sm dark:border-slate-700 dark:bg-slate-800/80 dark:text-white">
                                {user.name}
                            </div>
                        </div>
                        {/* Źródło pozyskania i Handlowiec (handlowiec jest domyślny, więc ukryty z widoku ew. pokazany readonly jeśli byłaby potrzeba - na razie ignorujemy) */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                                <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1.5 block">Źródło pozyskania leada *</label>
                                <SelectInput
                                    value={newMeeting.lead_source}
                                    onChange={(value) => setNewMeeting(p => ({ ...p, lead_source: value }))}
                                    options={SALES_MEETING_LEAD_SOURCE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                                    className={input}
                                />
                            </div>
                            <div>
                                <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1.5 block">Imię i nazwisko / Firma *</label>
                                <input
                                    type="text"
                                    placeholder="Jan Kowalski"
                                    value={newMeeting.client_name}
                                    onChange={(e) => setNewMeeting(p => ({ ...p, client_name: e.target.value }))}
                                    className={input}
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                                <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1.5 block">Telefon *</label>
                                <input
                                    type="tel"
                                    placeholder="500 000 000"
                                    value={newMeeting.phone}
                                    onChange={(e) => setNewMeeting(p => ({ ...p, phone: e.target.value }))}
                                    className={input}
                                />
                            </div>
                            <div>
                                <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1.5 block">Data i godzina *</label>
                                <div className="rounded-2xl border border-violet-300/25 bg-violet-500/10 px-3 py-3 text-center dark:border-violet-400/20">
                                    <p className="text-[9px] font-black uppercase tracking-[0.22em] text-violet-500">Wybrany termin</p>
                                    <p className="mt-1 text-sm font-black text-slate-900 dark:text-white">
                                        {format(newMeetingDateValue, 'dd MMMM yyyy', { locale: pl })}
                                    </p>
                                    <p className="mt-1 text-base font-black text-violet-700 dark:text-violet-200">{newMeetingTimePart}</p>
                                </div>
                            </div>
                        </div>

                        <div className="rounded-2xl border border-slate-200/80 bg-slate-50/85 p-3 shadow-inner dark:border-slate-700 dark:bg-slate-950/45">
                            <div className="grid gap-2.5 lg:grid-cols-[minmax(0,1fr)_174px]">
                                <div className="meeting-date-picker date-range-picker rounded-2xl border border-slate-200/80 bg-white/85 p-2 shadow-sm dark:border-slate-700 dark:bg-slate-900/65">
                                    <DayPicker
                                        animate
                                        locale={pl}
                                        mode="single"
                                        month={newMeetingPickerMonth}
                                        navLayout="around"
                                        selected={newMeetingDateValue}
                                        showOutsideDays
                                        disabled={{ before: toLocalDate(getTodayDateInput()) }}
                                        onMonthChange={setNewMeetingPickerMonth}
                                        onSelect={handleNewMeetingDateChange}
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
                                        {newMeetingTimeOptions.map((slot) => {
                                            const isSelected = newMeetingTimePart === slot
                                            const isUnavailable = unavailableNewMeetingSlots.has(slot)

                                            return (
                                                <button
                                                    key={slot}
                                                    type="button"
                                                    disabled={isUnavailable}
                                                    onClick={() => handleNewMeetingTimeChange(slot)}
                                                    className={`rounded-lg border px-1.5 py-2 text-[13px] font-black leading-none transition-all ${
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

                        {/* Adres i Województwo */}
                        <div className="grid grid-cols-1 gap-3">
                            <div>
                                <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1.5 block">Adres *</label>
                                <input
                                    type="text"
                                    placeholder="ul. Przykładowa 1, Miasto"
                                    value={newMeeting.address}
                                    onChange={(e) => setNewMeeting(p => ({ ...p, address: e.target.value }))}
                                    className={input}
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                                <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1.5 block">Województwo *</label>
                                <SelectInput
                                    value={newMeeting.region}
                                    onChange={(value) => setNewMeeting(p => ({ ...p, region: value }))}
                                    options={[
                                        { value: '', label: 'Wybierz województwo...' },
                                        ...VOIVODESHIPS.map((v) => ({ value: v, label: v }))
                                    ]}
                                    className={input}
                                />
                            </div>
                            <div>
                                <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1.5 block">Notatka</label>
                                <input
                                    type="text"
                                    placeholder="Dodatkowe informacje..."
                                    value={newMeeting.note}
                                    onChange={(e) => setNewMeeting(p => ({ ...p, note: e.target.value }))}
                                    className={input}
                                />
                            </div>
                        </div>
                    </div>

                    <div className="flex gap-3 mt-5">
                        <button
                            type="button"
                            onClick={() => setShowAddModal(false)}
                            className={`${secondaryButtonClass} flex-1 h-12 text-xs transition-all`}
                        >
                            Anuluj
                        </button>
                        <button
                            type="button"
                            disabled={addLoading || !isNewMeetingFormValid}
                            onClick={() => void handleAddMeeting()}
                            className={`${primaryButtonClass} flex-1 h-12 text-xs bg-linear-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-50`}
                        >
                            {addLoading ? 'Zapisywanie...' : '✓ Dodaj spotkanie'}
                        </button>
                    </div>
                </div>
            </div>
        )}
        {rescheduleMeeting && (
            <div className="fixed inset-0 z-500 flex items-end sm:items-center justify-center p-4">
                <button
                    type="button"
                    onClick={closeRescheduleModal}
                    className="ui-modal-backdrop absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
                    aria-label={rescheduleMode === 'follow_up' ? 'Zamknij wybór terminu ponownego kontaktu' : 'Zamknij przełożenie terminu'}
                />
                <div
                    className="ui-modal-panel relative w-full max-w-2xl max-h-[90vh] overflow-y-auto overscroll-contain rounded-3xl border border-gray-200 bg-white p-4 shadow-2xl dark:border-slate-700 dark:bg-slate-900 sm:p-5"
                    style={{ WebkitOverflowScrolling: 'touch' }}
                >
                    <div className="mb-4 flex items-start gap-3">
                        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-500/12 text-lg text-violet-600 shadow-sm shadow-violet-500/10 dark:bg-violet-500/18 dark:text-violet-200">
                            17
                        </div>
                        <div className="min-w-0 flex-1">
                            <h3 className="text-sm font-black uppercase tracking-widest text-slate-800 dark:text-white">
                                {rescheduleMode === 'follow_up' ? 'Ustaw termin ponownego kontaktu' : 'Przełóż termin spotkania'}
                            </h3>
                            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                                {rescheduleMeeting.client_name} · {getSalesMeetingPrimaryLocationLabel(rescheduleMeeting)}
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={closeRescheduleModal}
                            className="ui-pressable ml-auto flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-gray-500 transition-all hover:bg-gray-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                        >
                            x
                        </button>
                    </div>

                    <div className="rounded-2xl border border-slate-200/80 bg-slate-50/85 p-3 shadow-inner dark:border-slate-700 dark:bg-slate-950/45">
                        <div className="mb-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_116px]">
                            <div className="rounded-xl border border-cyan-400/15 bg-white/90 px-3 py-2.5 shadow-sm dark:border-cyan-400/10 dark:bg-slate-800/90">
                                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-cyan-500">
                                    {rescheduleMode === 'follow_up' ? 'Wybrany termin kontaktu' : 'Wybrany termin'}
                                </p>
                                <p className="mt-1 text-sm font-black text-slate-900 dark:text-white">
                                    {format(rescheduleDateValue, 'dd MMMM yyyy', { locale: pl })}
                                </p>
                            </div>
                            <div className="rounded-xl border border-violet-300/25 bg-violet-500/10 px-3 py-2 text-center dark:border-violet-400/20">
                                <p className="text-[9px] font-black uppercase tracking-[0.22em] text-violet-500">
                                    {rescheduleMode === 'follow_up' ? 'Godzina kontaktu' : 'Godzina'}
                                </p>
                                <p className="mt-1 text-base font-black text-violet-700 dark:text-violet-200">{rescheduleTime}</p>
                            </div>
                        </div>

                        <div className="grid gap-2.5 lg:grid-cols-[minmax(0,1fr)_174px]">
                            <div className="meeting-date-picker date-range-picker rounded-2xl border border-slate-200/80 bg-white/85 p-2 shadow-sm dark:border-slate-700 dark:bg-slate-900/65">
                                <DayPicker
                                    animate
                                    locale={pl}
                                    mode="single"
                                    month={reschedulePickerMonth}
                                    navLayout="around"
                                    selected={rescheduleDateValue}
                                    showOutsideDays
                                    disabled={{ before: toLocalDate(getTodayDateInput()) }}
                                    onMonthChange={setReschedulePickerMonth}
                                    onSelect={handleRescheduleDateChange}
                                />
                            </div>

                            <div className="rounded-2xl border border-slate-200/80 bg-white/85 p-2.5 shadow-sm dark:border-slate-700 dark:bg-slate-900/65">
                                <div className="mb-2 flex items-center justify-between">
                                    <p className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-400">
                                        {rescheduleMode === 'follow_up' ? 'Godzina kontaktu' : 'Godzina spotkania'}
                                    </p>
                                    <span className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-cyan-500">
                                        30 min
                                    </span>
                                </div>
                                <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 lg:grid-cols-3">
                                    {rescheduleTimeOptions.map((slot) => {
                                        const isSelected = rescheduleTime === slot
                                        const isUnavailable = unavailableRescheduleSlots.has(slot)

                                        return (
                                            <button
                                                key={slot}
                                                type="button"
                                                disabled={isUnavailable}
                                                onClick={() => handleRescheduleTimeChange(slot)}
                                                className={`rounded-lg border px-1.5 py-2 text-[13px] font-black leading-none transition-all ${
                                                    isUnavailable
                                                        ? 'cursor-not-allowed border-slate-200/70 bg-slate-100 text-slate-400 opacity-45 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-500'
                                                        : isSelected
                                                            ? 'border-violet-500 bg-violet-600 text-white shadow-lg shadow-violet-600/20'
                                                            : 'border-slate-200 bg-white text-slate-700 hover:border-violet-300 hover:text-violet-600 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-200 dark:hover:border-violet-400 dark:hover:text-violet-200'
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

                    <div className="mt-5 flex gap-3">
                        <button
                            type="button"
                            onClick={closeRescheduleModal}
                            disabled={savingId === rescheduleMeeting.id}
                            className={`${secondaryButtonClass} flex-1 h-11 text-xs transition-all disabled:opacity-50`}
                        >
                            Zamknij
                        </button>
                        <button
                            type="button"
                            onClick={() => void saveMeetingReschedule()}
                            disabled={meetingActionsLocked || savingId === rescheduleMeeting.id}
                            className={`${primaryButtonClass} flex-1 h-11 text-xs transition-all disabled:opacity-50`}
                        >
                            {savingId === rescheduleMeeting.id
                                ? 'Zapisywanie...'
                                : rescheduleMode === 'follow_up'
                                    ? 'Zapisz termin kontaktu'
                                    : 'Zapisz nowy termin'}
                        </button>
                    </div>
                </div>
            </div>
        )}
        </>
    )
}
