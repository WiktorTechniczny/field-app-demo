import type { Survey } from './db'

export type SurveyStatusKey = 'completed' | 'attempted' | 'refused' | 'not_home' | 'no_cooperation'
export type SurveyRefusalStage = 'before_meeting' | 'after_meeting'

export interface SurveyStatusMeta {
  key: SurveyStatusKey
  label: string
  shortLabel: string
  markerColor: string
  markerChar: string
  borderClass: string
  badgeClass: string
  chipClass: string
  textClass: string
}

const getSurveyAnswerText = (survey: Survey, key: string): string => {
  const raw = survey.answers?.[key]
  if (typeof raw === 'string') return raw.trim()
  if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).find(Boolean) || ''
  if (raw === null || raw === undefined) return ''
  return String(raw).trim()
}

export const getSurveyRefusalStage = (survey: Survey): SurveyRefusalStage | null => {
  const refusalStage = getSurveyAnswerText(survey, 'refusal_stage')
  if (refusalStage === 'before_meeting' || refusalStage === 'after_meeting') return refusalStage

  const poleStatus = getSurveyAnswerText(survey, 'pole_status')
  if (poleStatus === 'Odmowa przed spotkaniem') return 'before_meeting'
  if (poleStatus === 'Odmowa po spotkaniu') return 'after_meeting'

  if (survey.audio_url || survey.audio_path || survey.audio_captured_at || survey.audio_transcript?.trim()) {
    return 'after_meeting'
  }

  if (
    getSurveyAnswerText(survey, 'meeting_started_at') ||
    getSurveyAnswerText(survey, 'meeting_finished_at') ||
    getSurveyAnswerText(survey, 'meeting_duration_seconds')
  ) {
    return 'after_meeting'
  }

  if (survey.respondent_name === 'ODMOWA / PRZERWANO') {
    return 'before_meeting'
  }

  return null
}

const getSurveyRefusalLabels = (stage: SurveyRefusalStage | null) => {
  switch (stage) {
    case 'before_meeting':
      return { label: 'Odmowa przed spotkaniem', shortLabel: 'ODM. PRZED' }
    case 'after_meeting':
      return { label: 'Odmowa po spotkaniu', shortLabel: 'ODM. PO' }
    default:
      return { label: 'Odmowa klienta', shortLabel: 'ODMOWA' }
  }
}

export function getSurveyStatus(survey: Survey): SurveyStatusMeta {
  const poleStatus = survey.answers?.pole_status
  const isNoCooperation =
    survey.status === 'no_cooperation' ||
    poleStatus === 'Brak wspolpracy' ||
    poleStatus === 'Odmowa Fiedes' ||
    poleStatus === 'Brak mozliwosci wspolpracy' ||
    poleStatus === 'Brak możliwości współpracy'

  const isRefused =
    survey.status === 'refused' ||
    survey.respondent_name === 'ODMOWA / PRZERWANO' ||
    poleStatus === 'Odmowa' ||
    poleStatus === 'Odmowa/Przerwanie' ||
    poleStatus === 'Odmowa klienta' ||
    poleStatus === 'Odmowa przed spotkaniem' ||
    poleStatus === 'Odmowa po spotkaniu'

  const isNotHome =
    survey.status === 'not_home' ||
    poleStatus === 'Nie zastano w domu' ||
    poleStatus === 'Nie bylo nikogo' ||
    poleStatus === 'Nie było nikogo'

  if (isNoCooperation) {
    return {
      key: 'no_cooperation',
      label: 'Brak wspolpracy',
      shortLabel: 'BRAK WSP.',
      markerColor: '#e11d48',
      markerChar: 'F',
      borderClass: 'border-l-rose-500',
      badgeClass: 'bg-rose-200/90 dark:bg-rose-500/25 text-rose-700 dark:text-rose-100 ring-1 ring-inset ring-rose-300/70 dark:ring-rose-400/20',
      chipClass: 'border border-rose-400/65 bg-rose-100 text-rose-700 dark:border-rose-400/30 dark:bg-rose-500/18 dark:text-rose-100',
      textClass: 'text-rose-600 dark:text-rose-400'
    }
  }

  if (isRefused) {
    const refusalLabels = getSurveyRefusalLabels(getSurveyRefusalStage(survey))
    return {
      key: 'refused',
      label: refusalLabels.label,
      shortLabel: refusalLabels.shortLabel,
      markerColor: '#ef4444',
      markerChar: '\u2717',
      borderClass: 'border-l-red-500',
      badgeClass: 'bg-red-200/90 dark:bg-red-500/25 text-red-700 dark:text-red-100 ring-1 ring-inset ring-red-300/70 dark:ring-red-400/20',
      chipClass: 'border border-red-400/65 bg-red-100 text-red-700 dark:border-red-400/30 dark:bg-red-500/18 dark:text-red-100',
      textClass: 'text-red-600 dark:text-red-400'
    }
  }

  if (isNotHome) {
    return {
      key: 'not_home',
      label: 'Nie było nikogo',
      shortLabel: 'NIE BYŁO',
      markerColor: '#3b82f6',
      markerChar: '\u2302',
      borderClass: 'border-l-blue-500',
      badgeClass: 'bg-blue-200/90 dark:bg-blue-500/25 text-blue-700 dark:text-blue-100 ring-1 ring-inset ring-blue-300/70 dark:ring-blue-400/20',
      chipClass: 'border border-blue-400/65 bg-blue-100 text-blue-700 dark:border-blue-400/30 dark:bg-blue-500/18 dark:text-blue-100',
      textClass: 'text-blue-600 dark:text-blue-400'
    }
  }

  if (survey.status === 'attempted') {
    return {
      key: 'attempted',
      label: 'Kontakt ponowny',
      shortLabel: 'KONTAKT',
      markerColor: '#f59e0b',
      markerChar: '\u21bb',
      borderClass: 'border-l-cyan-500',
      badgeClass: 'bg-cyan-200/90 dark:bg-cyan-500/25 text-cyan-700 dark:text-cyan-100 ring-1 ring-inset ring-cyan-300/70 dark:ring-cyan-400/20',
      chipClass: 'border border-cyan-400/65 bg-cyan-100 text-cyan-700 dark:border-cyan-400/30 dark:bg-cyan-500/18 dark:text-cyan-100',
      textClass: 'text-cyan-600 dark:text-cyan-400'
    }
  }

  return {
    key: 'completed',
    label: 'Umowa podpisana',
    shortLabel: 'UMOWA',
    markerColor: '#10b981',
    markerChar: '\u2713',
    borderClass: 'border-l-green-500',
    badgeClass: 'bg-green-200/90 dark:bg-green-500/25 text-green-700 dark:text-green-100 ring-1 ring-inset ring-green-300/70 dark:ring-green-400/20',
    chipClass: 'border border-green-400/65 bg-green-100 text-green-700 dark:border-green-400/30 dark:bg-green-500/18 dark:text-green-100',
    textClass: 'text-green-600 dark:text-green-400'
  }
}
