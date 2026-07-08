import type { Survey } from './db'

const getSurveyAnswerText = (survey: Survey, key: string): string | null => {
    const raw = survey.answers?.[key]
    if (typeof raw === 'string') {
        const value = raw.trim()
        return value.length > 0 ? value : null
    }

    if (Array.isArray(raw)) {
        const firstValue = raw.map((item) => String(item).trim()).find((item) => item.length > 0)
        return firstValue ?? null
    }

    return null
}

const parseSurveyDate = (value: string | null | undefined): Date | null => {
    if (!value) return null
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? new Date(ms) : null
}

const getSurveyAnswerNumber = (survey: Survey, key: string): number | null => {
    const rawValue = getSurveyAnswerText(survey, key)
    if (!rawValue) return null

    const parsed = Number(rawValue.replace(',', '.'))
    return Number.isFinite(parsed) ? parsed : null
}

const formatMeetingDuration = (totalSeconds: number): string => {
    const safeSeconds = Math.max(0, totalSeconds)
    const hours = Math.floor(safeSeconds / 3600)
    const minutes = Math.floor((safeSeconds % 3600) / 60)
    const seconds = safeSeconds % 60

    if (hours > 0) return `${hours} godz. ${String(minutes).padStart(2, '0')} min ${String(seconds).padStart(2, '0')} sek`
    if (minutes > 0) return `${minutes} min ${String(seconds).padStart(2, '0')} sek`
    return `${seconds} sek`
}

export interface SurveyTimingMeta {
    startedAt: Date | null
    finishedAt: Date | null
    durationLabel: string | null
    durationSeconds: number | null
    audioDurationSeconds: number | null
    audioDurationLabel: string | null
}

export interface SurveyFollowUpMeta {
    date: string | null
    time: string | null
    label: string | null
}

export const getSurveyTimingMeta = (survey: Survey): SurveyTimingMeta => {
    const startedAt = parseSurveyDate(getSurveyAnswerText(survey, 'meeting_started_at'))
    const finishedAt = parseSurveyDate(getSurveyAnswerText(survey, 'meeting_finished_at')) ?? parseSurveyDate(survey.created_at)
    const storedDurationSeconds = getSurveyAnswerNumber(survey, 'meeting_duration_seconds')
    const storedDuration = getSurveyAnswerText(survey, 'meeting_duration_label')
    const computedDurationSeconds =
        startedAt && finishedAt
            ? Math.max(0, Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000))
            : null
    const durationSeconds = storedDurationSeconds ?? computedDurationSeconds
    const durationLabel =
        storedDuration ||
        (durationSeconds !== null ? formatMeetingDuration(durationSeconds) : null)
    const audioDurationSeconds = getSurveyAnswerNumber(survey, 'audio_duration_seconds') ?? durationSeconds
    const audioDurationLabel = audioDurationSeconds !== null ? formatMeetingDuration(audioDurationSeconds) : null

    return { startedAt, finishedAt, durationLabel, durationSeconds, audioDurationSeconds, audioDurationLabel }
}

export const getSurveyFollowUpMeta = (survey: Survey): SurveyFollowUpMeta => {
    const date = survey.respondent_preferred_date || getSurveyAnswerText(survey, 'follow_up_date')
    const time = survey.respondent_preferred_time || getSurveyAnswerText(survey, 'follow_up_time')
    const label = [date, time].filter(Boolean).join(' ').trim() || null
    return { date, time, label }
}

export const formatSurveyTime = (value: Date | null): string =>
    value
        ? value.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })
        : 'Brak'

export const formatSurveyDateTime = (value: Date | null): string =>
    value
        ? `${value.toLocaleDateString('pl-PL')} ${formatSurveyTime(value)}`
        : 'Brak'
