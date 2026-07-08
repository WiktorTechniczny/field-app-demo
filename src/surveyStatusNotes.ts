import type { SalesMeeting, Survey } from './db'
import { getSalesMeetingNoteWithoutRescheduleInfo } from './salesMeetingStatus'
import { getSurveyRefusalStage } from './surveyStatus'

const getSurveyAnswerText = (survey: Survey, key: string): string => {
    const raw = survey.answers?.[key]
    if (typeof raw === 'string') return raw.trim()
    if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean).join(', ')
    if (raw === null || raw === undefined) return ''
    return String(raw).trim()
}

export const getSurveyAttemptedNote = (survey: Survey): string => getSurveyAnswerText(survey, 'notatka_z_kontaktu')

export const getSurveyStoredStatusNote = (survey: Survey): string =>
    getSurveyAnswerText(survey, 'status_note') ||
    getSurveyAnswerText(survey, 'notatka_statusu') ||
    getSurveyAnswerText(survey, 'status_comment')

export const getSurveyStatusNote = (survey: Survey, linkedMeeting?: SalesMeeting | null): string => {
    const storedStatusNote = getSurveyStoredStatusNote(survey)
    const meetingStatusNote = linkedMeeting ? getSalesMeetingNoteWithoutRescheduleInfo(linkedMeeting.status_note) || '' : ''

    if (survey.status === 'attempted') {
        return getSurveyAttemptedNote(survey) || storedStatusNote || meetingStatusNote
    }

    return storedStatusNote || meetingStatusNote
}

export const getSurveyStatusNoteLabel = (survey: Survey): string => {
    switch (survey.status) {
        case 'attempted':
            return 'Notatka kontaktu'
        case 'no_cooperation':
            return 'Notatka braku wspolpracy'
        case 'refused':
            return getSurveyRefusalStage(survey) === 'before_meeting'
                ? 'Notatka odmowy przed spotkaniem'
                : getSurveyRefusalStage(survey) === 'after_meeting'
                    ? 'Notatka odmowy po spotkaniu'
                    : 'Notatka odmowy'
        case 'not_home':
            return 'Notatka statusu'
        default:
            return 'Notatka statusu'
    }
}
