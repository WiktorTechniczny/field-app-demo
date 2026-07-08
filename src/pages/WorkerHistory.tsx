import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../supabase'
import type { Survey, Shift, GpsLog, User, SalesMeeting } from '../db'
import { distanceMeters } from '../powerPoles'
import { QS } from '../questions'
import { getSurveyStatus } from '../surveyStatus'
import { AnimatePresence, motion } from 'framer-motion'
import AudioPlayer from '../components/AudioPlayer'
import { buildTranscriptText, downloadSurveyAudioAsMp3, downloadText, getTranscriptFilename } from '../audioUtils'
import { formatSurveyDateTime, getSurveyFollowUpMeta, getSurveyTimingMeta, type SurveyTimingMeta } from '../surveyTiming'
import { buildGoogleMapsDirectionsHref, buildPhoneHref } from '../contactLinks'
import { getSurveyStatusNote, getSurveyStatusNoteLabel } from '../surveyStatusNotes'
import { getSalesMeetingEffectiveScheduledAt, getSalesMeetingOriginalScheduledAt } from '../salesMeetingStatus'
import { getSalesMeetingAssignmentMetaRows, getSalesMeetingExecutionMetaRows } from '../poleAssignments'
import { normalizeSalesMeetingAddress } from '../salesMeetingText'

const card = "bg-white dark:bg-slate-800 rounded-xl border border-gray-200/60 dark:border-slate-700 shadow-md"
const innerCard = "bg-gray-50 dark:bg-slate-600/60 rounded-lg border border-gray-100 dark:border-slate-500"
function toDateInputLocal(date: Date): string {
    const yyyy = date.getFullYear()
    const mm = String(date.getMonth() + 1).padStart(2, '0')
    const dd = String(date.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
}

function getToday() {
    return toDateInputLocal(new Date())
}

function getWeekAgo() {
    const d = new Date()
    d.setDate(d.getDate() - 7)
    return toDateInputLocal(d)
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

const formatMeetingDateTimeLabel = (value: Date | null): string =>
    value
        ? value.toLocaleString('pl-PL', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        })
        : 'Brak'

const formatFollowUpScheduledLabel = (scheduledAt: string): string | null => {
    const parsed = new Date(scheduledAt)
    if (Number.isNaN(parsed.getTime())) return null
    return parsed.toLocaleString('pl-PL', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    })
}

const formatFollowUpMetaLabel = (date?: string | null, time?: string | null): string | null => {
    const trimmedDate = date?.trim() || ''
    const trimmedTime = time?.trim() || ''
    if (!trimmedDate && !trimmedTime) return null

    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmedDate)) {
        const parsed = new Date(`${trimmedDate}T${/^\d{2}:\d{2}$/.test(trimmedTime) ? trimmedTime : '00:00'}`)
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toLocaleString('pl-PL', trimmedTime
                ? {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                }
                : {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric'
                })
        }
    }

    return [trimmedDate, trimmedTime].filter(Boolean).join(' ').trim() || null
}

const getWorkerSurveyFollowUpDisplay = (
    survey: Survey,
    linkedMeeting?: SalesMeeting | null
): { label: string | null; title: string } => {
    const meta = getSurveyFollowUpMeta(survey)
    const metaLabel = formatFollowUpMetaLabel(meta.date, meta.time) || meta.label
    const linkedMeetingLabel =
        survey.status === 'attempted' && linkedMeeting
            ? formatFollowUpScheduledLabel(getSalesMeetingEffectiveScheduledAt(linkedMeeting))
            : null

    return {
        label: linkedMeetingLabel || metaLabel,
        title:
            survey.status === 'completed'
                ? 'Termin wizyty eksperta'
                : survey.status === 'attempted'
                    ? 'Termin ponownego kontaktu'
                    : 'Planowany powrót / kontakt'
    }
}

const getWorkerSurveyMeetingScheduleMeta = (
    survey: Survey,
    linkedMeeting: SalesMeeting | null,
    surveyTiming: SurveyTimingMeta
) => {
    const linkedMeetingHasFollowUpReschedule =
        linkedMeeting
            ? getSalesMeetingOriginalScheduledAt(linkedMeeting) !== getSalesMeetingEffectiveScheduledAt(linkedMeeting)
            : false
    const linkedMeetingScheduledAt = linkedMeeting ? getSalesMeetingEffectiveScheduledAt(linkedMeeting) : ''
    const linkedMeetingOriginalScheduledAt = linkedMeeting ? getSalesMeetingOriginalScheduledAt(linkedMeeting) : ''
    const followUpDisplay = getWorkerSurveyFollowUpDisplay(survey, linkedMeeting)
    const rawScheduledAt = Array.isArray(survey.answers?.meeting_scheduled_at) ? survey.answers?.meeting_scheduled_at[0] : survey.answers?.meeting_scheduled_at
    const rawMeetingScheduledDate =
        typeof rawScheduledAt === 'string' && rawScheduledAt.trim().length > 0
            ? new Date(rawScheduledAt)
            : null
    const linkedMeetingOriginalDate =
        linkedMeetingHasFollowUpReschedule && linkedMeetingOriginalScheduledAt
            ? new Date(linkedMeetingOriginalScheduledAt)
            : null
    const linkedMeetingEffectiveDate =
        linkedMeetingScheduledAt
            ? new Date(linkedMeetingScheduledAt)
            : null
    const surveyStartedMeetingDate = surveyTiming.startedAt
    const surveyCreatedMeetingDate = new Date(survey.created_at)
    const fallbackOriginalMeetingDate =
        rawMeetingScheduledDate && !Number.isNaN(rawMeetingScheduledDate.getTime())
            ? rawMeetingScheduledDate
            : linkedMeetingOriginalDate && !Number.isNaN(linkedMeetingOriginalDate.getTime())
                ? linkedMeetingOriginalDate
                : surveyStartedMeetingDate && !Number.isNaN(surveyStartedMeetingDate.getTime())
                    ? surveyStartedMeetingDate
                    : !Number.isNaN(surveyCreatedMeetingDate.getTime())
                        ? surveyCreatedMeetingDate
                        : null
    const scheduledMeetingDate =
        linkedMeetingEffectiveDate && !Number.isNaN(linkedMeetingEffectiveDate.getTime())
            ? linkedMeetingEffectiveDate
            : fallbackOriginalMeetingDate
    const hasSurveyOriginalFollowUpDate =
        survey.status === 'attempted' &&
        rawMeetingScheduledDate !== null &&
        !Number.isNaN(rawMeetingScheduledDate.getTime()) &&
        linkedMeetingEffectiveDate !== null &&
        !Number.isNaN(linkedMeetingEffectiveDate.getTime()) &&
        rawMeetingScheduledDate.getTime() !== linkedMeetingEffectiveDate.getTime()
    const showOriginalMeetingDate =
        survey.status === 'attempted'
            ? Boolean(followUpDisplay.label)
            : linkedMeetingHasFollowUpReschedule || hasSurveyOriginalFollowUpDate
    const originalMeetingDate = fallbackOriginalMeetingDate

    return {
        followUpDisplay,
        showOriginalMeetingDate,
        scheduledMeetingTitle: showOriginalMeetingDate ? 'Termin pierwotny' : 'Termin spotkania',
        scheduledMeetingLabel:
            originalMeetingDate && !Number.isNaN(originalMeetingDate.getTime())
                ? formatMeetingDateTimeLabel(originalMeetingDate)
                : scheduledMeetingDate && !Number.isNaN(scheduledMeetingDate.getTime())
                    ? formatMeetingDateTimeLabel(scheduledMeetingDate)
                    : 'Brak',
    }
}

export default function WorkerHistory({ user, onBack }: { user: User; onBack: () => void }) {
    const [loading, setLoading] = useState(true)
    const [surveys, setSurveys] = useState<Survey[]>([])
    const [shifts, setShifts] = useState<Shift[]>([])
    const [gpsLogs, setGpsLogs] = useState<GpsLog[]>([])
    const [linkedMeetings, setLinkedMeetings] = useState<SalesMeeting[]>([])
    const [dateFrom, setDateFrom] = useState(getWeekAgo)
    const [dateTo, setDateTo] = useState(getToday)
    const [detailsSurvey, setDetailsSurvey] = useState<Survey | null>(null)

    useEffect(() => {
        const load = async () => {
            setLoading(true)
            const from = `${dateFrom}T00:00:00`
            const to = `${dateTo}T23:59:59`

            const [survRes, shiftRes, gpsRes] = await Promise.all([
                supabase.from('surveys').select('*').eq('user_id', user.id).gte('created_at', from).lte('created_at', to).order('created_at', { ascending: false }),
                supabase.from('shifts').select('*').eq('user_id', user.id).gte('start_time', from).lte('start_time', to).order('start_time', { ascending: false }),
                supabase.from('gps_logs').select('latitude, longitude, timestamp, shift_id').eq('user_id', user.id).gte('timestamp', from).lte('timestamp', to),
            ])

            if (survRes.data) setSurveys(survRes.data)
            if (shiftRes.data) setShifts(shiftRes.data)
            if (gpsRes.data) setGpsLogs(gpsRes.data as unknown as GpsLog[])

            const surveyIds = (survRes.data || [])
                .map((survey) => survey.id)
                .filter((id): id is number => typeof id === 'number')

            if (surveyIds.length > 0) {
                const meetingsRes = await supabase
                    .from('sales_meetings')
                    .select('*')
                    .in('linked_survey_id', surveyIds)

                if (meetingsRes.data) setLinkedMeetings(meetingsRes.data as SalesMeeting[])
                else setLinkedMeetings([])
            } else {
                setLinkedMeetings([])
            }
            setLoading(false)
        }

        load()
    }, [user.id, dateFrom, dateTo])

    useEffect(() => {
        if (!detailsSurvey) return

        const previousOverflow = document.body.style.overflow
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setDetailsSurvey(null)
            }
        }

        document.body.style.overflow = 'hidden'
        document.addEventListener('keydown', onKeyDown)

        return () => {
            document.body.style.overflow = previousOverflow
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [detailsSurvey])

    const groupedData = useMemo(() => {
        const map: Record<string, { date: string; shifts: Shift[]; surveys: Survey[]; totalMs: number; distanceKm: number }> = {}

        shifts.forEach((s) => {
            const dateStr = s.start_time.split('T')[0]
            if (!map[dateStr]) map[dateStr] = { date: dateStr, shifts: [], surveys: [], totalMs: 0, distanceKm: 0 }
            map[dateStr].shifts.push(s)

            const startMs = new Date(s.start_time).getTime()
            const lastSurveyMs = surveys
                .filter((sv) => sv.shift_id === s.id)
                .reduce((max, sv) => Math.max(max, new Date(sv.created_at).getTime()), startMs)
            const lastGpsMs = gpsLogs
                .filter((g) => g.shift_id === s.id)
                .reduce((max, g) => Math.max(max, new Date(g.timestamp).getTime()), startMs)
            const endMs = s.end_time ? new Date(s.end_time).getTime() : Math.max(startMs, lastSurveyMs, lastGpsMs)
            map[dateStr].totalMs += endMs - startMs

            const shiftGps = gpsLogs
                .filter((g) => g.shift_id === s.id)
                .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
            let dist = 0
            for (let i = 1; i < shiftGps.length; i++) {
                dist += distanceMeters(shiftGps[i - 1].latitude, shiftGps[i - 1].longitude, shiftGps[i].latitude, shiftGps[i].longitude)
            }
            map[dateStr].distanceKm += dist / 1000
        })

        surveys.forEach((sv) => {
            const dateStr = sv.created_at.split('T')[0]
            if (!map[dateStr]) map[dateStr] = { date: dateStr, shifts: [], surveys: [], totalMs: 0, distanceKm: 0 }
            if (!map[dateStr].surveys.some((x) => x.id === sv.id)) map[dateStr].surveys.push(sv)
        })

        return Object.values(map).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    }, [shifts, surveys, gpsLogs])

    const detailsLinkedMeeting = detailsSurvey ? getLinkedMeetingForSurvey(detailsSurvey, linkedMeetings) : null
    const detailsStatusMeta = detailsSurvey ? getSurveyStatus(detailsSurvey) : null
    const detailsStatusNote = detailsSurvey ? getSurveyStatusNote(detailsSurvey, detailsLinkedMeeting) : null
    const detailsStatusNoteLabel = detailsSurvey ? getSurveyStatusNoteLabel(detailsSurvey) : null
    const detailsTiming = detailsSurvey ? getSurveyTimingMeta(detailsSurvey) : null
    const detailsMeetingMeta =
        detailsSurvey && detailsTiming
            ? getWorkerSurveyMeetingScheduleMeta(detailsSurvey, detailsLinkedMeeting, detailsTiming)
            : null
    const detailsPhoneHref = detailsSurvey ? buildPhoneHref(detailsSurvey.respondent_phone) : null
    const detailsDirectionsHref = detailsSurvey ? buildGoogleMapsDirectionsHref(detailsSurvey.address) : null
    const detailsAssignmentRows = useMemo(
        () => (detailsLinkedMeeting ? getSalesMeetingAssignmentMetaRows(detailsLinkedMeeting) : []),
        [detailsLinkedMeeting]
    )
    const detailsExecutionRows = useMemo(
        () => (detailsLinkedMeeting ? getSalesMeetingExecutionMetaRows(detailsLinkedMeeting) : []),
        [detailsLinkedMeeting]
    )

    if (loading) {
        return (
            <div className="max-w-4xl mx-auto px-4 py-12 flex flex-col items-center justify-center min-h-[50vh]">
                <div className="w-8 h-8 border-4 border-cyan-500 border-t-transparent rounded-full animate-spin mb-4" />
                <p className="text-xs font-black text-gray-400 tracking-widest uppercase">Ładowanie historii...</p>
            </div>
        )
    }

    return (
        <div className="max-w-4xl mx-auto px-4 py-6 animate-in fade-in duration-300">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 mb-8">
                <button onClick={onBack} className="w-10 h-10 flex items-center justify-center rounded-2xl bg-white dark:bg-slate-800 border border-gray-100 dark:border-slate-700 shadow-sm text-lg hover:text-cyan-500 hover:scale-105 active:scale-95 transition-all">
                    {'<-'}
                </button>
                <div className="flex-1">
                    <h1 className="text-xl font-black dark:text-white">Historia Pracy</h1>
                    <p className="text-[10px] text-gray-400 font-black uppercase tracking-widest mt-0.5">Twoje dotychczasowe postępy</p>
                </div>
                <div className="flex items-center gap-3 bg-white dark:bg-slate-800 px-4 py-2 rounded-xl border border-gray-200/60 dark:border-slate-700 shadow-sm relative group">
                    <span className="w-5 h-5 text-cyan-500/80 shrink-0" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-full h-full">
                            <rect x="3" y="4" width="18" height="17" rx="2" ry="2" strokeWidth="2" />
                            <line x1="16" y1="2" x2="16" y2="6" strokeWidth="2" />
                            <line x1="8" y1="2" x2="8" y2="6" strokeWidth="2" />
                            <line x1="3" y1="10" x2="21" y2="10" strokeWidth="2" />
                        </svg>
                    </span>
                    <div className="flex items-center gap-2">
                        <div className="flex flex-col -gap-1">
                            <span className="text-[8px] font-black text-cyan-500 uppercase tracking-widest leading-none">Za okres od</span>
                            <input
                                type="date"
                                value={dateFrom}
                                onChange={(e) => setDateFrom(e.target.value)}
                                onClick={(e) => (e.currentTarget as HTMLInputElement).showPicker?.()}
                                className="bg-transparent text-sm font-black dark:text-white outline-none focus:text-cyan-500 transition-colors w-[110px]"
                            />
                        </div>
                        <span className="text-gray-400 font-bold mx-1 mt-2">-</span>
                        <div className="flex flex-col -gap-1">
                            <span className="text-[8px] font-black text-gray-400 uppercase tracking-widest leading-none">Do</span>
                            <input
                                type="date"
                                value={dateTo}
                                onChange={(e) => setDateTo(e.target.value)}
                                onClick={(e) => (e.currentTarget as HTMLInputElement).showPicker?.()}
                                className="bg-transparent text-sm font-black dark:text-white outline-none focus:text-cyan-500 transition-colors w-[110px]"
                            />
                        </div>
                    </div>
                </div>
            </div>

            <div className={`${card} p-4 sm:p-8 space-y-12 overflow-y-auto max-h-[80vh] custom-scrollbar`}>
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-2 pb-6 border-b border-gray-50 dark:border-slate-700">
                    <div className="w-full md:w-auto">
                        <h3 className="text-sm font-black text-gray-800 dark:text-white uppercase tracking-widest">Rejestr i historia umów</h3>
                    </div>
                    <div className="flex gap-6 md:gap-10 bg-gray-50 dark:bg-slate-900/50 p-4 rounded-2xl border border-gray-100 dark:border-slate-700 shadow-inner w-full md:w-auto justify-around md:justify-start">
                        <div className="text-center">
                            <p className="text-[10px] text-gray-400 uppercase font-black mb-1">Umów</p>
                            <p className="text-2xl font-black dark:text-white leading-none">{surveys.length}</p>
                        </div>
                        <div className="text-center">
                            <p className="text-[10px] text-gray-400 uppercase font-black mb-1">Sesji</p>
                            <p className="text-2xl font-black dark:text-white leading-none">{shifts.length}</p>
                        </div>
                    </div>
                </div>

                {groupedData.length === 0 && (
                    <div className="text-center py-16">
                        <span className="text-3xl mb-4 block">--</span>
                        <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Brak historii pracy w tym okresie</p>
                    </div>
                )}

                {groupedData.map((day) => {
                    const h = Math.floor(day.totalMs / 3600000)
                    const m = Math.floor((day.totalMs % 3600000) / 60000)
                    const dateLabel = new Date(day.date).toLocaleDateString('pl-PL')

                    return (
                        <div key={day.date} className="space-y-6">
                            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-6">
                                <h4 className="shrink-0 text-[10px] font-black text-slate-900 dark:text-white uppercase bg-cyan-100 dark:bg-cyan-500/20 px-3 py-1.5 rounded-xl border border-cyan-200 dark:border-cyan-900/50">{dateLabel}</h4>
                                <div className="hidden sm:block flex-1 h-px bg-gray-100 dark:bg-slate-800" />
                                <div className="text-[10px] font-black text-gray-400 uppercase flex flex-wrap gap-2 sm:gap-4 w-full sm:w-auto justify-between sm:justify-start items-center">
                                    <span>{h > 0 ? `${h}h ` : ''}{m}m pracy</span>
                                    <span className="text-cyan-500">Dzień: {day.surveys.length} umów</span>
                                </div>
                            </div>

                            <div className="space-y-6 ml-2 sm:ml-6">
                                {day.shifts.length === 0 && day.surveys.length > 0 && (
                                    <div className="relative pl-6 sm:pl-10 border-l-2 border-gray-100 dark:border-slate-800 py-2">
                                        <div className="absolute top-0 -left-[5px] w-2 h-2 rounded-full bg-gray-400" />
                                        <p className="text-[10px] font-bold text-gray-400 mb-4 uppercase">Wpisy bez przypisanej sesji (offline fallback)</p>
                                    </div>
                                )}

                                {day.shifts.map((s) => {
                                    const start = new Date(s.start_time)
                                    const shiftSurveys = day.surveys.filter(
                                        (sv) =>
                                            sv.shift_id === s.id ||
                                            (!sv.shift_id && new Date(sv.created_at) >= new Date(s.start_time) && (!s.end_time || new Date(sv.created_at) <= new Date(s.end_time))),
                                    )

                                    const shiftGps = gpsLogs
                                        .filter((g) => g.shift_id === s.id)
                                        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
                                    let shiftDist = 0
                                    for (let i = 1; i < shiftGps.length; i++) {
                                        shiftDist += distanceMeters(shiftGps[i - 1].latitude, shiftGps[i - 1].longitude, shiftGps[i].latitude, shiftGps[i].longitude)
                                    }

                                    return (
                                        <div key={s.id} className="relative pl-6 sm:pl-10 border-l-2 border-gray-100 dark:border-slate-800 py-2">
                                            <div className="absolute top-0 -left-[5px] w-2 h-2 rounded-full bg-cyan-500 shadow-[0_0_10px_rgba(245,158,11,0.5)]" />

                                            <div className="flex flex-col lg:flex-row items-start lg:items-center gap-2 lg:gap-4 mb-4">
                                                <span className="text-[10px] font-black font-mono text-slate-900 dark:text-white bg-slate-50 dark:bg-slate-800 px-2 py-1 rounded-lg border border-slate-100 dark:border-slate-700 shadow-sm">
                                                    {start.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })} - {s.end_time ? new Date(s.end_time).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }) : 'Obecnie'}
                                                </span>
                                                <div className="flex flex-wrap items-center gap-2 w-full lg:w-auto mt-1 lg:mt-0">
                                                    <span className="text-[9px] font-bold text-gray-400 uppercase tracking-widest hidden sm:inline-block">Sesja</span>
                                                    <div className="bg-green-500/10 text-green-600 dark:text-green-400 text-[9px] font-black px-2 sm:px-3 py-0.5 rounded-full border border-green-500/20">
                                                        {shiftSurveys.length} UMÓW
                                                    </div>
                                                    <div className="bg-blue-500/10 text-blue-600 dark:text-blue-400 text-[9px] font-black px-2 sm:px-3 py-0.5 rounded-full border border-blue-500/20">
                                                        {(shiftDist / 1000).toFixed(2)} KM
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="flex flex-col gap-3">
                                                {shiftSurveys.length === 0 && <p className="text-xs text-gray-400 font-bold italic py-2">Brak umów w tej sesji</p>}

                                                {shiftSurveys
                                                    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                                                    .map((sv) => {
                                                        const statusMeta = getSurveyStatus(sv)
                                                        const linkedMeeting = getLinkedMeetingForSurvey(sv, linkedMeetings)
                                                        const surveyStatusNote = getSurveyStatusNote(sv, linkedMeeting)
                                                        const surveyStatusNoteLabel = getSurveyStatusNoteLabel(sv)
                                                        const surveyTiming = getSurveyTimingMeta(sv)
                                                        const meetingMeta = getWorkerSurveyMeetingScheduleMeta(sv, linkedMeeting, surveyTiming)
                                                        const surveyPhoneHref = buildPhoneHref(sv.respondent_phone)
                                                        const surveyDirectionsHref = buildGoogleMapsDirectionsHref(sv.address)
                                                        return (
                                                            <div
                                                                key={sv.id}
                                                                className={`${innerCard} border-l-4 ${statusMeta.borderClass} px-4 py-4 sm:px-5 sm:py-5 shadow-sm`}
                                                            >
                                                                <div className="flex flex-col gap-3">
                                                                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                                                        <div className="min-w-0 space-y-2">
                                                                            <div className="flex flex-wrap items-center gap-2">
                                                                                <p className="min-w-0 text-sm sm:text-base font-black leading-tight wrap-break-word dark:text-white">
                                                                                    {sv.respondent_name || 'Mieszkaniec / brak danych'}
                                                                                </p>
                                                                                <span className={`inline-flex max-w-full items-center rounded-full px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.14em] ${statusMeta.chipClass}`}>
                                                                                    {statusMeta.label}
                                                                                </span>
                                                                            </div>
                                                                            {surveyStatusNote && (
                                                                                <p className="text-[10px] font-bold leading-relaxed text-cyan-600 dark:text-cyan-300 wrap-break-word">
                                                                                    {surveyStatusNoteLabel}: {surveyStatusNote}
                                                                                </p>
                                                                            )}
                                                                        </div>

                                                                        <div className="shrink-0">
                                                                            <div className="inline-flex rounded-xl border border-slate-200 bg-white/80 px-3 py-1.5 text-[10px] font-black text-slate-700 shadow-sm dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-200">
                                                                                {new Date(sv.created_at).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}
                                                                            </div>
                                                                        </div>
                                                                    </div>

                                                                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                                                                        <div className="min-w-0 space-y-2">
                                                                            {sv.respondent_phone && (
                                                                                surveyPhoneHref ? (
                                                                                    <a
                                                                                        href={surveyPhoneHref}
                                                                                        className="block w-fit text-[11px] font-black text-cyan-700 underline decoration-cyan-300 underline-offset-2 dark:text-cyan-300 break-all"
                                                                                    >
                                                                                        📞 {sv.respondent_phone}
                                                                                    </a>
                                                                                ) : (
                                                                                    <p className="text-[11px] font-black text-slate-500 dark:text-slate-300 break-all">
                                                                                        📞 {sv.respondent_phone}
                                                                                    </p>
                                                                                )
                                                                            )}

                                                                            {surveyDirectionsHref ? (
                                                                                <a
                                                                                    href={surveyDirectionsHref}
                                                                                    target="_blank"
                                                                                    rel="noreferrer"
                                                                                    className="block text-[11px] font-bold leading-snug text-cyan-700 underline decoration-cyan-300 underline-offset-2 dark:text-cyan-300 wrap-break-word"
                                                                                >
                                                                                    📍 {normalizeSalesMeetingAddress(sv.address) || sv.address || 'Brak pełnego adresu'}
                                                                                </a>
                                                                            ) : (
                                                                                <p className="text-[11px] font-bold leading-snug text-slate-500 dark:text-slate-300 wrap-break-word">
                                                                                    📍 {normalizeSalesMeetingAddress(sv.address) || sv.address || 'Brak pełnego adresu'}
                                                                                </p>
                                                                            )}

                                                                        </div>
                                                                        <div className="rounded-2xl border border-slate-200/80 bg-slate-50/70 p-2.5 dark:border-slate-600/60 dark:bg-slate-800/45">
                                                                            <div className={`grid gap-2 ${meetingMeta.followUpDisplay.label && sv.status !== 'refused' && sv.status !== 'not_home' && sv.status !== 'no_cooperation' ? 'sm:grid-cols-2' : ''}`}>
                                                                                <div className="rounded-xl border border-violet-300/60 bg-violet-50/80 px-3 py-2 dark:border-violet-400/20 dark:bg-violet-500/10">
                                                                                    <p className="text-[9px] font-black uppercase tracking-[0.22em] text-violet-600 dark:text-violet-200">
                                                                                        {meetingMeta.scheduledMeetingTitle}
                                                                                    </p>
                                                                                    <p className="mt-1 text-sm font-black text-slate-700 dark:text-slate-100">
                                                                                        {meetingMeta.scheduledMeetingLabel}
                                                                                    </p>
                                                                                </div>
                                                                                {meetingMeta.followUpDisplay.label && sv.status !== 'refused' && sv.status !== 'not_home' && sv.status !== 'no_cooperation' && (
                                                                                    <div className="rounded-xl border border-blue-300/60 bg-blue-50/80 px-3 py-2 dark:border-blue-400/20 dark:bg-blue-500/10">
                                                                                        <p className="text-[9px] font-black uppercase tracking-[0.22em] text-blue-600 dark:text-blue-200">
                                                                                            {meetingMeta.followUpDisplay.title}
                                                                                        </p>
                                                                                        <p className="mt-1 text-sm font-black text-slate-700 dark:text-slate-100">
                                                                                            {meetingMeta.followUpDisplay.label}
                                                                                        </p>
                                                                                    </div>
                                                                                )}
                                                                            </div>

                                                                            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                                                                <div className="inline-flex w-fit rounded-xl border border-slate-200 bg-white/80 px-3 py-1.5 text-[10px] font-black text-slate-700 shadow-sm dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-200">
                                                                                    {new Date(sv.created_at).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}
                                                                                </div>
                                                                                <button
                                                                                    type="button"
                                                                                    onClick={() => setDetailsSurvey(sv)}
                                                                                    className="ui-pressable w-full sm:w-auto rounded-xl border border-cyan-400/30 bg-cyan-500/10 px-4 py-2.5 text-[10px] font-black uppercase tracking-[0.16em] text-cyan-700 transition-colors hover:bg-cyan-500/20 dark:border-cyan-400/25 dark:bg-cyan-500/10 dark:text-cyan-100"
                                                                                >
                                                                                    Szczegóły
                                                                                </button>
                                                                            </div>
                                                                        </div>
                                                                    </div>
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
                    )
                })}
            </div>

            <AnimatePresence>
                {detailsSurvey && detailsStatusMeta && detailsTiming && (
                    <div className="fixed inset-0 z-100 flex items-center justify-center p-3 sm:p-4">
                        <button
                            type="button"
                            onClick={() => setDetailsSurvey(null)}
                            className="ui-modal-backdrop absolute inset-0 bg-slate-900/65 backdrop-blur-sm"
                            aria-label="Zamknij szczegóły wpisu"
                        />
                        <motion.div
                            initial={{ opacity: 0, y: 18, scale: 0.98 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 18, scale: 0.98 }}
                            transition={{ duration: 0.2 }}
                            className="ui-modal-panel relative max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-[28px] border border-gray-200 bg-white p-4 shadow-2xl dark:border-slate-700 dark:bg-slate-800 sm:p-6"
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <p className="text-[10px] font-black uppercase tracking-widest text-cyan-500">Szczegóły wpisu</p>
                                    <div className="mt-2 flex flex-wrap items-center gap-2">
                                        <h3 className="text-lg font-black text-slate-900 dark:text-white wrap-break-word">
                                            {detailsSurvey.respondent_name || 'Mieszkaniec / brak danych'}
                                        </h3>
                                        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.14em] ${detailsStatusMeta.chipClass}`}>
                                            {detailsStatusMeta.label}
                                        </span>
                                    </div>
                                    <p className="mt-2 text-sm font-semibold text-slate-500 dark:text-slate-300 wrap-break-word">
                                        {normalizeSalesMeetingAddress(detailsSurvey.address) || detailsSurvey.address || 'Brak pełnego adresu'}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setDetailsSurvey(null)}
                                    className="rounded-xl border border-slate-200 px-3 py-2 text-[10px] font-black uppercase tracking-wider text-slate-500 transition-colors hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700"
                                >
                                    Zamknij
                                </button>
                            </div>

                            <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)]">
                                <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 dark:border-slate-700 dark:bg-slate-900/40">
                                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Dokładna lokalizacja</p>
                                    {detailsDirectionsHref ? (
                                        <a
                                            href={detailsDirectionsHref}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="mt-2 block text-sm font-bold leading-snug text-cyan-700 underline decoration-cyan-300 underline-offset-2 dark:text-cyan-300 wrap-break-word"
                                        >
                                            {normalizeSalesMeetingAddress(detailsSurvey.address) || detailsSurvey.address || 'Brak danych'}
                                        </a>
                                    ) : (
                                        <p className="mt-2 text-sm font-bold leading-snug text-slate-800 dark:text-white wrap-break-word">
                                            {normalizeSalesMeetingAddress(detailsSurvey.address) || detailsSurvey.address || 'Brak danych'}
                                        </p>
                                    )}
                                    {detailsSurvey.latitude && (
                                        <p className="mt-2 text-[11px] font-mono text-slate-400">
                                            {detailsSurvey.latitude.toFixed(6)}, {detailsSurvey.longitude?.toFixed(6)}
                                        </p>
                                    )}
                                </div>

                                <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 dark:border-slate-700 dark:bg-slate-900/40">
                                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Respondent i kontakt</p>
                                    <div className="mt-2 space-y-2">
                                        <p className="text-sm font-bold text-slate-900 dark:text-white wrap-break-word">
                                            {detailsSurvey.respondent_name || 'Brak'}
                                        </p>
                                        {detailsSurvey.respondent_phone && (
                                            detailsPhoneHref ? (
                                                <a
                                                    href={detailsPhoneHref}
                                                    className="block text-sm font-bold text-cyan-700 underline decoration-cyan-300 underline-offset-2 dark:text-cyan-300 break-all"
                                                >
                                                    {detailsSurvey.respondent_phone}
                                                </a>
                                            ) : (
                                                <p className="text-sm font-bold text-slate-500 dark:text-slate-300 break-all">
                                                    {detailsSurvey.respondent_phone}
                                                </p>
                                            )
                                        )}
                                        {detailsStatusNote && detailsStatusNoteLabel && (
                                            <p className="text-[11px] font-bold leading-relaxed text-cyan-600 dark:text-cyan-300 wrap-break-word">
                                                {detailsStatusNoteLabel}: {detailsStatusNote}
                                            </p>
                                        )}
                                        {detailsMeetingMeta?.followUpDisplay.label &&
                                            detailsSurvey.status !== 'refused' &&
                                            detailsSurvey.status !== 'not_home' &&
                                            detailsSurvey.status !== 'no_cooperation' && (
                                                <p className="text-[10px] font-black uppercase tracking-wide text-cyan-500 wrap-break-word">
                                                    {detailsMeetingMeta.followUpDisplay.title}: {detailsMeetingMeta.followUpDisplay.label}
                                                </p>
                                            )}
                                    </div>
                                </div>
                            </div>

                            <div className="mt-4 grid grid-cols-1 gap-4 border-t border-slate-200 pt-4 dark:border-slate-700 sm:grid-cols-2 xl:grid-cols-5">
                                <div>
                                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                                        {detailsMeetingMeta?.scheduledMeetingTitle || 'Termin spotkania'}
                                    </p>
                                    <p className="mt-2 text-sm font-bold text-slate-900 dark:text-white">
                                        {detailsMeetingMeta?.scheduledMeetingLabel || 'Brak'}
                                    </p>
                                </div>
                                {detailsMeetingMeta?.followUpDisplay.label &&
                                    detailsSurvey.status !== 'refused' &&
                                    detailsSurvey.status !== 'not_home' &&
                                    detailsSurvey.status !== 'no_cooperation' && (
                                        <div>
                                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                                                {detailsMeetingMeta.followUpDisplay.title}
                                            </p>
                                            <p className="mt-2 text-sm font-bold text-slate-900 dark:text-white">
                                                {detailsMeetingMeta.followUpDisplay.label}
                                            </p>
                                        </div>
                                    )}
                                <div>
                                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Start wniosku</p>
                                    <p className="mt-2 text-sm font-bold text-slate-900 dark:text-white">{formatSurveyDateTime(detailsTiming.startedAt)}</p>
                                </div>
                                <div>
                                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Koniec wniosku</p>
                                    <p className="mt-2 text-sm font-bold text-slate-900 dark:text-white">{formatSurveyDateTime(detailsTiming.finishedAt)}</p>
                                </div>
                                <div>
                                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Czas spotkania</p>
                                    <p className="mt-2 text-sm font-bold text-slate-900 dark:text-white">{detailsTiming.durationLabel || 'Brak'}</p>
                                </div>
                            </div>

                            {(detailsAssignmentRows.length > 0 || detailsExecutionRows.length > 0) && (
                                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                                    {detailsAssignmentRows.length > 0 && (
                                        <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 dark:border-slate-700 dark:bg-slate-900/40">
                                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Dane z dzialek</p>
                                            <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                                {detailsAssignmentRows.map((row) => (
                                                    <div key={row.label} className="rounded-xl border border-slate-200/80 bg-white/80 px-3 py-2.5 dark:border-slate-700 dark:bg-slate-800/60">
                                                        <p className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-400">{row.label}</p>
                                                        <p className="mt-1 text-sm font-black text-slate-900 dark:text-white">{row.value}</p>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                    {detailsExecutionRows.length > 0 && (
                                        <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 dark:border-slate-700 dark:bg-slate-900/40">
                                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Wynik PH</p>
                                            <div className="mt-3 space-y-2">
                                                {detailsExecutionRows.map((row) => (
                                                    <div key={row.label} className="rounded-xl border border-slate-200/80 bg-white/80 px-3 py-2.5 dark:border-slate-700 dark:bg-slate-800/60">
                                                        <p className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-400">{row.label}</p>
                                                        <p className="mt-1 text-sm font-black text-slate-900 dark:text-white">{row.value}</p>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {detailsSurvey.audio_url && (
                                <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/80 p-4 dark:border-slate-700 dark:bg-slate-900/40">
                                    <div className="flex items-center justify-between gap-3">
                                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Nagranie audio</p>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                void downloadSurveyAudioAsMp3(detailsSurvey, `nagranie_${detailsSurvey.id ?? 'umowa'}`).catch((error) => {
                                                    console.error('Audio download failed:', error)
                                                    alert('Nie udało się pobrać nagrania w formacie MP3.')
                                                })
                                            }}
                                            className="text-[10px] font-black uppercase tracking-wider text-cyan-600 hover:underline dark:text-cyan-300"
                                        >
                                            Pobierz MP3
                                        </button>
                                    </div>
                                    <div className="mt-3">
                                        <AudioPlayer url={detailsSurvey.audio_url} expectedDurationSeconds={detailsTiming.audioDurationSeconds} />
                                    </div>
                                    <div className="mt-4">
                                        <div className="flex items-center justify-between gap-3">
                                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Transkrypcja</p>
                                            <button
                                                type="button"
                                                onClick={() => downloadText(getTranscriptFilename(detailsSurvey.id), buildTranscriptText(detailsSurvey))}
                                                className="text-[10px] font-black uppercase tracking-wider text-cyan-600 hover:underline dark:text-cyan-300"
                                            >
                                                Pobierz TXT
                                            </button>
                                        </div>
                                        <p className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap text-[12px] leading-5 text-slate-600 dark:text-slate-300">
                                            {detailsSurvey.audio_transcript?.trim() || 'Brak automatycznej transkrypcji dla tego nagrania.'}
                                        </p>
                                    </div>
                                </div>
                            )}

                            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/80 p-4 dark:border-slate-700 dark:bg-slate-900/40">
                                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Dane umowy</p>
                                <div className="mt-3 grid gap-2">
                                    {detailsSurvey.answers &&
                                        QS.map((q, qIndex) => {
                                            const ans = detailsSurvey.answers[q.id]
                                            if (ans === undefined || ans === null || ans === '') return null
                                            return (
                                                <div key={q.id} className="flex flex-col gap-1 rounded-xl border border-slate-200/80 bg-white/80 px-3 py-2.5 dark:border-slate-700 dark:bg-slate-800/60 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                                                    <span className="text-[11px] text-slate-500 dark:text-slate-400">
                                                        {qIndex + 1}. {q.text}
                                                    </span>
                                                    <span className="text-[11px] font-black text-slate-900 dark:text-white wrap-break-word sm:max-w-[55%] sm:text-right">
                                                        {String(ans)}
                                                    </span>
                                                </div>
                                            )
                                        })}
                                    {(!detailsSurvey.answers || Object.keys(detailsSurvey.answers).length === 0) && (
                                        <p className="text-[11px] font-bold italic text-slate-400">Brak wypełnionych odpowiedzi.</p>
                                    )}
                                </div>
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>
        </div>
    )
}
