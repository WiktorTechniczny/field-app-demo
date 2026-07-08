import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../supabase'
import { addOfflineSurvey } from '../offlineStore'
import { CONTRACT_CLAUSES, CONTRACT_SECTIONS, QS, type ContractSectionKey, type QDef } from '../questions'
import AppointmentPicker from '../components/AppointmentPicker'
import { APPOINTMENT_SLOTS, DEFAULT_SLOT_LIMIT, normalizeTimeSlot } from '../appointmentSlots'
import type { SalesMeeting } from '../db'
import {
    buildSalesMeetingRefusalNote,
    buildSalesMeetingRescheduledNote,
    buildSalesMeetingInProgressNote,
    getSalesMeetingCleanStatusNote,
    mapSurveyStatusToMeetingStatus
} from '../salesMeetingStatus'
import { APP_VERSION } from '../appMeta'
import { buildGoogleMapsDirectionsHref, buildPhoneHref } from '../contactLinks'
import {
    buildPrintableContractPacketHtml,
    formatContractPacketClientLabel,
    type ContractParty
} from '../contractPacket'

type Step = ContractSectionKey | 'summary' | 'success' | 'address' | 'questions' | 'personal'
type SurveySaveStatus = 'completed' | 'attempted' | 'refused' | 'not_home' | 'no_cooperation'
type PostMeetingStatus = Extract<SurveySaveStatus, 'refused'>
const slide = { enter: { opacity: 0, x: 40 }, center: { opacity: 1, x: 0 }, exit: { opacity: 0, x: -40 } }

// Reusable classes
const card = "bg-white dark:bg-slate-800 rounded-xl border border-gray-200/60 dark:border-slate-700 shadow-md overflow-hidden"
const input = "w-full border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 rounded-lg px-4 py-3 text-gray-900 dark:text-white text-sm placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 transition-all"
const inputError = "border-red-300 bg-red-50/70 placeholder-red-300 focus:border-red-500 focus:ring-red-500 dark:border-red-500/70 dark:bg-red-500/10 dark:placeholder-red-300/70"
const btnPrimary = "w-full bg-cyan-500 hover:bg-cyan-600 text-white font-semibold py-3 rounded-lg text-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
const btnBack = "bg-gray-100 dark:bg-slate-700 hover:bg-gray-200 dark:hover:bg-slate-600 text-gray-500 dark:text-gray-300 font-medium px-4 py-2.5 rounded-lg text-sm transition-colors"
const btnAbort = "w-full py-2.5 px-3 text-xs font-black text-cyan-700 dark:text-cyan-300 bg-cyan-50 dark:bg-cyan-500/10 hover:bg-cyan-100 dark:hover:bg-cyan-500/20 rounded-lg transition-all border border-cyan-300 dark:border-cyan-500/40 tracking-widest uppercase disabled:opacity-30 disabled:cursor-not-allowed"
const label = "text-sm text-gray-500 dark:text-gray-400 mb-1 block"
const sectionBg = "bg-gray-50 dark:bg-slate-700/50 rounded-lg p-3 border border-gray-100 dark:border-slate-600"
const AUDIO_BUCKET = 'survey-audio'
const AUDIO_RETENTION_DAYS = 5
const CONTRACT_TEMPLATE_VERSION_1K = 'legal_service_agreement_2026_1k_v1'
const CONTRACT_TEMPLATE_VERSION_3K = 'legal_service_agreement_2026_3k_v1'
const CONTRACT_BASE_FEE_HIGH_THRESHOLD = 3000
const ADDITIONAL_CONTRACT_PARTIES_FIELD = 'additional_contract_parties_json'
const BASE_FEE_OPTIONS = [
    { value: '1000', label: '1 000 zł' },
    { value: '3000', label: '3 000 zł' }
] as const

interface SurveyFormDraftState {
    answers: Record<string, string>
    step: Step
    coords: { lat: number; lng: number } | null
    attemptedNote: string
    attemptedPhone: string
    attemptedDate: string
    attemptedTime: string
    touchedContractFields: Record<string, boolean>
    showContractPreview: boolean
    showAttemptedStatusModal: boolean
    postMeetingStatus: PostMeetingStatus | null
    postMeetingStatusNote: string
    showPostMeetingStatusModal: boolean
}

type ContractTemplateVariant = '1k' | '3k'
type ContractTemplateMeta = {
    variant: ContractTemplateVariant
    version: string
    label: string
}

type ContractTextContext = {
    contractPlace: string
    propertyAddress: string
    propertyRegistryDetails: string
    correspondenceAddress: string
    clientPhone: string
    baseFeeAmount: string
    baseFeeWords: string
    successFeePercent: string
    successFeeWords: string
    representativeName: string
    contractDate: string
    template: ContractTemplateMeta
    parties: ContractParty[]
}

const isSafariLikeBrowser = (): boolean => {
    if (typeof navigator === 'undefined') return false
    const ua = navigator.userAgent
    const hasSafari = /Safari/i.test(ua)
    const hasChromiumFamily = /Chrome|Chromium|CriOS|Edg|OPR|SamsungBrowser|Android/i.test(ua)
    const isIOSWebKit = /iP(hone|ad|od)/i.test(ua) && !/CriOS|FxiOS|EdgiOS/i.test(ua)
    return (hasSafari && !hasChromiumFamily) || isIOSWebKit
}

const pickAudioMimeType = (): string => {
    if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') return ''
    // Non-Safari browsers handle webm->mp3 conversion more reliably than mp4.
    const preferred = isSafariLikeBrowser()
        ? ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
        : ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
    return preferred.find((type) => MediaRecorder.isTypeSupported(type)) || ''
}

const getAudioUploadMeta = (blob: Blob): { extension: string; contentType: string } => {
    const type = (blob.type || '').toLowerCase()

    if (type.includes('mpeg') || type.includes('mp3')) return { extension: 'mp3', contentType: 'audio/mpeg' }
    if (type.includes('mp4') || type.includes('m4a')) return { extension: 'm4a', contentType: 'audio/mp4' }
    if (type.includes('ogg')) return { extension: 'ogg', contentType: 'audio/ogg' }
    if (type.includes('wav')) return { extension: 'wav', contentType: 'audio/wav' }

    return { extension: 'webm', contentType: type || 'audio/webm' }
}

const toInt16Pcm = (input: Float32Array): Int16Array => {
    const out = new Int16Array(input.length)
    for (let i = 0; i < input.length; i += 1) {
        const s = Math.max(-1, Math.min(1, input[i]))
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    return out
}

const downmixToMono = (audioBuffer: AudioBuffer): Float32Array => {
    if (audioBuffer.numberOfChannels === 1) return audioBuffer.getChannelData(0)
    const left = audioBuffer.getChannelData(0)
    const right = audioBuffer.getChannelData(1)
    const mono = new Float32Array(audioBuffer.length)
    for (let i = 0; i < audioBuffer.length; i += 1) mono[i] = (left[i] + right[i]) * 0.5
    return mono
}

const convertBlobToMp3 = async (sourceBlob: Blob): Promise<Blob> => {
    if (typeof window === 'undefined') throw new Error('Brak wsparcia konwersji audio w tym srodowisku.')
    if (sourceBlob.type === 'audio/mpeg') return sourceBlob

    const audioCtxCtor = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
    if (!audioCtxCtor) throw new Error('Brak AudioContext w przegladarce.')

    const audioCtx = new audioCtxCtor()
    try {
        const arr = await sourceBlob.arrayBuffer()
        const decoded = await audioCtx.decodeAudioData(arr.slice(0))
        const mono = downmixToMono(decoded)
        const pcm = toInt16Pcm(mono)

        // Dynamic import to avoid loading encoder chunk before it is needed.
        const lameModule = await import('lamejs')
        const Mp3EncoderCtor =
            (lameModule as unknown as { Mp3Encoder?: new (channels: number, sampleRate: number, kbps: number) => { encodeBuffer: (pcm: Int16Array) => Int8Array; flush: () => Int8Array } }).Mp3Encoder ||
            (lameModule as unknown as { default?: { Mp3Encoder?: new (channels: number, sampleRate: number, kbps: number) => { encodeBuffer: (pcm: Int16Array) => Int8Array; flush: () => Int8Array } } }).default?.Mp3Encoder

        if (!Mp3EncoderCtor) {
            throw new Error('Brak Mp3Encoder w lamejs.')
        }

        const encoder = new Mp3EncoderCtor(1, decoded.sampleRate, 128)
        const mp3Chunks: Int8Array[] = []
        const blockSize = 1152

        for (let i = 0; i < pcm.length; i += blockSize) {
            const chunk = pcm.subarray(i, i + blockSize)
            const encoded = encoder.encodeBuffer(chunk)
            if (encoded.length > 0) mp3Chunks.push(new Int8Array(encoded))
        }

        const flush = encoder.flush()
        if (flush.length > 0) mp3Chunks.push(new Int8Array(flush))

        return new Blob(mp3Chunks as unknown as BlobPart[], { type: 'audio/mpeg' })
    } finally {
        await audioCtx.close()
    }
}

const parseSaveError = (error: unknown): { message: string; code?: string } => {
    if (error instanceof Error) {
        return { message: error.message || 'Wystapil nieznany blad podczas zapisu.' }
    }

    if (typeof error === 'string') {
        return { message: error }
    }

    if (error && typeof error === 'object') {
        const err = error as Record<string, unknown>
        const message = typeof err.message === 'string' ? err.message : ''
        const details = typeof err.details === 'string' ? err.details : ''
        const hint = typeof err.hint === 'string' ? err.hint : ''
        const code = typeof err.code === 'string' ? err.code : undefined
        const merged = [message, details, hint].filter(Boolean).join(' ').trim()
        return { message: merged || 'Wystapil nieznany blad podczas zapisu.', code }
    }

    return { message: 'Wystapil nieznany blad podczas zapisu.' }
}

const mapFriendlySaveError = (message: string): string => {
    const lower = message.toLowerCase()

    if ((lower.includes('check constraint') || lower.includes('violates check')) && (lower.includes('status') || lower.includes('surveys_status_check'))) {
        return 'Baza nie akceptuje jeszcze wszystkich statusow handlowca. Trzeba zaktualizowac constraint kolumny surveys.status.'
    }

    return message
}

const isNetworkSaveError = (error: unknown, message: string): boolean => {
    const lower = message.toLowerCase()
    if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('network request failed') || lower.includes('load failed')) {
        return true
    }

    return error instanceof TypeError && (lower.includes('fetch') || lower.includes('network'))
}

const getLocalTodayDateInput = (): string => {
    const now = new Date()
    const yyyy = now.getFullYear()
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    const dd = String(now.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
}

const getMeetingDateInput = (meeting?: SalesMeeting | null): string => {
    if (!meeting?.scheduled_at) return getLocalTodayDateInput()
    return new Date(meeting.scheduled_at).toLocaleDateString('sv-SE')
}

const getMeetingTimeInput = (meeting?: SalesMeeting | null): string => {
    if (!meeting?.scheduled_at) return ''
    return new Date(meeting.scheduled_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
}

const getNextFollowUpDateTime = (meeting?: SalesMeeting | null): { date: string; time: string } => {
    const fallbackDate = getMeetingDateInput(meeting)
    const fallbackTime = getMeetingTimeInput(meeting) || APPOINTMENT_SLOTS[0] || ''
    if (!meeting?.scheduled_at) return { date: fallbackDate, time: fallbackTime }

    const meetingDate = new Date(meeting.scheduled_at)
    if (Number.isNaN(meetingDate.getTime())) {
        return { date: fallbackDate, time: fallbackTime }
    }

    const currentDatePart = meetingDate.toLocaleDateString('sv-SE')
    const currentTimePart = meetingDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
    const currentSlotIndex = APPOINTMENT_SLOTS.findIndex((slot) => slot === currentTimePart)

    if (currentSlotIndex >= 0 && currentSlotIndex < APPOINTMENT_SLOTS.length - 1) {
        return {
            date: currentDatePart,
            time: APPOINTMENT_SLOTS[currentSlotIndex + 1]
        }
    }

    const nextDay = new Date(meetingDate.getFullYear(), meetingDate.getMonth(), meetingDate.getDate() + 1)
    return {
        date: nextDay.toLocaleDateString('sv-SE'),
        time: APPOINTMENT_SLOTS[0] || currentTimePart
    }
}

const getContractRepresentativeName = (rawName?: string | null): string => {
    const normalized = (rawName || '').trim()
    return normalized || '................................'
}

const isPostMeetingStatus = (value: string | null | undefined): value is PostMeetingStatus =>
    value === 'refused'

const postMeetingStatusRequiresNote = (status: PostMeetingStatus): boolean =>
    status === 'refused'

const getPostMeetingStatusTitle = (status: PostMeetingStatus): string => {
    switch (status) {
        case 'refused':
            return 'Formularz odmowy po przeprowadzonym spotkaniu'
        default:
            return 'Formularz statusu spotkania'
    }
}

const getPostMeetingStatusLabel = (status: PostMeetingStatus): string => {
    switch (status) {
        case 'refused':
            return 'Odmowa po spotkaniu'
        default:
            return 'Status spotkania'
    }
}

const getPostMeetingStatusDescription = (status: PostMeetingStatus): string => {
    switch (status) {
        case 'refused':
            return 'Rozmowa została przeprowadzona, ale klient odmówił dalszych działań.'
        default:
            return ''
    }
}

const getPostMeetingStatusNoteLabel = (status: PostMeetingStatus): string => {
    switch (status) {
        case 'refused':
            return 'Notatka do odmowy po spotkaniu'
        default:
            return 'Notatka'
    }
}

const getPostMeetingStatusPlaceholder = (status: PostMeetingStatus): string => {
    switch (status) {
        case 'refused':
            return 'Opisz powód odmowy po przeprowadzonym spotkaniu'
        default:
            return 'Dodaj notatkę'
    }
}

const buildLocalDateTime = (datePart: string, timePart: string): Date | null => {
    if (!datePart || !timePart) return null
    const [year, month, day] = datePart.split('-').map(Number)
    const [hours, minutes] = timePart.split(':').map(Number)
    const date = new Date(year, month - 1, day, hours, minutes, 0, 0)
    return Number.isNaN(date.getTime()) ? null : date
}

const isMobileRecordingDevice = (): boolean => {
    if (typeof navigator === 'undefined') return false
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}

const SMALL_NUMBER_WORDS = ['zero', 'jeden', 'dwa', 'trzy', 'cztery', 'pięć', 'sześć', 'siedem', 'osiem', 'dziewięć']
const TEEN_NUMBER_WORDS = ['dziesięć', 'jedenaście', 'dwanaście', 'trzynaście', 'czternaście', 'piętnaście', 'szesnaście', 'siedemnaście', 'osiemnaście', 'dziewiętnaście']
const TENS_NUMBER_WORDS = ['', '', 'dwadzieścia', 'trzydzieści', 'czterdzieści', 'pięćdziesiąt', 'sześćdziesiąt', 'siedemdziesiąt', 'osiemdziesiąt', 'dziewięćdziesiąt']
const HUNDREDS_NUMBER_WORDS = ['', 'sto', 'dwieście', 'trzysta', 'czterysta', 'pięćset', 'sześćset', 'siedemset', 'osiemset', 'dziewięćset']
const GROUP_WORD_FORMS: Array<[string, string, string] | null> = [
    null,
    ['tysiąc', 'tysiące', 'tysięcy'],
    ['milion', 'miliony', 'milionów'],
    ['miliard', 'miliardy', 'miliardów']
]

const getPluralWordForm = (value: number, forms: [string, string, string]): string => {
    const absValue = Math.abs(value)
    if (absValue === 1) return forms[0]

    const mod10 = absValue % 10
    const mod100 = absValue % 100
    if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return forms[1]

    return forms[2]
}

const convertTripletToWords = (value: number): string => {
    const parts: string[] = []
    const hundreds = Math.floor(value / 100)
    const tensAndUnits = value % 100
    const tens = Math.floor(tensAndUnits / 10)
    const units = tensAndUnits % 10

    if (hundreds > 0) parts.push(HUNDREDS_NUMBER_WORDS[hundreds])

    if (tensAndUnits >= 10 && tensAndUnits < 20) {
        parts.push(TEEN_NUMBER_WORDS[tensAndUnits - 10])
    } else {
        if (tens > 1) parts.push(TENS_NUMBER_WORDS[tens])
        if (units > 0) parts.push(SMALL_NUMBER_WORDS[units])
    }

    return parts.join(' ')
}

const convertIntegerToPolishWords = (rawValue: number): string => {
    const value = Math.floor(Math.abs(rawValue))
    if (value === 0) return SMALL_NUMBER_WORDS[0]

    const parts: string[] = []
    let remaining = value
    let groupIndex = 0

    while (remaining > 0) {
        const groupValue = remaining % 1000
        if (groupValue > 0) {
            if (groupIndex === 1 && groupValue === 1) {
                parts.unshift('tysiąc')
            } else {
                const groupWords = convertTripletToWords(groupValue)
                const forms = GROUP_WORD_FORMS[groupIndex]
                if (forms) {
                    parts.unshift(getPluralWordForm(groupValue, forms))
                }
                if (groupWords) {
                    parts.unshift(groupWords)
                }
            }
        }

        remaining = Math.floor(remaining / 1000)
        groupIndex += 1
    }

    return parts.join(' ').trim()
}

const parsePolishDecimal = (rawValue: string): number | null => {
    const trimmed = rawValue.trim()
    if (!trimmed) return null

    let normalized = trimmed
        .replace(/\s+/g, '')
        .replace(/[zł%]/gi, '')
        .replace(/,/g, '.')
        .replace(/[^\d.]/g, '')

    const dotParts = normalized.split('.')
    if (dotParts.length > 2) {
        const decimalPart = dotParts.pop() || ''
        normalized = `${dotParts.join('')}.${decimalPart}`
    }

    if (!normalized || normalized === '.') return null

    const parsed = Number(normalized)
    if (!Number.isFinite(parsed) || parsed < 0) return null

    return parsed
}

const formatMoneyWords = (rawValue: string): string => {
    const parsed = parsePolishDecimal(rawValue)
    if (parsed === null) return '................................'

    const totalGrosze = Math.round(parsed * 100)
    const zlote = Math.floor(totalGrosze / 100)
    const grosze = totalGrosze % 100
    const zloteWords = convertIntegerToPolishWords(zlote)
    const zloteLabel = getPluralWordForm(zlote, ['złoty', 'złote', 'złotych'])

    return `${zloteWords} ${zloteLabel} ${String(grosze).padStart(2, '0')}/100`
}

const formatMoneyAmountDisplay = (rawValue: string): string => {
    const parsed = parsePolishDecimal(rawValue)
    if (parsed === null) return '................................'

    return parsed.toLocaleString('pl-PL', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
    })
}

const formatPercentWords = (rawValue: string): string => {
    const parsed = parsePolishDecimal(rawValue)
    if (parsed === null) return '................................'

    const totalParts = Math.round(parsed * 100)
    const wholePart = Math.floor(totalParts / 100)
    const decimalPart = totalParts % 100
    const wholeWords = convertIntegerToPolishWords(wholePart)

    if (decimalPart === 0) {
        return `${wholeWords} ${getPluralWordForm(wholePart, ['procent', 'procenty', 'procent'])}`
    }

    return `${wholeWords} i ${String(decimalPart).padStart(2, '0')}/100 procent`
}

type AdditionalContractPartyDraft = {
    id: string
    fullName: string
    pesel: string
    address: string
}

const createAdditionalContractPartyDraft = (): AdditionalContractPartyDraft => ({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    fullName: '',
    pesel: '',
    address: ''
})

const normalizeAdditionalContractPartyDraft = (value: unknown): AdditionalContractPartyDraft | null => {
    if (!value || typeof value !== 'object') return null

    const record = value as Record<string, unknown>

    return {
        id:
            typeof record.id === 'string' && record.id.trim()
                ? record.id.trim()
                : `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        fullName: typeof record.fullName === 'string' ? record.fullName : '',
        pesel: typeof record.pesel === 'string' ? record.pesel.replace(/\D/g, '').slice(0, 11) : '',
        address: typeof record.address === 'string' ? record.address : ''
    }
}

const parseAdditionalContractParties = (answers: Record<string, string>): AdditionalContractPartyDraft[] => {
    const rawValue = answers[ADDITIONAL_CONTRACT_PARTIES_FIELD]?.trim()
    if (!rawValue) return []

    try {
        const parsed = JSON.parse(rawValue)
        if (!Array.isArray(parsed)) return []
        return parsed
            .map((item) => normalizeAdditionalContractPartyDraft(item))
            .filter((item): item is AdditionalContractPartyDraft => Boolean(item))
    } catch {
        return []
    }
}

const serializeAdditionalContractParties = (parties: AdditionalContractPartyDraft[]): string =>
    JSON.stringify(
        parties.map((party) => ({
            id: party.id,
            fullName: party.fullName.trim(),
            pesel: party.pesel.replace(/\D/g, '').slice(0, 11),
            address: party.address.trim()
        }))
    )

const sanitizeAdditionalContractPartyValue = (
    field: keyof Omit<AdditionalContractPartyDraft, 'id'>,
    value: string
): string => {
    if (field === 'pesel') {
        return value.replace(/\D/g, '').slice(0, 11)
    }

    return value
}

const getAdditionalContractPartyValidationError = (party: AdditionalContractPartyDraft): string | null => {
    const hasAnyValue = Boolean(party.fullName.trim() || party.pesel.trim() || party.address.trim())
    if (!hasAnyValue) return null
    if (!party.fullName.trim()) return 'Uzupełnij imię i nazwisko dodatkowej osoby podpisującej.'
    if (party.pesel.replace(/\D/g, '').length !== 11) return 'PESEL dodatkowej osoby podpisującej musi mieć 11 cyfr.'
    return null
}

const buildContractParties = (answers: Record<string, string>): ContractParty[] => {
    const sharedAddress = getAnswerValue(answers, 'correspondence_address') || getAnswerValue(answers, 'property_address') || '................................'
    const primaryParty: ContractParty = {
        fullName: getAnswerValue(answers, 'client_name') || '................................',
        pesel: getAnswerValue(answers, 'client_pesel') || '................................',
        address: sharedAddress,
        phone: getAnswerValue(answers, 'client_phone') || ''
    }

    const additionalParties = parseAdditionalContractParties(answers)
        .filter((party) => party.fullName.trim() || party.pesel.trim() || party.address.trim())
        .map<ContractParty>((party) => ({
            fullName: party.fullName.trim() || '................................',
            pesel: party.pesel.trim() || '................................',
            address: party.address.trim() || sharedAddress,
            phone: ''
        }))

    return [primaryParty, ...additionalParties]
}

const buildContractPartyLines = (parties: ContractParty[]): string[] => {
    if (parties.length <= 1) {
        const primaryParty = parties[0] || {
            fullName: '................................',
            pesel: '................................',
            address: '................................',
            phone: ''
        }

        return [
            primaryParty.fullName,
            `PESEL: ${primaryParty.pesel}`,
            `Adres do korespondencji: ${primaryParty.address}`,
            `Nr telefonu kontaktowego: ${primaryParty.phone || '................................'}`
        ]
    }

    return parties.flatMap((party, index) => {
        const lines = [
            `${index + 1}. ${party.fullName}`,
            `   PESEL: ${party.pesel}`,
            `   Adres do korespondencji: ${party.address}`
        ]

        if (party.phone) {
            lines.push(`   Nr telefonu kontaktowego: ${party.phone}`)
        }

        return lines
    })
}

const createInitialAnswers = (meeting?: SalesMeeting | null): Record<string, string> => ({
    contract_date: getMeetingDateInput(meeting),
    contract_place: '',
    client_name: meeting?.client_name || '',
    client_pesel: '',
    client_phone: meeting?.phone || '',
    [ADDITIONAL_CONTRACT_PARTIES_FIELD]: '',
    property_address: meeting?.address || '',
    property_registry_details: '',
    correspondence_address: '',
    base_fee_amount: '',
    success_fee_percent: ''
})

const formatContractDate = (value?: string): string => {
    if (!value) return '................................'
    return new Date(`${value}T00:00:00`).toLocaleDateString('pl-PL')
}

const getAnswerValue = (answers: Record<string, string>, id: string): string => answers[id]?.trim() || ''

const sanitizeContractFieldInput = (fieldId: string, rawValue: string): string => {
    if (fieldId === 'client_pesel') {
        return rawValue.replace(/\D/g, '').slice(0, 11)
    }

    if (fieldId === 'base_fee_amount') {
        return rawValue.replace(/[^\d\s,.]/g, '')
    }

    if (fieldId === 'success_fee_percent') {
        return rawValue.replace(/[^\d,.]/g, '')
    }

    return rawValue
}

const getFieldValidationError = (field: QDef, answers: Record<string, string>): string | null => {
    const value = getAnswerValue(answers, field.id)

    if (field.required && !value) return 'To pole jest wymagane.'

    if (!value) return null

    if (field.id === 'client_pesel' && value.replace(/\D/g, '').length !== 11) {
        return 'PESEL musi mieć 11 cyfr.'
    }

    if (field.id === 'client_phone' && value.replace(/\D/g, '').length < 9) {
        return 'Numer telefonu jest za krótki.'
    }

    return null
}

const getContractFieldValidationError = (field: QDef, answers: Record<string, string>): string | null => {
    const value = getAnswerValue(answers, field.id)

    if (field.required && !value) return 'To pole jest wymagane.'
    if (!value) return null
    if (field.id === 'client_pesel' && value.replace(/\D/g, '').length !== 11) return 'PESEL musi mieć 11 cyfr.'
    if (field.id === 'client_phone' && value.replace(/\D/g, '').length < 9) return 'Numer telefonu jest za krótki.'
    if (field.id === 'base_fee_amount' && !/\d/.test(value)) return 'Podaj kwotę wynagrodzenia podstawowego.'

    if (field.id === 'success_fee_percent') {
        const normalizedValue = value.replace(',', '.')
        const percentValue = Number(normalizedValue)
        if (!Number.isFinite(percentValue) || percentValue <= 0 || percentValue > 100) {
            return 'Podaj procent premii za sukces w zakresie od 0 do 100.'
        }
    }

    return null
}

const isStepComplete = (section: ContractSectionKey, answers: Record<string, string>): boolean => (
    QS.filter((field) => field.section === section).every((field) => getContractFieldValidationError(field, answers) === null)
)

const buildContractSnapshot = (answers: Record<string, string>, representativeName: string): string => {
    const clientName = getAnswerValue(answers, 'client_name') || '................................'
    const pesel = getAnswerValue(answers, 'client_pesel') || '................................'
    const contractPlace = getAnswerValue(answers, 'contract_place') || '................................'
    const propertyAddress = getAnswerValue(answers, 'property_address') || '................................'
    const propertyRegistryDetails = getAnswerValue(answers, 'property_registry_details') || '................................'
    const correspondenceAddress = getAnswerValue(answers, 'correspondence_address') || 'nie wskazano'
    const clientPhone = getAnswerValue(answers, 'client_phone') || '................................'
    const baseFeeAmount = getAnswerValue(answers, 'base_fee_amount') || '................................'
    const baseFeeWords = formatMoneyWords(getAnswerValue(answers, 'base_fee_amount'))
    const successFeePercent = getAnswerValue(answers, 'success_fee_percent') || '................................'
    const successFeeWords = formatPercentWords(getAnswerValue(answers, 'success_fee_percent'))

    return [
        'UMOWA O SWIADCZENIE POMOCY PRAWNEJ',
        `zawarta w dniu ${formatContractDate(answers.contract_date)} roku w ${contractPlace}.`,
        'Pomiedzy:',
        `Demo Services spolka z ograniczona odpowiedzialnoscia z siedziba w Warszawie (00-000) przy ulicy Przykladowej 1, reprezentowana przez ${representativeName} - pelnomocnika, adres e-mail: kontakt@example.test, zwana dalej "Kancelaria".`,
        `A Klientem: ${clientName}, PESEL: ${pesel}, adres nieruchomosci: ${propertyAddress}, nr KW / dzialki / obreb / gmina: ${propertyRegistryDetails}, adres do korespondencji: ${correspondenceAddress}, nr telefonu: ${clientPhone}.`,
        '',
        '§ 1. Przedmiot umowy',
        ...CONTRACT_CLAUSES.subject.map((item, index) => `${index + 1}. ${item}`),
        '',
        '§ 2. Wynagrodzenie',
        `1. Wynagrodzenie podstawowe: ${baseFeeAmount} zl brutto (slownie: ${baseFeeWords}).`,
        ...CONTRACT_CLAUSES.remuneration.map((item, index) => `${index + 2}. ${item}`),
        '',
        '§ 3. Wynagrodzenie success fee',
        `1. Success fee: ${successFeePercent}% brutto (slownie: ${successFeeWords}).`,
        ...CONTRACT_CLAUSES.successFee.map((item, index) => `${index + 2}. ${item}`)
    ].join('\n')
}

const buildExpandedContractSnapshot = (answers: Record<string, string>, representativeName: string): string => {
    const clientName = getAnswerValue(answers, 'client_name') || '................................'
    const pesel = getAnswerValue(answers, 'client_pesel') || '................................'
    const contractPlace = getAnswerValue(answers, 'contract_place') || '................................'
    const propertyAddress = getAnswerValue(answers, 'property_address') || '................................'
    const propertyRegistryDetails = getAnswerValue(answers, 'property_registry_details') || '................................'
    const correspondenceAddress = getAnswerValue(answers, 'correspondence_address') || 'nie wskazano'
    const clientPhone = getAnswerValue(answers, 'client_phone') || '................................'
    const baseFeeAmount = getAnswerValue(answers, 'base_fee_amount') || '................................'
    const baseFeeWords = formatMoneyWords(getAnswerValue(answers, 'base_fee_amount'))
    const successFeePercent = getAnswerValue(answers, 'success_fee_percent') || '................................'
    const successFeeWords = formatPercentWords(getAnswerValue(answers, 'success_fee_percent'))
    const subjectBullets = CONTRACT_CLAUSES.subject.slice(1, 6)
    const subjectClosing = CONTRACT_CLAUSES.subject.slice(6)
    const successFeeBullets = CONTRACT_CLAUSES.successFee.slice(1, 5)

    return [
        'UMOWA O ŚWIADCZENIE POMOCY PRAWNEJ',
        `zawarta w dniu ${formatContractDate(answers.contract_date)} roku w ${contractPlace} pomiędzy:`,
        `Demo Services sp. z o.o. z siedzibą w Warszawie (00-000) przy ulicy Przykladowej 1, wpisaną do Rejestru Przedsiębiorców Krajowego Rejestru Sądowego przez Sąd Rejonowy dla m.st. Warszawy w Warszawie XII Wydział Gospodarczy Krajowego Rejestru Sądowego, KRS 0000000000, NIP 0000000000, REGON 000000000, o kapitale zakładowym w wysokości 5.000,00 zł, reprezentowaną przez: ${representativeName} - pełnomocnika, adres e-mail: kontakt@example.test`,
        'zwaną dalej "Kancelarią"',
        'a',
        `${clientName}`,
        `PESEL: ${pesel}`,
        `Adres nieruchomości, której dotyczy roszczenie: ${propertyAddress}`,
        `NR KW lub nr działki; obręb; gmina: ${propertyRegistryDetails}`,
        `Adres do korespondencji, jeśli jest inny: ${correspondenceAddress}`,
        `Nr telefonu kontaktowego: ${clientPhone}`,
        'zwaną dalej "Klientem",',
        'zawarta zostaje umowa o następującej treści:',
        '',
        '§ 1. Przedmiot umowy',
        `1. ${CONTRACT_CLAUSES.subject[0]}`,
        ...subjectBullets.map((item) => `   * ${item}`),
        ...subjectClosing.map((item, index) => `${index + 2}. ${item}`),
        '',
        '§ 2. Wynagrodzenie',
        `1. Strony ustalają wynagrodzenie podstawowe należne Kancelarii za prowadzenie sprawy w wysokości ${baseFeeAmount} zł brutto (słownie: ${baseFeeWords} brutto).`,
        `2. ${CONTRACT_CLAUSES.remuneration[0]}`,
        `3. ${CONTRACT_CLAUSES.remuneration[1]}`,
        `4. Strony zgodnie ustalają, że wynagrodzenie podstawowe w kwocie ${baseFeeAmount} zł brutto uiszczone przez Klienta obejmuje przeprowadzenie przez Kancelarię wstępnej analizy stanu faktycznego i prawnego sprawy w zakresie istnienia i zasadności roszczeń Klienta.`,
        `5. ${CONTRACT_CLAUSES.remuneration[3]}`,
        `6. W przypadku, gdy z przeprowadzonej analizy będzie wynikać, że Klientowi nie przysługują roszczenia, o których mowa w § 1 Umowy, Kancelaria zobowiązuje się do zwrotu Klientowi całości uiszczonego wynagrodzenia podstawowego w kwocie ${baseFeeAmount} zł brutto, w terminie 14 dni od dnia przekazania Klientowi pisemnej informacji o wyniku analizy.`,
        `7. ${CONTRACT_CLAUSES.remuneration[5]}`,
        `8. ${CONTRACT_CLAUSES.remuneration[6]}`,
        '',
        '§ 3. Wynagrodzenie success fee',
        `1. Niezależnie od wynagrodzenia podstawowego Kancelarii przysługuje wynagrodzenie dodatkowe - premia za sukces (success fee) w wysokości: ${successFeePercent}% (${successFeeWords}) brutto.`,
        `2. ${CONTRACT_CLAUSES.successFee[0]}`,
        ...successFeeBullets.map((item) => `   * ${item}`),
        `3. ${CONTRACT_CLAUSES.successFee[5]}`,
        `4. ${CONTRACT_CLAUSES.successFee[6]}`,
        `5. ${CONTRACT_CLAUSES.successFee[7]}`
    ].join('\n')
}

const resolveSelectedContractTemplate = (answers: Record<string, string>): ContractTemplateMeta => {
    const baseFeeAmount = parsePolishDecimal(getAnswerValue(answers, 'base_fee_amount'))

    if (baseFeeAmount !== null && baseFeeAmount >= CONTRACT_BASE_FEE_HIGH_THRESHOLD) {
        return {
            variant: '3k',
            version: CONTRACT_TEMPLATE_VERSION_3K,
            label: '3 tys.'
        }
    }

    return {
        variant: '1k',
        version: CONTRACT_TEMPLATE_VERSION_1K,
        label: '1 tys.'
    }
}

const buildResolvedContractTextContext = (answers: Record<string, string>, representativeName: string): ContractTextContext => ({
    contractPlace: getAnswerValue(answers, 'contract_place') || '................................',
    propertyAddress: getAnswerValue(answers, 'property_address') || '................................',
    propertyRegistryDetails: getAnswerValue(answers, 'property_registry_details') || '................................',
    correspondenceAddress: getAnswerValue(answers, 'correspondence_address') || 'nie wskazano',
    clientPhone: getAnswerValue(answers, 'client_phone') || '................................',
    baseFeeAmount: formatMoneyAmountDisplay(getAnswerValue(answers, 'base_fee_amount')),
    baseFeeWords: formatMoneyWords(getAnswerValue(answers, 'base_fee_amount')),
    successFeePercent: getAnswerValue(answers, 'success_fee_percent') || '................................',
    successFeeWords: formatPercentWords(getAnswerValue(answers, 'success_fee_percent')),
    representativeName,
    contractDate: formatContractDate(answers.contract_date),
    template: resolveSelectedContractTemplate(answers),
    parties: buildContractParties(answers)
})

const buildResolvedContractSnapshot = (answers: Record<string, string>, representativeName: string): string => {
    const context = buildResolvedContractTextContext(answers, representativeName)
    const subjectBullets = CONTRACT_CLAUSES.subject.slice(1, 6)
    const subjectClosing = CONTRACT_CLAUSES.subject.slice(6)
    const successFeeBullets = CONTRACT_CLAUSES.successFee.slice(1, 5)

    const remunerationSection =
        context.template.variant === '3k'
            ? [
                  '§ 2. Wynagrodzenie',
                  `1. Strony ustalają wynagrodzenie podstawowe należne Kancelarii za prowadzenie sprawy w wysokości ${context.baseFeeAmount} zł brutto (słownie: ${context.baseFeeWords} brutto).`,
                  '2. Wynagrodzenie podstawowe obejmuje w szczególności:',
                  '   * analizę stanu faktycznego i prawnego sprawy,',
                  '   * ocenę zasadności roszczeń,',
                  '   * sporządzenie i prowadzenie korespondencji przedsądowej,',
                  '   * negocjacje z przedsiębiorstwem przesyłowym,',
                  '   * sporządzanie pism procesowych,',
                  '   * reprezentację Klienta w postępowaniu sądowym,',
                  '   * czynności związane z organizacją i sporządzeniem prywatnej opinii rzeczoznawcy zgodnie z § 4 Umowy.',
                  '3. Wynagrodzenie, o którym mowa w ust. 1 może zostać uiszczone jednorazowo albo w dwóch ratach, zgodnie z indywidualnym ustaleniem stron. Płatność zostanie dokonana na rachunek bankowy Kancelarii, który jest prowadzony w mBank S.A. o numerze 18 1140 2004 0000 3102 8630 4220.',
                  `4. Strony zgodnie ustalają, że wynagrodzenie podstawowe w kwocie ${context.baseFeeAmount} zł brutto uiszczone przez Klienta obejmuje przeprowadzenie przez Kancelarię wstępnej analizy stanu faktycznego i prawnego sprawy w zakresie istnienia i zasadności roszczeń Klienta.`,
                  `5. ${CONTRACT_CLAUSES.remuneration[3]}`,
                  `6. W przypadku, gdy z przeprowadzonej analizy będzie wynikać, że Klientowi nie przysługują roszczenia, o których mowa w § 1 Umowy, Kancelaria zobowiązuje się do zwrotu Klientowi całości uiszczonego wynagrodzenia podstawowego w kwocie ${context.baseFeeAmount} zł brutto, w terminie 14 dni od dnia przekazania Klientowi pisemnej informacji o wyniku analizy.`,
                  `7. ${CONTRACT_CLAUSES.remuneration[5]}`,
                  `8. ${CONTRACT_CLAUSES.remuneration[6]}`
              ]
            : [
                  '§ 2. Wynagrodzenie',
                  `1. Strony ustalają wynagrodzenie podstawowe należne Kancelarii za prowadzenie sprawy w wysokości ${context.baseFeeAmount} zł brutto (słownie: ${context.baseFeeWords} brutto).`,
                  `2. ${CONTRACT_CLAUSES.remuneration[0]}`,
                  `3. ${CONTRACT_CLAUSES.remuneration[1]}`,
                  `4. Strony zgodnie ustalają, że wynagrodzenie podstawowe w kwocie ${context.baseFeeAmount} zł brutto uiszczone przez Klienta obejmuje przeprowadzenie przez Kancelarię wstępną analizę stanu faktycznego i prawnego sprawy w zakresie istnienia i zasadności roszczeń Klienta.`,
                  `5. ${CONTRACT_CLAUSES.remuneration[3]}`,
                  `6. W przypadku, gdy z przeprowadzonej analizy będzie wynikać, że Klientowi nie przysługują roszczenia, o których mowa w § 1 Umowy, Kancelaria zobowiązuje się do zwrotu Klientowi całości uiszczonego wynagrodzenia podstawowego w kwocie ${context.baseFeeAmount} zł brutto, w terminie 14 dni od dnia przekazania Klientowi pisemnej informacji o wyniku analizy.`,
                  `7. ${CONTRACT_CLAUSES.remuneration[5]}`,
                  `8. ${CONTRACT_CLAUSES.remuneration[6]}`
              ]

    const costsSection =
        context.template.variant === '3k'
            ? [
                  '§ 4. Koszty etapu przedsądowego i sądowego',
                  '1. W ramach wynagrodzenia podstawowego określonego w § 2 ust. 1 Umowy Kancelaria pokrywa koszty sporządzenia prywatnej opinii rzeczoznawcy majątkowego lub innego specjalisty, jeżeli sporządzenie takiej opinii zostanie uznane przez Kancelarię za celowe dla prawidłowego dochodzenia roszczeń objętych Umową.',
                  '2. W ramach zobowiązania, o którym mowa w ust. 1, Kancelaria pokrywa również koszty uzyskania dokumentów niezbędnych do sporządzenia opinii, w szczególności:',
                  '   * wypisów i wyrysów z ewidencji gruntów,',
                  '   * map zasadniczych,',
                  '   * map do celów prawnych,',
                  '   * dokumentów z państwowego zasobu geodezyjnego i kartograficznego,',
                  '   * innych dokumentów wymaganych przez rzeczoznawcę do sporządzenia operatu szacunkowego.',
                  '3. Koszty, o których mowa w ust. 1 i 2, nie podlegają zwrotowi przez Klienta, niezależnie od wyniku sprawy.',
                  '4. W celu uniknięcia wątpliwości Strony postanawiają, że wynagrodzenie podstawowe, o którym mowa w § 2 ust. 1 Umowy, nie obejmuje kosztów postępowania sądowego, w szczególności:',
                  '   * opłat sądowych,',
                  '   * opłat skarbowych,',
                  '   * zaliczek na opinię biegłego sądowego,',
                  '   * innych opłat wymaganych przez sąd.',
                  '5. Koszty wskazane w ust. 4 ponosi Klient.',
                  '6. Kancelaria poinformuje Klienta o przewidywanej wysokości istotnych kosztów przed ich poniesieniem, o ile będzie to możliwe na danym etapie sprawy.'
              ]
            : [
                  '§ 4. Koszty prowadzenia sprawy',
                  '1. Klient ponosi wszelkie koszty związane z prowadzeniem sprawy, zarówno na etapie przedsądowym, jak i sądowym.',
                  '2. Koszty, o których mowa w ust. 1, obejmują w szczególności:',
                  '   * opłaty sądowe i skarbowe,',
                  '   * zaliczki na opinię biegłego sądowego,',
                  '   * koszty sporządzenia prywatnej opinii rzeczoznawcy majątkowego (operatu szacunkowego),',
                  '   * koszty opinii geodezyjnych i innych opinii specjalistycznych,',
                  '   * koszty uzyskania dokumentów urzędowych, w tym wypisów i wyrysów z ewidencji gruntów, map zasadniczych, map do celów prawnych, odpisów ksiąg wieczystych,',
                  '   * koszty uzyskania dokumentów z państwowego zasobu geodezyjnego i kartograficznego,',
                  '   * koszty notarialne,',
                  '   * inne niezbędne wydatki związane z dochodzeniem roszczeń.',
                  '3. Koszty, o których mowa w niniejszym paragrafie, nie są objęte wynagrodzeniem określonym w § 2 i § 3 Umowy.',
                  '4. W przypadku poniesienia przez Kancelarię jakichkolwiek kosztów wskazanych w ust. 1 Klient zobowiązany jest do ich zwrotu w terminie 7 dni od dnia doręczenia wezwania do zapłaty.',
                  '5. Kancelaria nie ponosi odpowiedzialności za skutki wynikłe z braku uregulowania przez Klienta lub opóźnienia w uregulowaniu opłat wymienionych powyżej.',
                  '6. Kancelaria poinformuje Klienta o przewidywanej wysokości istotnych kosztów przed ich poniesieniem, o ile będzie to możliwe na danym etapie sprawy.',
                  '7. Kancelaria w każdym przypadku ma prawo ubiegać się o zwrot poniesionych kosztów zastępstwa procesowego od strony przeciwnej, zgodnie z przepisami określonymi w Rozporządzeniu Ministra Sprawiedliwości w sprawie opłat za czynności adwokackie z dnia 22 października 2015 roku (t.j. Dz. U. z 2023 poz. 1964), a przyznane lub zasądzone od strony przeciwnej koszty zastępstwa procesowego każdorazowo stanowić będą dodatkowe wynagrodzenie Kancelarii (ponad wynagrodzenie, o którym mowa w § 2 i § 3).'
              ]

    return [
        'UMOWA O ŚWIADCZENIE POMOCY PRAWNEJ',
        `zawarta w dniu ${context.contractDate} roku w ${context.contractPlace} pomiędzy:`,
        `Demo Services sp. z o.o. z siedzibą w Warszawie (00-000) przy ulicy Przykladowej 1, wpisaną do Rejestru Przedsiębiorców Krajowego Rejestru Sądowego przez Sąd Rejonowy dla m.st. Warszawy w Warszawie XII Wydział Gospodarczy Krajowego Rejestru Sądowego, KRS 0000000000, NIP 0000000000, REGON 000000000, o kapitale zakładowym w wysokości 5.000,00 zł, reprezentowaną przez: ${context.representativeName} - pełnomocnika, adres e-mail: kontakt@example.test`,
        'zwaną dalej "Kancelarią"',
        'a',
        ...buildContractPartyLines(context.parties),
        `Adres nieruchomości, której dotyczy roszczenie: ${context.propertyAddress}`,
        `NR KW lub nr działki; obręb; gmina: ${context.propertyRegistryDetails}`,
        `Adres do korespondencji, jeśli jest inny: ${context.correspondenceAddress}`,
        `Nr telefonu kontaktowego: ${context.clientPhone}`,
        'zwaną dalej "Klientem",',
        'zawarta zostaje umowa o następującej treści:',
        '',
        '§ 1. Przedmiot umowy',
        `1. ${CONTRACT_CLAUSES.subject[0]}`,
        ...subjectBullets.map((item) => `   * ${item}`),
        ...subjectClosing.map((item, index) => `${index + 2}. ${item}`),
        '',
        ...remunerationSection,
        '',
        '§ 3. Wynagrodzenie success fee',
        `1. Niezależnie od wynagrodzenia podstawowego Kancelarii przysługuje wynagrodzenie dodatkowe - premia za sukces (success fee) w wysokości: ${context.successFeePercent}% (${context.successFeeWords}) brutto.`,
        `2. ${CONTRACT_CLAUSES.successFee[0]}`,
        ...successFeeBullets.map((item) => `   * ${item}`),
        `3. ${CONTRACT_CLAUSES.successFee[5]}`,
        `4. ${CONTRACT_CLAUSES.successFee[6]}`,
        `5. ${CONTRACT_CLAUSES.successFee[7]}`,
        '',
        ...costsSection
    ].join('\n')
}

const formatContractSummaryValue = (fieldId: string, value: string): string => {
    if (!value) return '-'

    if (fieldId === 'base_fee_amount') {
        const option = BASE_FEE_OPTIONS.find((item) => item.value === value)
        return option?.label ?? `${value} zł`
    }

    return value
}

void getFieldValidationError
void buildContractSnapshot
void buildExpandedContractSnapshot

const parseMeetingStartedAt = (value?: string | null): number | null => {
    if (!value) return null
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
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

const getAudioBlobDurationSeconds = async (sourceBlob: Blob): Promise<number | null> => {
    if (typeof window === 'undefined') return null

    const audioCtxCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!audioCtxCtor) return null

    const audioCtx = new audioCtxCtor()
    try {
        const arrayBuffer = await sourceBlob.arrayBuffer()
        const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0))
        if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) return null
        return Math.max(1, Math.round(decoded.duration))
    } catch (error) {
        console.warn('Nie udalo sie wyliczyc dlugosci nagrania audio:', error)
        return null
    } finally {
        await audioCtx.close()
    }
}

const formatTranscriptOffset = (offsetMs: number): string => {
    const totalSeconds = Math.max(0, Math.floor(offsetMs / 1000))
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60

    if (hours > 0) {
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    }

    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

interface SurveyAudioSessionState {
    mediaRecorder: MediaRecorder | null
    mediaStream: MediaStream | null
    recorderStartId: number
    stopResolver: ((blob: Blob | null) => void) | null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition: any
    transcript: string
    transcriptStartedAt: number | null
    transcriptionStartTimeout: number | null
    keepTranscriptionAlive: boolean
    startPromise: Promise<void> | null
}

const surveyAudioSessionState: SurveyAudioSessionState = {
    mediaRecorder: null,
    mediaStream: null,
    recorderStartId: 0,
    stopResolver: null,
    recognition: null,
    transcript: '',
    transcriptStartedAt: null,
    transcriptionStartTimeout: null,
    keepTranscriptionAlive: false,
    startPromise: null
}

const clearSurveyAudioTranscriptionStartTimeout = () => {
    if (surveyAudioSessionState.transcriptionStartTimeout !== null) {
        window.clearTimeout(surveyAudioSessionState.transcriptionStartTimeout)
        surveyAudioSessionState.transcriptionStartTimeout = null
    }
}

const startSurveyAudioTranscription = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any
    const SpeechRecAPI = w.SpeechRecognition || w.webkitSpeechRecognition
    if (!SpeechRecAPI) return

    surveyAudioSessionState.keepTranscriptionAlive = true
    clearSurveyAudioTranscriptionStartTimeout()

    const beginRecognition = () => {
        if (!surveyAudioSessionState.keepTranscriptionAlive) return
        if (surveyAudioSessionState.mediaRecorder?.state !== 'recording') return

        try {
            if (surveyAudioSessionState.recognition) {
                try { surveyAudioSessionState.recognition.stop() } catch { /* ignore */ }
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rec = new SpeechRecAPI() as any
            rec.lang = 'pl-PL'
            rec.continuous = true
            rec.interimResults = false
            rec.maxAlternatives = 1
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            rec.onresult = (event: any) => {
                for (let i = event.resultIndex; i < event.results.length; i++) {
                    if (!event.results[i].isFinal) continue

                    const nextChunk = event.results[i][0].transcript.trim()
                    if (!nextChunk) continue

                    const startedAt = surveyAudioSessionState.transcriptStartedAt ?? Date.now()
                    const offsetLabel = formatTranscriptOffset(Date.now() - startedAt)
                    const nextLine = `[${offsetLabel}] ${nextChunk}`
                    surveyAudioSessionState.transcript += `${surveyAudioSessionState.transcript ? '\n' : ''}${nextLine}`
                }
            }
            rec.onend = () => {
                surveyAudioSessionState.recognition = null
                if (!surveyAudioSessionState.keepTranscriptionAlive) return
                if (surveyAudioSessionState.mediaRecorder?.state === 'recording') {
                    surveyAudioSessionState.transcriptionStartTimeout = window.setTimeout(beginRecognition, 350)
                }
            }
            rec.start()
            surveyAudioSessionState.recognition = rec
        } catch (error) {
            console.warn('SpeechRecognition not available:', error)
        }
    }

    surveyAudioSessionState.transcriptionStartTimeout = window.setTimeout(beginRecognition, 600)
}

const stopSurveyAudioTranscription = async (): Promise<string> => {
    surveyAudioSessionState.keepTranscriptionAlive = false
    clearSurveyAudioTranscriptionStartTimeout()

    const activeRecognition = surveyAudioSessionState.recognition
    if (!activeRecognition) {
        const transcript = surveyAudioSessionState.transcript.trim()
        surveyAudioSessionState.transcript = ''
        surveyAudioSessionState.transcriptStartedAt = null
        return transcript
    }

    return new Promise<string>((resolve) => {
        let settled = false

        const finish = () => {
            if (settled) return
            settled = true
            const transcript = surveyAudioSessionState.transcript.trim()
            surveyAudioSessionState.transcript = ''
            surveyAudioSessionState.transcriptStartedAt = null
            surveyAudioSessionState.recognition = null
            resolve(transcript)
        }

        const timeoutId = window.setTimeout(finish, 1200)
        activeRecognition.onend = () => {
            window.clearTimeout(timeoutId)
            finish()
        }

        try {
            activeRecognition.stop()
        } catch {
            window.clearTimeout(timeoutId)
            finish()
        }
    })
}

const startSurveyAudioSession = async (): Promise<void> => {
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) return
    if (surveyAudioSessionState.mediaRecorder?.state === 'recording') return
    if (surveyAudioSessionState.startPromise) return surveyAudioSessionState.startPromise

    const startPromise = (async () => {
        const startId = surveyAudioSessionState.recorderStartId + 1
        surveyAudioSessionState.recorderStartId = startId

        clearSurveyAudioTranscriptionStartTimeout()
        surveyAudioSessionState.keepTranscriptionAlive = false
        surveyAudioSessionState.transcript = ''
        surveyAudioSessionState.transcriptStartedAt = null
        if (surveyAudioSessionState.recognition) {
            try { surveyAudioSessionState.recognition.stop() } catch { /* ignore */ }
            surveyAudioSessionState.recognition = null
        }
        if (surveyAudioSessionState.stopResolver) {
            surveyAudioSessionState.stopResolver(null)
            surveyAudioSessionState.stopResolver = null
        }

        if (surveyAudioSessionState.mediaRecorder && surveyAudioSessionState.mediaRecorder.state !== 'inactive') {
            try { surveyAudioSessionState.mediaRecorder.stop() } catch { /* ignore */ }
        }
        surveyAudioSessionState.mediaStream?.getTracks().forEach((track: MediaStreamTrack) => track.stop())
        surveyAudioSessionState.mediaRecorder = null
        surveyAudioSessionState.mediaStream = null

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            })

            if (startId !== surveyAudioSessionState.recorderStartId) {
                stream.getTracks().forEach((track) => track.stop())
                return
            }

            const mimeType = pickAudioMimeType()
            const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
            const chunks: Blob[] = []

            surveyAudioSessionState.mediaStream = stream
            surveyAudioSessionState.mediaRecorder = recorder

            recorder.ondataavailable = (event) => {
                if (event.data && event.data.size > 0) {
                    chunks.push(event.data)
                }
            }

            recorder.onstop = () => {
                const blob = chunks.length > 0
                    ? new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
                    : null

                if (surveyAudioSessionState.stopResolver) {
                    const resolver = surveyAudioSessionState.stopResolver
                    surveyAudioSessionState.stopResolver = null
                    resolver(blob)
                }
            }

            recorder.start()
            surveyAudioSessionState.transcriptStartedAt = Date.now()
            if (!isMobileRecordingDevice()) {
                startSurveyAudioTranscription()
            }
        } catch (error) {
            console.warn('Silent audio capture failed:', error)
        }
    })()

    surveyAudioSessionState.startPromise = startPromise
    await startPromise.finally(() => {
        if (surveyAudioSessionState.startPromise === startPromise) {
            surveyAudioSessionState.startPromise = null
        }
    })
}

const stopSurveyAudioCapture = async (): Promise<Blob | null> => {
    const recorder = surveyAudioSessionState.mediaRecorder
    if (!recorder || recorder.state === 'inactive') {
        surveyAudioSessionState.mediaStream?.getTracks().forEach((track: MediaStreamTrack) => track.stop())
        surveyAudioSessionState.mediaStream = null
        surveyAudioSessionState.mediaRecorder = null
        return null
    }

    return new Promise<Blob | null>((resolve) => {
        const timeoutId = window.setTimeout(() => {
            console.warn('stopSurveyAudioCapture safety timeout reached.')
            if (surveyAudioSessionState.stopResolver) {
                const resolver = surveyAudioSessionState.stopResolver
                surveyAudioSessionState.stopResolver = null
                resolver(null)
            }
        }, 2500)

        surveyAudioSessionState.stopResolver = (blob) => {
            window.clearTimeout(timeoutId)
            resolve(blob)
        }

        try {
            recorder.stop()
        } catch (error) {
            console.warn('recorder.stop() failed:', error)
            window.clearTimeout(timeoutId)
            if (surveyAudioSessionState.stopResolver) {
                const resolver = surveyAudioSessionState.stopResolver
                surveyAudioSessionState.stopResolver = null
                resolver(null)
            }
        }
    }).finally(() => {
        if (surveyAudioSessionState.mediaRecorder === recorder) {
            surveyAudioSessionState.mediaRecorder = null
        }
        surveyAudioSessionState.mediaStream?.getTracks().forEach((track: MediaStreamTrack) => track.stop())
        surveyAudioSessionState.mediaStream = null
    })
}

const stopSurveyAudioSession = async (): Promise<{ blob: Blob | null; transcript: string }> => {
    const [blob, transcript] = await Promise.all([stopSurveyAudioCapture(), stopSurveyAudioTranscription()])
    return { blob, transcript }
}

const discardSurveyAudioSession = async (): Promise<void> => {
    await stopSurveyAudioSession().catch(() => undefined)
}

const escapeHtml = (value: string): string => (
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
)

const sanitizeContractFilenamePart = (raw: string): string => {
    const normalized = raw
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
    return normalized || 'umowa'
}

const buildContractDocumentFilename = (answers: Record<string, string>): string => {
    const clientName = formatContractPacketClientLabel(buildContractParties(answers)) || 'klient'
    const contractDate = getAnswerValue(answers, 'contract_date') || new Date().toISOString().slice(0, 10)
    return `komplet_dokumentow_${contractDate}_${sanitizeContractFilenamePart(clientName)}.html`
}

const downloadHtmlDocument = (filename: string, html: string): void => {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
}

// eslint-disable-next-line react-refresh/only-export-components
export const buildPrintableContractHtml = (answers: Record<string, string>, contractText: string): string => {
    const clientName = getAnswerValue(answers, 'client_name') || 'Klient'
    const contractPlace = getAnswerValue(answers, 'contract_place') || '................................'
    const contractDate = formatContractDate(getAnswerValue(answers, 'contract_date'))
    const safeContractText = escapeHtml(contractText)

    return `<!doctype html>
<html lang="pl">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Umowa - ${escapeHtml(clientName)}</title>
    <style>
        :root {
            color-scheme: light;
        }

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            font-family: "Times New Roman", Georgia, serif;
            background: #eef2f7;
            color: #111827;
        }

        .toolbar {
            position: sticky;
            top: 0;
            z-index: 10;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 12px;
            padding: 16px 20px;
            background: rgba(15, 23, 42, 0.94);
            color: #f8fafc;
        }

        .toolbar-title {
            font: 600 14px/1.4 Arial, sans-serif;
            letter-spacing: 0.04em;
            text-transform: uppercase;
        }

        .toolbar-subtitle {
            font: 400 13px/1.4 Arial, sans-serif;
            color: #cbd5e1;
        }

        .toolbar-actions {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }

        .toolbar button {
            border: 0;
            border-radius: 999px;
            padding: 10px 16px;
            font: 600 13px/1 Arial, sans-serif;
            cursor: pointer;
            background: #06b6d4;
            color: #fff;
        }

        .toolbar button.secondary {
            background: #1e293b;
            color: #e2e8f0;
            border: 1px solid #334155;
        }

        .page {
            width: min(210mm, calc(100% - 24px));
            margin: 24px auto;
            padding: 18mm 16mm;
            background: #fff;
            box-shadow: 0 18px 50px rgba(15, 23, 42, 0.14);
        }

        .meta {
            margin-bottom: 18px;
            padding-bottom: 12px;
            border-bottom: 1px solid #cbd5e1;
            font: 400 13px/1.6 Arial, sans-serif;
            color: #475569;
        }

        .meta strong {
            color: #0f172a;
        }

        .contract-body {
            white-space: pre-wrap;
            font-size: 12.5pt;
            line-height: 1.72;
        }

        .signatures {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 28px;
            margin-top: 36px;
            padding-top: 20px;
        }

        .signature-line {
            padding-top: 32px;
            border-top: 1px solid #334155;
            text-align: center;
            font: 600 12px/1.4 Arial, sans-serif;
            color: #334155;
        }

        @page {
            size: A4;
            margin: 14mm;
        }

        @media print {
            body {
                background: #fff;
            }

            .toolbar {
                display: none;
            }

            .page {
                width: 100%;
                margin: 0;
                padding: 0;
                box-shadow: none;
            }
        }

        @media (max-width: 720px) {
            .toolbar {
                align-items: flex-start;
                flex-direction: column;
            }

            .page {
                width: calc(100% - 16px);
                margin: 8px auto 24px;
                padding: 20px 16px;
            }

            .signatures {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <div>
            <div class="toolbar-title">Gotowa umowa do druku</div>
            <div class="toolbar-subtitle">Data: ${escapeHtml(contractDate)} | Miejsce: ${escapeHtml(contractPlace)} | Klient: ${escapeHtml(clientName)}</div>
        </div>
        <div class="toolbar-actions">
            <button type="button" onclick="window.print()">Drukuj / Zapisz jako PDF</button>
            <button type="button" class="secondary" onclick="window.close()">Zamknij</button>
        </div>
    </div>
    <main class="page">
        <div class="meta">
            <strong>Wersja do druku:</strong> uzupełniona treść umowy przygotowana na podstawie wpisanych danych.
        </div>
        <article class="contract-body">${safeContractText}</article>
        <section class="signatures">
            <div class="signature-line">Podpis w imieniu Kancelarii</div>
            <div class="signature-line">Podpis Klienta</div>
        </section>
    </main>
</body>
</html>`
}

export default function SurveyForm({
    onBack,
    onMeetingSaved,
    initialCoords,
    linkedMeeting,
    meetingStartedAt
}: {
    onBack: () => void
    onMeetingSaved?: (meeting: SalesMeeting | null) => void
    initialCoords?: {lat: number, lng: number} | null
    linkedMeeting?: SalesMeeting | null
    meetingStartedAt?: string | null
}) {
    const { user, activeShift } = useAuth()
    const [answers, setAnswers] = useState<Record<string, string>>(() => createInitialAnswers(linkedMeeting))
    const [step, setStep] = useState<Step>('agreement')
    const [saving, setSaving] = useState(false)
    const [saved, setSaved] = useState<'online' | 'offline' | false>(false)

    const [saveError, setSaveError] = useState<string | null>(null)
    const [geoLoading, setGeoLoading] = useState(false)
    const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(initialCoords || null)
    const [showOtherStatusOptions, setShowOtherStatusOptions] = useState(false)
    const [showAttemptedStatusModal, setShowAttemptedStatusModal] = useState(false)
    const [showPostMeetingStatusModal, setShowPostMeetingStatusModal] = useState(false)
    const [meetingDurationLabel, setMeetingDurationLabel] = useState<string | null>(null)
    const [attemptedNote, setAttemptedNote] = useState('')
    const showAttemptedStatusForm = false
    const [postMeetingStatus, setPostMeetingStatus] = useState<PostMeetingStatus | null>(null)
    const [postMeetingStatusNote, setPostMeetingStatusNote] = useState('')
    const [attemptedPhone, setAttemptedPhone] = useState(linkedMeeting?.phone?.trim() || '')
    const [attemptedDate, setAttemptedDate] = useState(() => getNextFollowUpDateTime(linkedMeeting).date)
    const [attemptedTime, setAttemptedTime] = useState(() => getNextFollowUpDateTime(linkedMeeting).time)
    const [touchedContractFields, setTouchedContractFields] = useState<Record<string, boolean>>({})
    const [showContractPreview, setShowContractPreview] = useState(false)
    const [savedSurveyStatus, setSavedSurveyStatus] = useState<SurveySaveStatus | null>(null)
    const meetingProgressPersistedRef = useRef(false)
    const meetingInitialStatusNoteRef = useRef<string | null>(linkedMeeting?.status_note ?? null)
    const meetingInitialStatusUpdatedAtRef = useRef<string | null>(linkedMeeting?.status_updated_at ?? null)
    const showQualification = false
    const address = getAnswerValue(answers, 'property_address')
    const name = getAnswerValue(answers, 'client_name')
    const phone = getAnswerValue(answers, 'client_phone')
    const date = getAnswerValue(answers, 'contract_date')
    const time = ''
    const attemptedPhoneDigits = attemptedPhone.replace(/\D/g, '')
    const contractRepresentativeName = useMemo(() => getContractRepresentativeName(user?.name), [user?.name])
    const surveyDraftStorageKey = useMemo(() => {
        if (!user?.id) return null
        return `survey-form-draft:${user.id}:${linkedMeeting?.id ?? 'standalone'}`
    }, [linkedMeeting?.id, user?.id])
    const attemptedSelectedAt = useMemo(() => buildLocalDateTime(attemptedDate, attemptedTime), [attemptedDate, attemptedTime])
    const attemptedMatchesLinkedMeeting = useMemo(() => {
        if (!linkedMeeting?.scheduled_at || !attemptedSelectedAt) return false
        return new Date(linkedMeeting.scheduled_at).getTime() === attemptedSelectedAt.getTime()
    }, [attemptedSelectedAt, linkedMeeting?.scheduled_at])
    const attemptedCanSave =
        attemptedPhoneDigits.length >= 9 &&
        Boolean(attemptedDate) &&
        Boolean(attemptedTime) &&
        Boolean(attemptedSelectedAt) &&
        Boolean(attemptedNote.trim()) &&
        !attemptedMatchesLinkedMeeting

    useEffect(() => {
        meetingProgressPersistedRef.current = false
        meetingInitialStatusNoteRef.current = linkedMeeting?.status_note ?? null
        meetingInitialStatusUpdatedAtRef.current = linkedMeeting?.status_updated_at ?? null
        setAttemptedPhone(linkedMeeting?.phone?.trim() || '')
        const nextFollowUp = getNextFollowUpDateTime(linkedMeeting)
        setAttemptedDate(nextFollowUp.date)
        setAttemptedTime(nextFollowUp.time)
    }, [linkedMeeting])

    const clearSurveyDraft = () => {
        if (typeof window === 'undefined' || !surveyDraftStorageKey) return
        window.localStorage.removeItem(surveyDraftStorageKey)
    }

    useEffect(() => {
        if (typeof window === 'undefined' || !surveyDraftStorageKey) return

        const rawDraft = window.localStorage.getItem(surveyDraftStorageKey)
        if (!rawDraft) {
            const nextFollowUp = getNextFollowUpDateTime(linkedMeeting)
            setAnswers(createInitialAnswers(linkedMeeting))
            setStep('agreement')
            setSaved(false)
            setSavedSurveyStatus(null)
            setCoords(initialCoords || null)
            setSaveError(null)
            setMeetingDurationLabel(null)
            setShowOtherStatusOptions(false)
            setShowAttemptedStatusModal(false)
            setShowPostMeetingStatusModal(false)
            setAttemptedNote('')
            setAttemptedPhone(linkedMeeting?.phone?.trim() || '')
            setAttemptedDate(nextFollowUp.date)
            setAttemptedTime(nextFollowUp.time)
            setPostMeetingStatus(null)
            setPostMeetingStatusNote('')
            setTouchedContractFields({})
            setShowContractPreview(false)
            return
        }

        try {
            const parsed = JSON.parse(rawDraft) as Partial<SurveyFormDraftState>
            const nextFollowUp = getNextFollowUpDateTime(linkedMeeting)
            setAnswers(parsed.answers && typeof parsed.answers === 'object' ? parsed.answers : createInitialAnswers(linkedMeeting))
            setStep(parsed.step || 'agreement')
            setSaved(false)
            setSavedSurveyStatus(null)
            setCoords(parsed.coords ?? initialCoords ?? null)
            setSaveError(null)
            setMeetingDurationLabel(null)
            setShowOtherStatusOptions(false)
            setShowAttemptedStatusModal(Boolean(parsed.showAttemptedStatusModal))
            setShowPostMeetingStatusModal(Boolean(parsed.showPostMeetingStatusModal))
            setAttemptedNote(parsed.attemptedNote || '')
            setAttemptedPhone(parsed.attemptedPhone || linkedMeeting?.phone?.trim() || '')
            setAttemptedDate(parsed.attemptedDate || nextFollowUp.date)
            setAttemptedTime(parsed.attemptedTime || nextFollowUp.time)
            const restoredPostMeetingStatus = parsed.postMeetingStatus
            setPostMeetingStatus(isPostMeetingStatus(restoredPostMeetingStatus) ? restoredPostMeetingStatus : null)
            setPostMeetingStatusNote(parsed.postMeetingStatusNote || '')
            setTouchedContractFields(
                parsed.touchedContractFields && typeof parsed.touchedContractFields === 'object' ? parsed.touchedContractFields : {}
            )
            setShowContractPreview(Boolean(parsed.showContractPreview))
        } catch {
            window.localStorage.removeItem(surveyDraftStorageKey)
        }
    }, [initialCoords, linkedMeeting, surveyDraftStorageKey])

    useEffect(() => {
        if (typeof window === 'undefined' || !surveyDraftStorageKey || saved) return

        const draftPayload: SurveyFormDraftState = {
            answers,
            step,
            coords,
            attemptedNote,
            attemptedPhone,
            attemptedDate,
            attemptedTime,
            touchedContractFields,
            showContractPreview,
            showAttemptedStatusModal,
            postMeetingStatus,
            postMeetingStatusNote,
            showPostMeetingStatusModal
        }

        window.localStorage.setItem(surveyDraftStorageKey, JSON.stringify(draftPayload))
    }, [
        answers,
        attemptedDate,
        attemptedNote,
        attemptedPhone,
        attemptedTime,
        coords,
        postMeetingStatus,
        postMeetingStatusNote,
        saved,
        showAttemptedStatusModal,
        showContractPreview,
        showPostMeetingStatusModal,
        step,
        surveyDraftStorageKey,
        touchedContractFields
    ])

    useEffect(() => {
        if (!linkedMeeting?.id || !meetingStartedAt) return
        if (linkedMeeting.status !== 'planned' && linkedMeeting.status !== 'follow_up') return

        const startedAtMs = parseMeetingStartedAt(meetingStartedAt)
        if (startedAtMs === null) return

        const startedAtIso = new Date(startedAtMs).toISOString()
        const originalCleanNote = getSalesMeetingCleanStatusNote(linkedMeeting.status_note)

        void supabase
            .from('sales_meetings')
            .update({
                status_note: buildSalesMeetingInProgressNote(originalCleanNote),
                status_updated_at: startedAtIso
            })
            .eq('id', linkedMeeting.id)

        return () => {
            if (meetingProgressPersistedRef.current) return

            void supabase
                .from('sales_meetings')
                .update({
                    status_note: getSalesMeetingCleanStatusNote(meetingInitialStatusNoteRef.current),
                    status_updated_at: meetingInitialStatusUpdatedAtRef.current ?? null
                })
                .eq('id', linkedMeeting.id)
        }
    }, [linkedMeeting?.id, linkedMeeting?.status, linkedMeeting?.status_note, meetingStartedAt])

    const setFieldValue = (fieldId: string, value: string) => {
        setAnswers((current) => ({ ...current, [fieldId]: value }))
    }
    const setAdditionalContractParties = (
        updater: AdditionalContractPartyDraft[] | ((current: AdditionalContractPartyDraft[]) => AdditionalContractPartyDraft[])
    ) => {
        setAnswers((current) => {
            const currentParties = parseAdditionalContractParties(current)
            const nextParties = typeof updater === 'function' ? updater(currentParties) : updater
            return {
                ...current,
                [ADDITIONAL_CONTRACT_PARTIES_FIELD]: nextParties.length > 0 ? serializeAdditionalContractParties(nextParties) : ''
            }
        })
    }
    const markContractFieldTouched = (fieldId: string) => {
        setTouchedContractFields((current) => (current[fieldId] ? current : { ...current, [fieldId]: true }))
    }

    const setAddress = (value: string) => setFieldValue('property_address', value)
    const setName = (value: string) => setFieldValue('client_name', value)
    const setPhone = (value: string) => setFieldValue('client_phone', value)
    const setDate = (value: string) => setFieldValue('contract_date', value)
    const setTime = (value: string) => {
        void value
    }
    const setQi = (value: number) => {
        void value
    }
    const setShowQualification = (value: boolean) => {
        void value
    }
    const keepTranscriptionAliveRef = useRef(false)
    const savingRef = useRef(false)
    const startHiddenAudio = async () => {
        keepTranscriptionAliveRef.current = true
        await startSurveyAudioSession()
    }

    const handleAbandonSurvey = () => {
        keepTranscriptionAliveRef.current = false
        clearSurveyDraft()
        void discardSurveyAudioSession()
        onBack()
    }

    useEffect(() => {
        void startHiddenAudio()
        return () => {
            if (keepTranscriptionAliveRef.current) {
                return
            }
            void discardSurveyAudioSession()
        }
    }, [])

    useEffect(() => {
        if (!showOtherStatusOptions && !showAttemptedStatusModal && !showPostMeetingStatusModal) return

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return

            if (showPostMeetingStatusModal) {
                setShowPostMeetingStatusModal(false)
                return
            }

            if (showAttemptedStatusModal) {
                setShowAttemptedStatusModal(false)
                return
            }

            setShowOtherStatusOptions(false)
        }

        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        document.addEventListener('keydown', onKeyDown)

        return () => {
            document.body.style.overflow = previousOverflow
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [showAttemptedStatusModal, showOtherStatusOptions, showPostMeetingStatusModal])



    const fetchGeoAddress = async () => {
        setGeoLoading(true)
        try {
            let lat = coords?.lat
            let lng = coords?.lng
            
            // If no initial coords were passed, fetch from GPS
            if (!lat || !lng) {
                const pos = await new Promise<GeolocationPosition>((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000, enableHighAccuracy: true }))
                lat = pos.coords.latitude
                lng = pos.coords.longitude
                setCoords({ lat, lng })
            }

            const resp = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&accept-language=pl`)
            const data = await resp.json()
            if (data.address) {
                const a = data.address
                const street = a.road || a.pedestrian || a.footway || ''
                const houseNum = a.house_number || ''
                const city = a.city || a.town || a.village || a.hamlet || ''
                const postcode = a.postcode || ''
                const parts = [`${street} ${houseNum}`.trim(), city, postcode].filter(Boolean)
                setAnswers((current) => ({ ...current, property_address: parts.join(', ') }))
            } else if (data.display_name) {
                setAnswers((current) => ({ ...current, property_address: data.display_name }))
            }
        } catch (e) {
            console.warn('Nie udało się pobrać adresu z GPS', e)
        } finally {
            setGeoLoading(false)
        }
    }

    const steps: { key: Step; label: string }[] = [
        ...CONTRACT_SECTIONS.map((section) => ({ key: section.key, label: section.label })),
        { key: 'summary', label: 'Podsumowanie' }
    ]
    const si = steps.findIndex((s) => s.key === step)
    const isSuccess = step === 'success'
    const currentSection = step !== 'summary' && step !== 'success'
        ? CONTRACT_SECTIONS.find((section) => section.key === step) || null
        : null
    const showLegacySummaryStep = false
    const currentFields = useMemo(
        () => (currentSection ? QS.filter((field) => field.section === currentSection.key) : []),
        [currentSection]
    )
    const additionalContractParties = useMemo(() => parseAdditionalContractParties(answers), [answers])
    const additionalContractPartyErrors = useMemo(
        () => additionalContractParties.map((party) => getAdditionalContractPartyValidationError(party)),
        [additionalContractParties]
    )
    const hasAdditionalContractPartyErrors = additionalContractPartyErrors.some((error) => Boolean(error))
    const contractParties = useMemo(() => buildContractParties(answers), [answers])
    const selectedContractTemplate = useMemo(() => resolveSelectedContractTemplate(answers), [answers])
    const contractPreview = useMemo(
        () => buildResolvedContractSnapshot(answers, contractRepresentativeName),
        [answers, contractRepresentativeName]
    )
    const requiredFieldsMissing =
        QS.some((field) => getContractFieldValidationError(field, answers) !== null) || hasAdditionalContractPartyErrors
    const isCurrentSectionComplete = currentSection
        ? isStepComplete(currentSection.key, answers) && (currentSection.key !== 'client' || !hasAdditionalContractPartyErrors)
        : false
    const cur: QDef | null = QS[0] || null
    const total = QS.length
    const qi = 0
    const pick = (id: string, val: string) => {
        void id
        void val
    }
    const nextT = () => undefined
    const prevQ = () => undefined
    const goToNextStep = () => {
        if (!currentSection) return
        const currentIndex = CONTRACT_SECTIONS.findIndex((section) => section.key === currentSection.key)
        if (currentIndex === CONTRACT_SECTIONS.length - 1) {
            setStep('summary')
            return
        }
        setStep(CONTRACT_SECTIONS[currentIndex + 1].key)
    }
    const goToPrevStep = () => {
        if (step === 'summary') {
            setStep(CONTRACT_SECTIONS[CONTRACT_SECTIONS.length - 1].key)
            return
        }
        if (!currentSection) return
        const currentIndex = CONTRACT_SECTIONS.findIndex((section) => section.key === currentSection.key)
        if (currentIndex <= 0) {
            handleAbandonSurvey()
            return
        }
        setStep(CONTRACT_SECTIONS[currentIndex - 1].key)
    }
    const openPrintableContract = () => {
        const filename = buildContractDocumentFilename(answers)
        const printableHtml = buildPrintableContractPacketHtml(
            {
                contractDate: formatContractDate(getAnswerValue(answers, 'contract_date')),
                contractPlace: getAnswerValue(answers, 'contract_place') || '................................',
                representativeName: contractRepresentativeName,
                propertyAddress: getAnswerValue(answers, 'property_address') || '................................',
                propertyRegistryDetails: getAnswerValue(answers, 'property_registry_details') || '................................',
                baseFeeAmount: formatMoneyAmountDisplay(getAnswerValue(answers, 'base_fee_amount')),
                baseFeeWords: formatMoneyWords(getAnswerValue(answers, 'base_fee_amount')),
                successFeePercent: getAnswerValue(answers, 'success_fee_percent') || '................................',
                successFeeWords: formatPercentWords(getAnswerValue(answers, 'success_fee_percent')),
                template: selectedContractTemplate,
                parties: contractParties
            },
            contractPreview
        )
        const printableWindow = window.open('', '_blank')

        if (!printableWindow) {
            downloadHtmlDocument(filename, printableHtml)
            return
        }

        printableWindow.document.open()
        printableWindow.document.write(printableHtml)
        printableWindow.document.close()
        printableWindow.focus()
    }

    const renderSectionField = (field: QDef) => {
        const value = answers[field.id] || ''
        const error = getContractFieldValidationError(field, answers)
        const showError = Boolean(error) && (Boolean(touchedContractFields[field.id]) || value.trim().length > 0)
        const fieldClassName = `${input} ${field.type === 'date' ? 'contract-date-input min-w-0 max-w-full' : ''} ${showError ? inputError : ''}`
        const labelClassName = showError ? 'text-sm mb-1 block text-red-500 dark:text-red-400' : label
        const requiredBadgeClass = showError
            ? 'ml-2 inline-flex items-center rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-red-600 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
            : 'ml-2 inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-gray-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400'

        return (
            <div key={field.id} className="space-y-1.5">
                <label className={labelClassName}>
                    {field.text}
                    {field.required ? (
                        <span className={requiredBadgeClass}>{showError ? 'uzupełnij' : 'wymagane'}</span>
                    ) : (
                        <span className="ml-1 text-[10px] uppercase tracking-widest text-gray-400">opcjonalnie</span>
                    )}
                </label>
                {field.id === 'base_fee_amount' ? (
                    <select
                        value={value}
                        onChange={(event) => setFieldValue(field.id, event.target.value)}
                        onBlur={() => markContractFieldTouched(field.id)}
                        className={fieldClassName}
                        aria-invalid={showError}
                    >
                        <option value="">Wybierz kwotę wynagrodzenia</option>
                        {BASE_FEE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                ) : field.type === 'textarea' ? (
                    <textarea
                        value={value}
                        placeholder={field.placeholder}
                        rows={field.rows || 3}
                        onChange={(event) => setFieldValue(field.id, event.target.value)}
                        onBlur={() => markContractFieldTouched(field.id)}
                        className={`${fieldClassName} resize-none`}
                        aria-invalid={showError}
                    />
                ) : (
                    <input
                        type={field.type}
                        value={value}
                        placeholder={field.placeholder}
                        onChange={(event) => {
                            const nextValue = sanitizeContractFieldInput(field.id, event.target.value)
                            setFieldValue(field.id, nextValue)
                        }}
                        onBlur={() => markContractFieldTouched(field.id)}
                        className={fieldClassName}
                        inputMode={field.inputMode}
                        autoComplete={field.autoComplete}
                        aria-invalid={showError}
                    />
                )}
                {field.id === 'base_fee_amount' && value && (
                    <p className="text-[11px] font-semibold text-cyan-700 dark:text-cyan-300">
                        Wybrany wariant umowy: {selectedContractTemplate.label}
                    </p>
                )}
                {field.id === 'success_fee_percent' && (
                    <p className="text-[11px] leading-5 text-gray-500 dark:text-gray-400">
                        Chodzi o procent liczony od całej kwoty faktycznie uzyskanej dla klienta, razem z odsetkami, zgodnie z umową.
                    </p>
                )}
                {showError && <p className="text-[11px] font-semibold text-red-500 dark:text-red-400">{error}</p>}
            </div>
        )
    }

    if (si === -1 && !isSuccess) {
        // Fallback for safety
        return null
    }

    const resolveSurveyCoords = async () => {
        let lat = coords?.lat ?? initialCoords?.lat
        let lng = coords?.lng ?? initialCoords?.lng

        if (!navigator.geolocation) {
            return { lat, lng }
        }

        try {
            const pos = await new Promise<GeolocationPosition>((res, rej) =>
                navigator.geolocation.getCurrentPosition(res, rej, { timeout: 5000, enableHighAccuracy: true, maximumAge: 120000 })
            )
            lat = pos.coords.latitude
            lng = pos.coords.longitude
            setCoords({ lat, lng })
        } catch (e) {
            console.warn('Nie udało się pobrać świeżego GPS dla ankiety', e)
        }

        return { lat, lng }
    }
    const save = async (status: SurveySaveStatus = 'completed') => {
        if (!user || !activeShift || savingRef.current) return
        savingRef.current = true
        setSaving(true)
        setSaveError(null)

        const appointmentDate = status === 'attempted' ? attemptedDate : date
        const appointmentTime = status === 'attempted' ? attemptedTime : time
        const typedAttemptedPhone = attemptedPhone.trim()
        const statusNote = status === 'attempted' ? attemptedNote.trim() : postMeetingStatusNote.trim()
        const requiresStatusNote = status === 'refused' || status === 'no_cooperation'

        if (status === 'attempted') {
            if (attemptedPhoneDigits.length < 9) {
                setSaveError('Przy kontakcie ponownym wpisz numer telefonu do oddzwonienia.')
                setSaving(false)
                savingRef.current = false
                return
            }

            if (!appointmentDate || !appointmentTime) {
                setSaveError('Przy kontakcie ponownym wybierz termin kolejnego kontaktu w grafiku.')
                setSaving(false)
                savingRef.current = false
                return
            }

            if (!attemptedSelectedAt || attemptedSelectedAt.getTime() <= Date.now()) {
                setSaveError('Przy kontakcie ponownym wybierz nowy termin w przyszłości.')
                setSaving(false)
                savingRef.current = false
                return
            }

            if (linkedMeeting?.scheduled_at && attemptedMatchesLinkedMeeting) {
                setSaveError('Kontakt ponowny musi miec inny termin niz obecne spotkanie.')
                setSaving(false)
                savingRef.current = false
                return
            }
        }

        if (requiresStatusNote && !statusNote) {
            setSaveError('Dodaj notatkę do wybranego statusu spotkania.')
            setSaving(false)
            savingRef.current = false
            return
        }

        const { lat, lng } = await resolveSurveyCoords()
        const createdAtIso = new Date().toISOString()
        const normalizedAddress = getAnswerValue(answers, 'property_address')
        const clientName = getAnswerValue(answers, 'client_name')
        const clientPhone = status === 'attempted'
            ? (typedAttemptedPhone || getAnswerValue(answers, 'client_phone'))
            : getAnswerValue(answers, 'client_phone')
        const surveyAddress =
            (status === 'completed' ? normalizedAddress : linkedMeeting?.address?.trim() || normalizedAddress) ||
            ((lat !== undefined && lng !== undefined) ? `GPS: ${lat.toFixed(6)}, ${lng.toFixed(6)}` : 'Brak adresu')
        const requiresAudio = status === 'completed' || status === 'refused' || status === 'attempted' || status === 'no_cooperation'

        if (status === 'completed' && clientName && normalizedAddress) {
            try {
                const { data: existing } = await supabase
                    .from('surveys')
                    .select('id')
                    .eq('address', normalizedAddress)
                    .eq('respondent_name', clientName)
                    .limit(1)
                    .maybeSingle()

                if (existing) {
                    setSaveError(`Umowa dla osoby "${clientName}" pod adresem "${normalizedAddress}" juz istnieje w systemie. Nie mozna dodac duplikatu.`)
                    setSaving(false)
                    savingRef.current = false
                    return
                }
            } catch (e) {
                console.warn('Blad podczas sprawdzania duplikatow:', e)
            }
        }

        let uploadedAudioUrl: string | undefined
        let uploadedAudioPath: string | undefined

        let recordedBlob: Blob | null = null
        let recordedAudioDurationSeconds: number | null = null
        let transcript = ''
        if (requiresAudio) {
            const stoppedSession = await stopSurveyAudioSession()
            recordedBlob = stoppedSession.blob
            transcript = stoppedSession.transcript
        } else {
            void discardSurveyAudioSession()
        }

        if (requiresAudio) {
            if (!recordedBlob || recordedBlob.size === 0) {
                setSaveError('Nie udało się nagrać dźwięku. Sprawdź mikrofon i spróbuj ponownie.')
                setSaving(false)
                savingRef.current = false
                void startHiddenAudio()
                return
            }
            if (!navigator.onLine) {
                setSaveError('Dla statusu spotkania zrealizowanego / odmowy / kontaktu ponownego / odmowy INNE wymagane jest nagranie audio online. Połącz się z internetem i zapisz ponownie.')
                setSaving(false)
                savingRef.current = false
                void startHiddenAudio()
                return
            }

            recordedAudioDurationSeconds = await getAudioBlobDurationSeconds(recordedBlob)
            let audioBlobForUpload = recordedBlob
            let audioMeta = getAudioUploadMeta(recordedBlob)
            try {
                const mp3Blob = await convertBlobToMp3(recordedBlob)
                audioBlobForUpload = mp3Blob
                audioMeta = { extension: 'mp3', contentType: 'audio/mpeg' }
            } catch (e) {
                // Do not block survey save if conversion fails on some mobile browsers.
                console.error('MP3 conversion failed, using original audio format:', e)
            }

            const audioPath = `${user.id}/${activeShift.id}/${Date.now()}-${status}.${audioMeta.extension}`
            const { error: audioUploadError } = await supabase.storage.from(AUDIO_BUCKET).upload(audioPath, audioBlobForUpload, {
                cacheControl: '3600',
                upsert: false,
                contentType: audioMeta.contentType
            })
            if (audioUploadError) {
                setSaveError(`Nie udało się zapisać nagrania audio: ${audioUploadError.message}`)
                setSaving(false)
                savingRef.current = false
                void startHiddenAudio()
                return
            }

            const { data: audioPublic } = supabase.storage.from(AUDIO_BUCKET).getPublicUrl(audioPath)
            uploadedAudioUrl = audioPublic.publicUrl
            uploadedAudioPath = audioPath
        }
        const savedTranscript = transcript.length > 0 ? transcript : undefined
        const resolvedMeetingName =
            status === 'completed'
                ? clientName || linkedMeeting?.client_name?.trim() || ''
                : linkedMeeting?.client_name?.trim() || clientName || ''
        const resolvedMeetingPhone =
            status === 'completed'
                ? clientPhone || linkedMeeting?.phone?.trim() || undefined
                : linkedMeeting?.phone?.trim() || clientPhone || undefined
        const generatedBaseFeeWords = formatMoneyWords(getAnswerValue(answers, 'base_fee_amount'))
        const generatedSuccessFeeWords = formatPercentWords(getAnswerValue(answers, 'success_fee_percent'))
        const mergedAnswers: Record<string, string | string[]> = status === 'completed'
            ? {
                ...answers,
                base_fee_words: generatedBaseFeeWords,
                success_fee_words: generatedSuccessFeeWords,
                contract_template: selectedContractTemplate.version,
                contract_snapshot: buildResolvedContractSnapshot(answers, contractRepresentativeName)
            }
            : {}
        let resolvedMeetingDurationLabel: string | null = null
        if (status === 'refused') {
            mergedAnswers.pole_status = 'Odmowa po spotkaniu'
            mergedAnswers.refusal_stage = 'after_meeting'
        }
        if (status === 'attempted') mergedAnswers.pole_status = 'Kontakt ponowny'
        if (status === 'no_cooperation') mergedAnswers.pole_status = 'Brak wspolpracy'
        if (status === 'not_home') mergedAnswers.pole_status = 'Nie zastano w domu'
        if (linkedMeeting?.id) {
            mergedAnswers.source = 'sales_meeting'
            mergedAnswers.meeting_id = String(linkedMeeting.id)
            mergedAnswers.meeting_scheduled_at = linkedMeeting.scheduled_at
            mergedAnswers.imported_note = linkedMeeting.note || ''

            const startedAtMs = parseMeetingStartedAt(meetingStartedAt)
            if (startedAtMs !== null && status !== 'not_home') {
                const finishedAtMs = Date.parse(createdAtIso)
                const durationSeconds = Math.max(0, Math.round((finishedAtMs - startedAtMs) / 1000))
                resolvedMeetingDurationLabel = formatMeetingDuration(durationSeconds)
                mergedAnswers.meeting_started_at = new Date(startedAtMs).toISOString()
                mergedAnswers.meeting_finished_at = createdAtIso
                mergedAnswers.meeting_duration_seconds = String(durationSeconds)
                mergedAnswers.meeting_duration_label = resolvedMeetingDurationLabel
            }
        }
        if (linkedMeeting?.lead_source) {
            mergedAnswers.lead_source = linkedMeeting.lead_source
        }
        if (statusNote) {
            mergedAnswers.status_note = statusNote
        }
        if (status === 'attempted' && statusNote) {
            mergedAnswers.notatka_z_kontaktu = statusNote
        }
        if (status === 'attempted') {
            if (typedAttemptedPhone) {
                mergedAnswers.client_phone = typedAttemptedPhone
                mergedAnswers.follow_up_phone = typedAttemptedPhone
            }
            if (appointmentDate) mergedAnswers.follow_up_date = appointmentDate
            if (appointmentTime) mergedAnswers.follow_up_time = appointmentTime
        }
        if (recordedAudioDurationSeconds !== null) {
            mergedAnswers.audio_duration_seconds = String(recordedAudioDurationSeconds)
            mergedAnswers.audio_duration_label = formatMeetingDuration(recordedAudioDurationSeconds)
        }

        const surveyData = {
            shift_id: activeShift.id!,
            user_id: user.id!,
            user_name: user.name,
            created_at: createdAtIso,
            address: surveyAddress,
            answers: mergedAnswers,
            respondent_name: resolvedMeetingName || undefined,
            respondent_phone: resolvedMeetingPhone,
            respondent_preferred_date: status === 'attempted' ? appointmentDate || undefined : undefined,
            respondent_preferred_time: status === 'attempted' ? appointmentTime || undefined : undefined,
            latitude: lat ?? undefined,
            longitude: lng ?? undefined,
            status: status,
            audio_url: uploadedAudioUrl,
            audio_path: uploadedAudioPath,
            audio_transcript: savedTranscript,
            audio_captured_at: uploadedAudioUrl ? createdAtIso : undefined,
            audio_expires_at: uploadedAudioUrl ? new Date(Date.now() + AUDIO_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString() : undefined
        }

        try {
            const { data: svData, error: svError } = await supabase.from('surveys').insert(surveyData).select('id').single()
            if (svError) throw svError
            
            if (appointmentDate && appointmentTime && (status === 'completed' || status === 'attempted')) {
                const [limitsResp, existingResp] = await Promise.all([
                    supabase
                        .from('appointment_limits')
                        .select('slot_limit')
                        .eq('appointment_date', appointmentDate)
                        .eq('appointment_time', `${appointmentTime}:00`)
                        .maybeSingle(),
                    supabase
                        .from('appointments')
                        .select('id, appointment_time')
                        .eq('appointment_date', appointmentDate)
                        .eq('appointment_time', `${appointmentTime}:00`)
                        .not('survey_id', 'is', null)
                ])

                if (limitsResp.error) throw limitsResp.error
                if (existingResp.error) throw existingResp.error

                const slotLimit = limitsResp.data?.slot_limit ?? DEFAULT_SLOT_LIMIT
                const bookedCount = (existingResp.data || []).filter((row) => normalizeTimeSlot(row.appointment_time) === appointmentTime).length
                if (bookedCount >= slotLimit) {
                    throw new Error('Ten termin osiągnął limit miejsc. Wybierz inną godzinę.')
                }

                const { error: appError } = await supabase.from('appointments').insert({
                    user_id: user.id!,
                    survey_id: svData.id,
                    appointment_date: appointmentDate,
                    appointment_time: appointmentTime,
                    respondent_name: resolvedMeetingName || name.trim() || 'Klient',
                    address: surveyAddress
                })
                
                if (appError) {
                    if (appError.code === '23505') {
                        throw new Error('Ten termin został właśnie zajęty przez innego pracownika. Wybierz inną godzinę.')
                    }
                    console.warn('Błąd zapisu umówionego spotkania:', appError.message)
                }
            }
            if (linkedMeeting?.id) {
                const meetingStatus = mapSurveyStatusToMeetingStatus(status)
                if (meetingStatus) {
                    const nextScheduledAtIso =
                        meetingStatus === 'follow_up' && attemptedSelectedAt
                            ? attemptedSelectedAt.toISOString()
                            : null
                    const nextStatusNote =
                        meetingStatus === 'follow_up' && nextScheduledAtIso
                            ? buildSalesMeetingRescheduledNote(
                                linkedMeeting.scheduled_at,
                                nextScheduledAtIso,
                                statusNote || null
                            )
                            : meetingStatus === 'refused'
                                ? buildSalesMeetingRefusalNote('after_meeting', statusNote || null)
                            : statusNote || null
                    const meetingUpdate: Record<string, string | number | null> = {
                        status: meetingStatus,
                        linked_survey_id: svData.id,
                        status_updated_at: createdAtIso,
                        status_note: nextStatusNote
                    }

                    if (meetingStatus === 'follow_up' && nextScheduledAtIso) {
                        meetingUpdate.scheduled_at = nextScheduledAtIso
                    }

                    const { error: meetingUpdateError } = await supabase
                        .from('sales_meetings')
                        .update(meetingUpdate)
                        .eq('id', linkedMeeting.id)

                    if (meetingUpdateError) throw meetingUpdateError
                    onMeetingSaved?.({
                        ...linkedMeeting,
                        status: meetingStatus,
                        linked_survey_id: svData.id,
                        status_updated_at: createdAtIso,
                        status_note: nextStatusNote,
                        scheduled_at: nextScheduledAtIso ?? linkedMeeting.scheduled_at
                    })
                    meetingProgressPersistedRef.current = true
                }
            }

            clearSurveyDraft()
            setShowOtherStatusOptions(false)
            setShowAttemptedStatusModal(false)
            setShowPostMeetingStatusModal(false)
            setMeetingDurationLabel(resolvedMeetingDurationLabel)
            setSavedSurveyStatus(status)
            setSaved('online')
            setStep('success') // Move success step here for online saves
        } catch (error: unknown) {
            const { message } = parseSaveError(error)
            const msg = mapFriendlySaveError(message)
            console.error('Błąd zapisu:', error)
            setSaveError(msg)
            
            // If it's a conflict error, don't save offline, let user pick another time
            if (msg.toLowerCase().includes('zaj') || msg.toLowerCase().includes('limit miejsc')) {
                setSaving(false)
                savingRef.current = false
                void startHiddenAudio()
                return
            }

            // Keep server validation errors on screen; queue offline only when connection failed.
            if (!isNetworkSaveError(error, msg)) {
                setSaving(false)
                savingRef.current = false
                void startHiddenAudio()
                return
            }



            addOfflineSurvey(surveyData)
            clearSurveyDraft()
            setShowOtherStatusOptions(false)
            setShowAttemptedStatusModal(false)
            setShowPostMeetingStatusModal(false)
            setMeetingDurationLabel(resolvedMeetingDurationLabel)
            setSavedSurveyStatus(status)
            setSaved('offline')
            setStep('success')
        } finally {
            setSaving(false)
            savingRef.current = false
        }
    }

    const reset = () => {
        const nextFollowUp = getNextFollowUpDateTime(linkedMeeting)
        clearSurveyDraft()
        setAnswers(createInitialAnswers(linkedMeeting))
        setStep('agreement')
        setSaved(false)
        setSavedSurveyStatus(null)
        setCoords(initialCoords || null)
        setSaveError(null)
        setMeetingDurationLabel(null)
        setShowOtherStatusOptions(false)
        setShowAttemptedStatusModal(false)
        setShowPostMeetingStatusModal(false)
        setAttemptedNote('')
        setAttemptedPhone(linkedMeeting?.phone?.trim() || '')
        setAttemptedDate(nextFollowUp.date)
        setAttemptedTime(nextFollowUp.time)
        setPostMeetingStatus(null)
        setPostMeetingStatusNote('')
        setTouchedContractFields({})
        setShowContractPreview(false)
        void startHiddenAudio()
    }

    const resetLegacy = () => {
        const nextFollowUp = getNextFollowUpDateTime(linkedMeeting)
        clearSurveyDraft()
        setAddress(linkedMeeting?.address || ''); 
        setAnswers({}); 
        setName(linkedMeeting?.client_name || ''); 
        setPhone(linkedMeeting?.phone || ''); 
        setDate(getMeetingDateInput(linkedMeeting)); 
        setTime(getMeetingTimeInput(linkedMeeting)); 
        setStep('agreement');
        setQi(0); 
        setSaved(false); 
        setSavedSurveyStatus(null);
        setCoords(initialCoords || null);
        setSaveError(null);
        setMeetingDurationLabel(null);
        setShowOtherStatusOptions(false);
        setShowAttemptedStatusModal(false);
        setShowPostMeetingStatusModal(false);
        setAttemptedNote('');
        setAttemptedPhone(linkedMeeting?.phone?.trim() || '');
        setAttemptedDate(nextFollowUp.date);
        setAttemptedTime(nextFollowUp.time);
        setPostMeetingStatus(null);
        setPostMeetingStatusNote('');
        setTouchedContractFields({});
        setShowQualification(false);
        // Restart audio — startHiddenAudio now stops the old recorder first
        void startHiddenAudio();
    }
    void resetLegacy

    const openAttemptedStatusModal = () => {
        const nextFollowUp = getNextFollowUpDateTime(linkedMeeting)
        setShowOtherStatusOptions(false)
        setShowPostMeetingStatusModal(false)
        setShowAttemptedStatusModal(true)
        setSaveError(null)
        setAttemptedDate(nextFollowUp.date)
        setAttemptedTime(nextFollowUp.time)
    }

    const openPostMeetingStatusModal = (status: PostMeetingStatus) => {
        setShowOtherStatusOptions(false)
        setShowAttemptedStatusModal(false)
        setShowPostMeetingStatusModal(true)
        setPostMeetingStatus(status)
        setPostMeetingStatusNote('')
        setSaveError(null)
    }

    const savePostMeetingStatus = () => {
        if (!postMeetingStatus) return
        void save(postMeetingStatus)
    }

    
    const renderOtherStatusChooser = (disabled = false) => (
        <motion.button
            type="button"
            onClick={() => setShowOtherStatusOptions(true)}
            disabled={disabled}
            className={`${btnAbort} relative overflow-hidden`}
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.985 }}
        >
            <span className="relative z-10 flex items-center justify-between gap-2">
                <span>Zaznacz inny wynik</span>
                <motion.svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    animate={{ x: [0, 2.5, 0] }}
                    transition={{ duration: 1.5, repeat: Number.POSITIVE_INFINITY, repeatType: 'loop', ease: 'easeInOut' }}
                >
                    <path d="M5 12h14" />
                    <path d="m13 5 7 7-7 7" />
                </motion.svg>
            </span>
            <span className="absolute inset-y-0 -left-1/3 w-1/3 bg-white/30 dark:bg-white/10 blur-sm rotate-12 animate-[pulse_1.8s_ease-in-out_infinite]" />
        </motion.button>
    )

    const linkedMeetingPhoneHref = linkedMeeting ? buildPhoneHref(linkedMeeting.phone) : null
    const linkedMeetingDirectionsHref = linkedMeeting ? buildGoogleMapsDirectionsHref(linkedMeeting.address) : null

    const linkedMeetingCard = linkedMeeting ? (
        <div className="mb-4 rounded-2xl border border-violet-200/80 bg-violet-50 px-4 py-3 text-slate-700 shadow-sm dark:border-violet-500/20 dark:bg-violet-500/10 dark:text-slate-100">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <p className="text-[10px] font-black uppercase tracking-widest text-violet-500">Spotkanie z grafiku</p>
                        <span className="inline-flex items-center rounded-full border border-violet-200/80 bg-white/80 px-2.5 py-1 text-[10px] font-black tracking-wider text-violet-600 dark:border-violet-500/20 dark:bg-slate-900/35 dark:text-violet-300">
                            {new Date(linkedMeeting.scheduled_at).toLocaleString('pl-PL', {
                                day: '2-digit',
                                month: '2-digit',
                                year: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit'
                            })}
                        </span>
                    </div>
                    <div className="mt-2 grid gap-1 min-[430px]:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] min-[430px]:items-center min-[430px]:gap-3">
                        <p className="truncate text-sm font-black">{linkedMeeting.client_name}</p>
                        {linkedMeetingDirectionsHref ? (
                            <a
                                href={linkedMeetingDirectionsHref}
                                target="_blank"
                                rel="noreferrer"
                                className="truncate text-[11px] text-cyan-700 underline decoration-cyan-300 underline-offset-2 opacity-100 min-[430px]:text-right dark:text-cyan-300"
                            >
                                {linkedMeeting.address}
                            </a>
                        ) : (
                            <p className="truncate text-[11px] opacity-80 min-[430px]:text-right">{linkedMeeting.address}</p>
                        )}
                    </div>
                    {linkedMeeting.phone && (
                        linkedMeetingPhoneHref ? (
                            <a
                                href={linkedMeetingPhoneHref}
                                className="mt-3 block text-[11px] font-semibold text-cyan-700 underline decoration-cyan-300 underline-offset-2 dark:text-cyan-300"
                            >
                                📞 {linkedMeeting.phone}
                            </a>
                        ) : (
                            <p className="mt-3 text-[11px] font-semibold opacity-80">📞 {linkedMeeting.phone}</p>
                        )
                    )}
                </div>
            </div>
        </div>
    ) : null

    return (
        <div className="max-w-lg mx-auto px-4 py-6">
            <button onClick={handleAbandonSurvey} className="flex items-center gap-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 mb-4 text-sm">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>Powrót
            </button>

            <div className="mb-4">
                <p className="text-cyan-600 dark:text-cyan-400 text-xs font-bold uppercase tracking-widest">Umowa</p>
                <h2 className="text-lg font-bold">Świadczenie pomocy prawnej</h2>
                <p className="text-[10px] text-gray-400 font-black uppercase tracking-widest mt-0.5">Twoje dzisiejsze postępy  · <span className="text-teal-500">v{APP_VERSION}</span></p>
            </div>



            {linkedMeetingCard}

            <div className="flex gap-1 mb-4">
                {steps.map((s, i) => (
                    <div key={s.key} className="flex-1">
                        <div className={`h-1.5 rounded-full transition-all duration-300 ${isSuccess ? 'bg-green-500' : i < si ? 'bg-green-400' : i === si ? 'bg-cyan-500' : 'bg-gray-200 dark:bg-slate-700'}`} />
                        <p className={`text-[9px] mt-1 text-center font-medium ${isSuccess || i <= si ? 'text-gray-500 dark:text-gray-400' : 'text-gray-300 dark:text-gray-600'}`}>{s.label}</p>
                    </div>
                ))}
            </div>

            <div className={`${card} p-5`}>
                <AnimatePresence mode="wait">
                    {currentSection && (
                        <motion.div key={currentSection.key} variants={slide} initial="enter" animate="center" exit="exit" transition={{ duration: 0.25 }} className="space-y-4">
                            <div className="space-y-1">
                                <p className="text-[10px] font-black uppercase tracking-widest text-cyan-500">{currentSection.label}</p>
                                <h3 className="text-base font-black text-slate-900 dark:text-white">{currentSection.description}</h3>
                            </div>

                            <div className="space-y-4">
                                {currentFields.map((field) => renderSectionField(field))}
                                {currentSection.key === 'client' && (
                                    <div className={sectionBg}>
                                        <div className="flex items-start justify-between gap-3">
                                            <div>
                                                <p className="text-[10px] font-semibold uppercase tracking-wider text-cyan-600 dark:text-cyan-400">
                                                    Dodatkowe osoby podpisujące
                                                </p>
                                                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                                                    Przy wspólnej umowie dodaj kolejnych podpisujących. Jeśli ich adres jest taki sam,
                                                    pole adresu możesz zostawić puste.
                                                </p>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => setAdditionalContractParties((current) => [...current, createAdditionalContractPartyDraft()])}
                                                className="shrink-0 rounded-full border border-cyan-200 bg-cyan-50 px-3 py-1.5 text-[11px] font-semibold text-cyan-700 transition-colors hover:bg-cyan-100 dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:text-cyan-300 dark:hover:bg-cyan-500/20"
                                            >
                                                + Dodaj osobę
                                            </button>
                                        </div>
                                        {additionalContractParties.length > 0 ? (
                                            <div className="mt-4 space-y-3">
                                                {additionalContractParties.map((party, index) => {
                                                    const partyError = additionalContractPartyErrors[index]

                                                    return (
                                                        <div key={party.id} className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-slate-600 dark:bg-slate-800/80">
                                                            <div className="mb-3 flex items-center justify-between gap-3">
                                                                <p className="text-xs font-black uppercase tracking-widest text-slate-600 dark:text-slate-300">
                                                                    Podpisujący {index + 2}
                                                                </p>
                                                                <button
                                                                    type="button"
                                                                    onClick={() =>
                                                                        setAdditionalContractParties((current) =>
                                                                            current.filter((currentParty) => currentParty.id !== party.id)
                                                                        )
                                                                    }
                                                                    className="rounded-full border border-red-200 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-red-500 hover:bg-red-50 dark:border-red-500/30 dark:text-red-300 dark:hover:bg-red-500/10"
                                                                >
                                                                    Usuń
                                                                </button>
                                                            </div>
                                                            <div className="space-y-3">
                                                                <div>
                                                                    <label className={label}>Imię i nazwisko</label>
                                                                    <input
                                                                        type="text"
                                                                        value={party.fullName}
                                                                        onChange={(event) =>
                                                                            setAdditionalContractParties((current) =>
                                                                                current.map((currentParty) =>
                                                                                    currentParty.id === party.id
                                                                                        ? { ...currentParty, fullName: sanitizeAdditionalContractPartyValue('fullName', event.target.value) }
                                                                                        : currentParty
                                                                                )
                                                                            )
                                                                        }
                                                                        className={input}
                                                                        placeholder="Imię i nazwisko podpisującego"
                                                                    />
                                                                </div>
                                                                <div>
                                                                    <label className={label}>PESEL</label>
                                                                    <input
                                                                        type="text"
                                                                        value={party.pesel}
                                                                        onChange={(event) =>
                                                                            setAdditionalContractParties((current) =>
                                                                                current.map((currentParty) =>
                                                                                    currentParty.id === party.id
                                                                                        ? { ...currentParty, pesel: sanitizeAdditionalContractPartyValue('pesel', event.target.value) }
                                                                                        : currentParty
                                                                                )
                                                                            )
                                                                        }
                                                                        className={input}
                                                                        inputMode="numeric"
                                                                        placeholder="11 cyfr"
                                                                    />
                                                                </div>
                                                                <div>
                                                                    <label className={label}>Adres podpisującego (opcjonalnie)</label>
                                                                    <textarea
                                                                        value={party.address}
                                                                        onChange={(event) =>
                                                                            setAdditionalContractParties((current) =>
                                                                                current.map((currentParty) =>
                                                                                    currentParty.id === party.id
                                                                                        ? { ...currentParty, address: sanitizeAdditionalContractPartyValue('address', event.target.value) }
                                                                                        : currentParty
                                                                                )
                                                                            )
                                                                        }
                                                                        rows={2}
                                                                        className={`${input} resize-none`}
                                                                        placeholder="Jeśli inny niż główny adres do korespondencji"
                                                                    />
                                                                </div>
                                                                {partyError && (
                                                                    <p className="text-[11px] font-semibold text-red-500 dark:text-red-400">{partyError}</p>
                                                                )}
                                                            </div>
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        ) : (
                                            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                                                Brak dodatkowych podpisujących.
                                            </p>
                                        )}
                                    </div>
                                )}
                            </div>

                            <div className="flex gap-3 pt-2">
                                <button onClick={goToPrevStep} className={btnBack}>← Wstecz</button>
                                <button onClick={goToNextStep} disabled={!isCurrentSectionComplete} className={`flex-1 ${btnPrimary}`}>Dalej →</button>
                            </div>
                            <div className="pt-2 border-t border-gray-100 dark:border-slate-700">
                                {renderOtherStatusChooser()}
                            </div>
                        </motion.div>
                    )}

                    {step === 'summary' && (
                        <motion.div key="summary-contract" variants={slide} initial="enter" animate="center" exit="exit" transition={{ duration: 0.25 }} className="space-y-4">
                            <div className="space-y-1">
                                <p className="text-[10px] font-black uppercase tracking-widest text-cyan-500">Podsumowanie</p>
                                <h3 className="text-base font-black text-slate-900 dark:text-white">Podgląd danych umowy przed zapisem</h3>
                            </div>

                            <div className="space-y-3 text-sm">
                                {CONTRACT_SECTIONS.map((section) => (
                                    <div key={section.key} className={sectionBg}>
                                        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-cyan-600 dark:text-cyan-400">{section.label}</p>
                                        <div className="space-y-2">
                                            {QS.filter((field) => field.section === section.key).map((field) => (
                                                <div key={field.id} className="flex items-start justify-between gap-3 border-b border-gray-100 py-2 last:border-0 dark:border-slate-700">
                                                    <span className="flex-1 text-xs text-gray-500 dark:text-gray-400">{field.text}</span>
                                                    <span className="max-w-[52%] text-right text-xs font-bold text-slate-800 dark:text-slate-200">
                                                        {formatContractSummaryValue(field.id, answers[field.id] || '')}
                                                    </span>
                                                </div>
                                            ))}
                                            <p className="mt-2 text-[11px] font-bold text-cyan-700 dark:text-cyan-300">
                                                Wariant umowy: {selectedContractTemplate.label}
                                            </p>
                                            {section.key === 'client' && additionalContractParties.length > 0 && (
                                                <div className="mt-3 rounded-xl border border-cyan-200/70 bg-cyan-50/70 px-3 py-2 dark:border-cyan-500/20 dark:bg-cyan-500/10">
                                                    <p className="text-[10px] font-black uppercase tracking-widest text-cyan-700 dark:text-cyan-300">
                                                        Dodatkowi podpisujący
                                                    </p>
                                                    <div className="mt-2 space-y-2">
                                                        {additionalContractParties.map((party, index) => (
                                                            <div key={party.id} className="text-xs text-slate-700 dark:text-slate-200">
                                                                <p className="font-bold">
                                                                    {index + 2}. {party.fullName || 'Brak imienia i nazwiska'}
                                                                </p>
                                                                <p>PESEL: {party.pesel || 'Brak'}</p>
                                                                <p>Adres: {party.address || getAnswerValue(answers, 'correspondence_address') || getAnswerValue(answers, 'property_address') || 'Brak'}</p>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                ))}

                                <div className={sectionBg}>
                                    <div className="flex items-start justify-between gap-3">
                                        <div>
                                            <p className="text-[10px] font-semibold uppercase tracking-wider text-cyan-600 dark:text-cyan-400">Treść umowy</p>
                                            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                                                Pełna treść jest schowana, żeby nie zajmowała całego ekranu. Możesz ją rozwinąć albo otworzyć gotową wersję do druku.
                                            </p>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => setShowContractPreview((current) => !current)}
                                            className="shrink-0 rounded-full border border-cyan-200 bg-cyan-50 px-3 py-1.5 text-[11px] font-semibold text-cyan-700 transition-colors hover:bg-cyan-100 dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:text-cyan-300 dark:hover:bg-cyan-500/20"
                                        >
                                            {showContractPreview ? 'Zwiń' : 'Pokaż'}
                                        </button>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={openPrintableContract}
                                        className="mt-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                                    >
                                        Otwórz komplet umowy i załączników do druku / PDF
                                    </button>
                                    {showContractPreview && (
                                        <div className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-white/80 px-3 py-3 text-[11px] leading-5 text-slate-700 shadow-inner dark:bg-slate-900/40 dark:text-slate-200">
                                            {contractPreview}
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="flex gap-3 pt-2">
                                <button onClick={goToPrevStep} className={btnBack}>← Wstecz</button>
                                <button
                                    onClick={() => save('completed')}
                                    disabled={saving || !!saved || requiredFieldsMissing}
                                    className="flex-1 rounded-lg bg-green-500 py-3 text-sm font-bold text-white transition-colors hover:bg-green-600 disabled:opacity-50"
                                >
                                    {saving ? 'Zapisywanie...' : 'Zapisz umowę'}
                                </button>
                            </div>
                            {saveError && (
                                <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-xs font-bold text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
                                    {saveError}
                                </div>
                            )}
                            <div className="pt-2 border-t border-gray-100 dark:border-slate-700">
                                {renderOtherStatusChooser(saving || !!saved)}
                            </div>
                        </motion.div>
                    )}

                    {step === 'address' && (
                        <motion.div key="a" variants={slide} initial="enter" animate="center" exit="exit" transition={{ duration: 0.25 }} className="space-y-4">
                            <label className={label}>Adres nieruchomości</label>
                            <button type="button" onClick={fetchGeoAddress} disabled={geoLoading} className="w-full flex items-center justify-center gap-2 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400 font-medium py-2.5 rounded-lg text-sm transition-colors hover:bg-blue-100 dark:hover:bg-blue-900/30 disabled:opacity-40">
                                {geoLoading ? (
                                    <><span className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" /> Pobieranie danych...</>
                                ) : (
                                    <><span>📍</span> {linkedMeeting ? 'Pobierz adres dla wybranego spotkania' : initialCoords ? 'Pobierz adres z przypisanej lokalizacji' : 'Użyj aktualnej lokalizacji GPS'}</>
                                )}
                            </button>
                            <textarea value={address} onChange={(e) => setAddress(e.target.value)} placeholder="np. ul. Kwiatowa 15, Warszawa" rows={3} className={`${input} resize-none`} />
                            {coords && <p className="text-[10px] text-green-500 font-bold flex items-center gap-1"><span>✓</span> Lokalizacja przypisana ({coords.lat.toFixed(5)}, {coords.lng.toFixed(5)})</p>}
                            <div className="flex flex-col gap-3 pt-2">
                                <button onClick={() => { setQi(0); setStep('questions') }} disabled={!address.trim()} className={`w-full ${btnPrimary}`}>Dalej →</button>
                                {renderOtherStatusChooser()}
                            </div>
                        </motion.div>
                    )}

                    {step === 'questions' && cur && (
                        <motion.div key={`q-${cur.id}`} variants={slide} initial="enter" animate="center" exit="exit" transition={{ duration: 0.25 }} className="space-y-4">
                            <div className="flex items-center justify-between">
                                <span className="text-xs font-medium text-gray-400">Pytanie {qi + 1} z {total}</span>
                                <div className="flex gap-1">{QS.map((_, i) => (<div key={i} className={`h-1.5 rounded-full transition-all duration-300 ${i < qi ? 'w-1.5 bg-green-400' : i === qi ? 'w-5 bg-cyan-500' : 'w-1.5 bg-gray-200 dark:bg-slate-700'}`} />))}</div>
                            </div>
                            <h3 className="text-base font-semibold leading-relaxed">{qi + 1}. {cur.text}</h3>
                            {cur.type === 'radio' && cur.options && (
                                <div className="space-y-4">
                                    <div className="space-y-2">{cur.options.map((o) => (
                                        <button key={o} onClick={() => pick(cur.id, o)} className={`w-full text-left px-4 py-3 rounded-lg text-sm font-medium transition-all border flex items-center gap-3 ${answers[cur.id] === o ? 'bg-cyan-50 dark:bg-cyan-900/20 border-cyan-400 dark:border-cyan-500 text-cyan-800 dark:text-cyan-300' : 'bg-gray-50 dark:bg-slate-700/50 border-gray-200 dark:border-slate-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700'}`}>
                                            <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${answers[cur.id] === o ? 'border-cyan-500 bg-cyan-500' : 'border-gray-300 dark:border-slate-500'}`}>{answers[cur.id] === o && <div className="w-1.5 h-1.5 bg-white rounded-full" />}</div>{o}
                                        </button>
                                    ))}</div>
                                    <button 
                                        onClick={nextT} 
                                        disabled={!answers[cur.id]} 
                                        className={btnPrimary}
                                    >Dalej →</button>
                                    <div className="pt-2 border-t border-gray-100 dark:border-slate-700 mt-2">
                                        {renderOtherStatusChooser()}
                                    </div>
                                </div>
                            )}
                            {cur.type === 'text' && (
                                <div className="space-y-3">
                                    <input type="text" value={answers[cur.id] || ''} onChange={(e) => setAnswers({ ...answers, [cur.id]: e.target.value })} placeholder={cur.placeholder} className={input} />
                                    {cur.suffix && <p className="text-gray-400 text-xs">{cur.suffix}</p>}
                                    <button 
                                        onClick={nextT} 
                                        disabled={!answers[cur.id]?.trim()} 
                                        className={btnPrimary}
                                    >Dalej →</button>
                                    <div className="pt-2 border-t border-gray-100 dark:border-slate-700 mt-2">
                                        {renderOtherStatusChooser()}
                                    </div>
                                </div>
                            )}
                            <button onClick={prevQ} className="w-full text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-[10px] font-black uppercase tracking-widest text-center pt-2">← Wstecz</button>
                        </motion.div>
                    )}

                    {step === 'personal' && (
                        <motion.div key="p" variants={slide} initial="enter" animate="center" exit="exit" transition={{ duration: 0.25 }} className="space-y-4">
                            <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-300">Dane właściciela gruntu</h3>
                            <div className="space-y-4">
                                <div><label className={label}>Imię i nazwisko</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jan Kowalski" className={input} /></div>
                                <div><label className={label}>Numer telefonu</label><input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="500 600 700" className={input} /></div>
                            </div>
                             <div className="w-full pb-2">
                                 <label className={label}>Data spotkania / kontaktu</label>
                                 <input 
                                     type="date" 
                                     value={date} 
                                     min={getLocalTodayDateInput()}
                                     onChange={(e) => { setDate(e.target.value); setTime(''); }} 
                                     className={`${input} max-w-full`} 
                                 />
                             </div>

                            <AppointmentPicker 
                                selectedDate={date} 
                                selectedTime={time} 
                                onSelect={setTime} 
                            />

                            <div className="flex gap-3 pt-2">
                                <button onClick={() => { setQi(total - 1); setStep('questions') }} className={btnBack}>← Wstecz</button>
                                <button 
                                    onClick={() => setStep('summary')} 
                                    disabled={!name.trim() || name.trim().length < 3 || !phone.trim() || phone.trim().replace(/\s/g, '').length < 9 || !date || !time} 
                                    className={`flex-1 ${btnPrimary}`}
                                >Podsumowanie →</button>
                            </div>
                            <div className="pt-2 border-t border-gray-100 dark:border-slate-700">
                                {renderOtherStatusChooser()}
                            </div>
                        </motion.div>
                    )}

                    {showLegacySummaryStep && step === 'summary' && (
                        <motion.div key="s" variants={slide} initial="enter" animate="center" exit="exit" transition={{ duration: 0.25 }} className="space-y-4">
                            <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-300">Podsumowanie</h3>
                            <div className="space-y-3 text-sm">
                                <div className={sectionBg}><p className="text-cyan-600 dark:text-cyan-400 text-[10px] uppercase tracking-wider mb-1 font-semibold">Adres</p><p>{address}</p></div>
                                <div className={sectionBg}>
                                    <p className="text-cyan-600 dark:text-cyan-400 text-[10px] uppercase tracking-wider mb-2 font-semibold">Odpowiedzi</p>
                                    {QS.map((q, idx) => {
                                        const ans = answers[q.id] || "-"
                                        return (
                                            <div key={q.id} className="flex items-start justify-between py-2 border-b border-gray-100 dark:border-slate-700 last:border-0 gap-3">
                                                <span className="text-gray-500 dark:text-gray-400 text-xs flex-1">{idx + 1}. {q.text}</span>
                                                <span className="text-xs font-bold text-slate-800 dark:text-slate-200 text-right shrink-0 max-w-[50%] wrap-break-word">{ans}</span>
                                            </div>
                                        )
                                    })}
                                </div>
                                <div className={sectionBg}><p className="text-cyan-600 dark:text-cyan-400 text-[10px] uppercase tracking-wider mb-1 font-semibold">Respondent</p><p>{name}</p><p className="text-gray-500 dark:text-gray-400 text-xs">{phone} · {date} {time}</p></div>
                            </div>
                            <div className="flex gap-3 pt-2">
                                <button onClick={() => setStep('personal')} className={btnBack}>← Wstecz</button>
                                <button 
                                    onClick={() => save('completed')} 
                                    disabled={saving || !!saved || QS.some(q => q.conditional ? (answers[q.conditional.questionId] === q.conditional.answer && !answers[q.id]) : !answers[q.id])} 
                                    className="flex-1 bg-green-500 hover:bg-green-600 text-white font-bold py-3 rounded-lg text-sm transition-colors disabled:opacity-50"
                                >
                                    {saving ? 'Zapisywanie...' : 'Zapisz umowę'}
                                </button>
                            </div>
                            {saveError && (
                                <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-xs rounded-lg font-bold">
                                    {saveError}
                                </div>
                            )}
                            <div className="pt-2 border-t border-gray-100 dark:border-slate-700">
                                {renderOtherStatusChooser(saving || !!saved)}
                            </div>
                        </motion.div>
                    )}
                    {step === 'success' && (
                        <motion.div key="success" variants={slide} initial="enter" animate="center" exit="exit" transition={{ duration: 0.25 }} className="py-4 text-center">
                            {(() => {
                                const isCompletedSave = savedSurveyStatus === 'completed'
                                const successTitle = saved === 'online'
                                    ? (isCompletedSave ? 'Umowa zapisana!' : 'Status spotkania zapisany!')
                                    : (isCompletedSave ? 'Zapisano umowę w trybie offline' : 'Zapisano status w trybie offline')
                                const successDescription = saved === 'online'
                                    ? (isCompletedSave ? 'Dane umowy przesłane na serwer.' : 'Status spotkania został zapisany w systemie.')
                                    : (isCompletedSave
                                        ? 'Formularz umowy zostanie zsynchronizowany automatycznie po odzyskaniu połączenia z internetem.'
                                        : 'Status spotkania zostanie zsynchronizowany automatycznie po odzyskaniu połączenia z internetem.')

                                return (
                                    <>
                            <div className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 border ${saved === 'online' ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800' : 'bg-cyan-50 dark:bg-cyan-900/20 border-cyan-200 dark:border-cyan-800'}`}>
                                {saved === 'online'
                                    ? <svg className="w-8 h-8 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                                    : <svg className="w-8 h-8 text-cyan-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" /></svg>}
                            </div>
                            <h2 className="text-xl font-bold mb-1">{successTitle}</h2>
                            <p className={`text-sm mb-6 ${saved === 'online' ? 'text-gray-400' : 'text-cyan-600 dark:text-cyan-500 font-medium'}`}>{successDescription}</p>

                            {meetingDurationLabel && (
                                <div className="mb-6 rounded-2xl border border-violet-200/80 bg-violet-50 px-4 py-3 text-left shadow-sm dark:border-violet-500/20 dark:bg-violet-500/10">
                                    <p className="text-[10px] font-black uppercase tracking-widest text-violet-500">Czas spotkania</p>
                                    <p className="mt-1 text-sm font-black text-slate-800 dark:text-slate-100">{meetingDurationLabel}</p>
                                </div>
                            )}

                            {saveError && (
                                <div className="bg-red-50 text-red-600 p-3 rounded-lg text-xs font-mono text-left mb-6 overflow-auto border border-red-200">
                                    <strong>Błąd zapisu:</strong> {saveError}
                                </div>
                            )}
                            {isCompletedSave && (
                                <button
                                    type="button"
                                    onClick={openPrintableContract}
                                    className="mb-3 w-full rounded-xl border border-cyan-200 bg-cyan-50 px-4 py-3 text-sm font-semibold text-cyan-700 transition-colors hover:bg-cyan-100 dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:text-cyan-300 dark:hover:bg-cyan-500/20"
                                >
                                    Otwórz komplet umowy i załączników do druku / PDF
                                </button>
                            )}
                            <div className="space-y-3">
                                {linkedMeeting ? (
                                    <button onClick={handleAbandonSurvey} className={btnPrimary}>Wróć do grafiku spotkań</button>
                                ) : (
                                    <button onClick={reset} className={btnPrimary}>+ Kolejna umowa</button>
                                )}
                                <button onClick={handleAbandonSurvey} className={`w-full ${btnBack}`}>← Powrót do panelu</button>
                            </div>
                                    </>
                                )
                            })()}
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            <AnimatePresence>
                {showQualification && (
                    <div className="fixed inset-0 z-100 flex items-center justify-center p-4">
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
                        />
                        <motion.div
                            initial={{ opacity: 0, scale: 0.9, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.9, y: 20 }}
                            className="relative w-full max-w-sm bg-white dark:bg-slate-800 rounded-2xl shadow-2xl overflow-hidden"
                        >
                            <div className="bg-teal-500/10 dark:bg-teal-500/20 p-6 flex flex-col items-center text-center">
                                <div className="w-16 h-16 bg-teal-500 text-white rounded-full flex items-center justify-center text-3xl mb-4 shadow-lg shadow-teal-500/30">
                                    ✓
                                </div>
                                <h3 className="text-xl font-black text-slate-800 dark:text-white mb-2">Gratulacje!</h3>
                                <p className="text-sm text-slate-600 dark:text-slate-300">
                                    Na podstawie wywiadu, ta nieruchomość wstępnie kwalifikuje się do programu służebności przesyłu.
                                </p>
                            </div>
                            <div className="p-6">
                                <button
                                    onClick={() => {
                                        setShowQualification(false)
                                        setStep('personal')
                                    }}
                                    className="w-full bg-teal-500 hover:bg-teal-600 text-white font-bold py-3.5 rounded-xl transition-all shadow-md active:scale-95"
                                >
                                    Pobierz dane respondenta →
                                </button>
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {showOtherStatusOptions && (
                    <div className="fixed inset-0 z-100 flex items-end sm:items-center justify-center p-4">
                        <motion.button
                            type="button"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            onClick={() => setShowOtherStatusOptions(false)}
                            className="absolute inset-0 bg-slate-900/65 backdrop-blur-[2px]"
                            aria-label="Zamknij wybor statusu"
                        />

                        <motion.div
                            initial={{ opacity: 0, y: 24, scale: 0.96 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 24, scale: 0.96 }}
                            transition={{ duration: 0.2 }}
                            className="relative w-full max-w-md rounded-2xl border border-gray-200/80 dark:border-slate-600 bg-white dark:bg-slate-800 shadow-2xl p-5"
                        >
                            <div className="mb-4">
                                <p className="text-[10px] uppercase tracking-widest font-black text-cyan-500">Szybka zmiana</p>
                                <h3 className="text-base font-black text-slate-800 dark:text-slate-100">Wybierz wynik spotkania</h3>
                                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Kontakt ponowny otwiera kalendarz, a odmowa po spotkaniu przechodzi do osobnego formularza notatki.</p>
                            </div>

                            <div className="space-y-3">
                                <div className="space-y-3">
                                    <div className="space-y-3">
                                        <button
                                            type="button"
                                            onClick={openAttemptedStatusModal}
                                            className="w-full rounded-xl border border-cyan-300 dark:border-cyan-500/40 bg-cyan-50 dark:bg-cyan-900/20 px-4 py-3 text-left transition-colors hover:bg-cyan-100 dark:hover:bg-cyan-900/30"
                                        >
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <span className="block text-sm font-black text-cyan-700 dark:text-cyan-300">Kontakt ponowny</span>
                                                    <span className="block text-[10px] font-semibold uppercase tracking-wider text-cyan-600/90 dark:text-cyan-300/80">Otwórz kalendarz i ustaw nowy termin kontaktu</span>
                                                </div>
                                                <span className="shrink-0 rounded-full border border-cyan-300/70 bg-white/80 px-2 py-1 text-[9px] font-black uppercase tracking-[0.18em] text-cyan-700 dark:border-cyan-400/30 dark:bg-slate-900/40 dark:text-cyan-200">
                                                    Otwórz
                                                </span>
                                            </div>
                                        </button>
                                        {showAttemptedStatusForm && (
                                            <div className="mt-3 space-y-3 rounded-2xl border border-cyan-200/80 bg-cyan-50/70 p-4 dark:border-cyan-500/20 dark:bg-cyan-900/10">
                                            <div className="space-y-1">
                                                <p className="text-[10px] uppercase tracking-widest font-bold text-gray-500 ml-1">Telefon do oddzwonienia</p>
                                                <input
                                                    type="tel"
                                                    placeholder="Np. 500 600 700"
                                                    value={attemptedPhone}
                                                    onChange={(e) => setAttemptedPhone(e.target.value)}
                                                    className={`${input} text-xs py-2`}
                                                />
                                            </div>

                                            <div className="space-y-1">
                                                <p className="text-[10px] uppercase tracking-widest font-bold text-gray-500 ml-1">Kiedy oddzwonić / umówić</p>
                                                <input
                                                    type="date"
                                                    value={attemptedDate}
                                                    min={getLocalTodayDateInput()}
                                                    onChange={(e) => {
                                                        setAttemptedDate(e.target.value)
                                                        setAttemptedTime('')
                                                    }}
                                                    className={`${input} text-xs py-2`}
                                                />
                                            </div>

                                            <AppointmentPicker
                                                selectedDate={attemptedDate}
                                                selectedTime={attemptedTime}
                                                onSelect={setAttemptedTime}
                                            />

                                            <div className="space-y-1">
                                            <p className="text-[10px] uppercase tracking-widest font-bold text-gray-500 ml-1">Krótka notatka *</p>
                                            <input 
                                                type="text" 
                                                placeholder="Np. Pani prosiła by dzwonić po 16, syn jest w domu..."
                                                value={attemptedNote}
                                                onChange={(e) => setAttemptedNote(e.target.value)}
                                                className={`${input} text-xs py-2`}
                                            />
                                            <button
                                                type="button"
                                                onClick={() => void save('attempted')}
                                                disabled={saving || !attemptedCanSave}
                                                className="mt-3 w-full rounded-xl bg-cyan-500 px-4 py-3 text-sm font-black text-white transition-colors hover:bg-cyan-600 disabled:cursor-not-allowed disabled:opacity-40"
                                            >
                                                Zapisz kontakt ponowny
                                            </button>
                                        </div>
                                    </div>
                                        )}

                                    <div className="w-full h-px bg-gray-100 dark:bg-slate-700 my-2" />

                                    <button
                                        type="button"
                                        onClick={() => openPostMeetingStatusModal('refused')}
                                        disabled={saving}
                                        className="w-full rounded-xl border border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-left transition-colors hover:bg-red-100 dark:hover:bg-red-900/30"
                                    >
                                        <span className="block text-sm font-black text-red-600 dark:text-red-400">Odmowa po spotkaniu</span>
                                        <span className="block text-[10px] font-semibold uppercase tracking-wider text-red-500/90 dark:text-red-300/80">Rozmowa odbyta, ale klient odmówił dalszych działań</span>
                                    </button>
                                </div>
                            </div>
                        </div>

                            <button
                                type="button"
                                onClick={() => setShowOtherStatusOptions(false)}
                                className="mt-4 w-full py-2.5 text-xs font-black uppercase tracking-widest rounded-xl border border-gray-200 dark:border-slate-600 text-gray-500 dark:text-gray-300 bg-gray-50 dark:bg-slate-700/40 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
                            >
                                Anuluj
                            </button>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {showAttemptedStatusModal && (
                    <div className="fixed inset-0 z-110 flex items-end sm:items-center justify-center p-4">
                        <motion.button
                            type="button"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            onClick={() => setShowAttemptedStatusModal(false)}
                            className="absolute inset-0 bg-slate-900/70 backdrop-blur-[3px]"
                            aria-label="Zamknij kontakt ponowny"
                        />

                        <motion.div
                            initial={{ opacity: 0, y: 24, scale: 0.96 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 24, scale: 0.96 }}
                            transition={{ duration: 0.2 }}
                            className="ui-modal-panel relative w-full max-w-lg max-h-[88vh] overflow-y-auto rounded-2xl border border-cyan-200/80 dark:border-cyan-500/30 bg-white dark:bg-slate-800 shadow-2xl p-5"
                        >
                            <div className="mb-4 flex items-start justify-between gap-3">
                                <div>
                                    <p className="text-[10px] uppercase tracking-widest font-black text-cyan-500">Kontakt ponowny</p>
                                    <h3 className="text-base font-black text-slate-800 dark:text-slate-100">Ustaw nowy termin kontaktu</h3>
                                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Wybierz telefon, dzień i godzinę z grafiku.</p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setShowAttemptedStatusModal(false)}
                                    className="rounded-xl border border-gray-200 dark:border-slate-600 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-gray-500 dark:text-gray-300 bg-gray-50 dark:bg-slate-700/40 hover:bg-gray-100 dark:hover:bg-slate-700"
                                >
                                    Zamknij
                                </button>
                            </div>

                            <div className="space-y-4">
                                {saveError && (
                                    <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-600 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
                                        {saveError}
                                    </div>
                                )}

                                <div className="space-y-1">
                                    <p className="text-[10px] uppercase tracking-widest font-bold text-gray-500 ml-1">Telefon do oddzwonienia</p>
                                    <input
                                        type="tel"
                                        placeholder="Np. 500 600 700"
                                        value={attemptedPhone}
                                        onChange={(e) => setAttemptedPhone(e.target.value)}
                                        className={`${input} text-xs py-2`}
                                    />
                                </div>

                                <div className="space-y-1">
                                    <p className="text-[10px] uppercase tracking-widest font-bold text-gray-500 ml-1">Kiedy oddzwonić / umówić</p>
                                    <input
                                        type="date"
                                        value={attemptedDate}
                                        min={getLocalTodayDateInput()}
                                        onChange={(e) => {
                                            setAttemptedDate(e.target.value)
                                            setAttemptedTime('')
                                        }}
                                        className={`${input} text-xs py-2`}
                                    />
                                </div>

                                <AppointmentPicker
                                    selectedDate={attemptedDate}
                                    selectedTime={attemptedTime}
                                    onSelect={setAttemptedTime}
                                />

                                <div className="space-y-1">
                                    <p className="text-[10px] uppercase tracking-widest font-bold text-gray-500 ml-1">Krótka notatka *</p>
                                    <input
                                        type="text"
                                        placeholder="Np. Pani prosiła by dzwonić po 16, syn jest w domu..."
                                        value={attemptedNote}
                                        onChange={(e) => setAttemptedNote(e.target.value)}
                                        className={`${input} text-xs py-2`}
                                    />
                                </div>

                                <div className="flex flex-col gap-2 sm:flex-row">
                                    <button
                                        type="button"
                                        onClick={() => setShowAttemptedStatusModal(false)}
                                        className="w-full rounded-xl border border-gray-200 dark:border-slate-600 text-gray-500 dark:text-gray-300 bg-gray-50 dark:bg-slate-700/40 hover:bg-gray-100 dark:hover:bg-slate-700 px-4 py-3 text-sm font-black transition-colors"
                                    >
                                        Anuluj
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void save('attempted')}
                                        disabled={saving || !attemptedCanSave}
                                        className="w-full rounded-xl bg-cyan-500 px-4 py-3 text-sm font-black text-white transition-colors hover:bg-cyan-600 disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                        Zapisz kontakt ponowny
                                    </button>
                                </div>
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {showPostMeetingStatusModal && postMeetingStatus && (
                    <div className="fixed inset-0 z-110 flex items-end sm:items-center justify-center p-4">
                        <motion.button
                            type="button"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            onClick={() => setShowPostMeetingStatusModal(false)}
                            className="absolute inset-0 bg-slate-900/70 backdrop-blur-[3px]"
                            aria-label="Zamknij formularz statusu spotkania"
                        />

                        <motion.div
                            initial={{ opacity: 0, y: 24, scale: 0.96 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 24, scale: 0.96 }}
                            transition={{ duration: 0.2 }}
                            className="ui-modal-panel relative w-full max-w-lg max-h-[88vh] overflow-y-auto rounded-2xl border border-gray-200/80 bg-white p-5 shadow-2xl dark:border-slate-600 dark:bg-slate-800"
                        >
                            <div className="mb-4 flex items-start justify-between gap-3">
                                <div>
                                    <p className="text-[10px] uppercase tracking-widest font-black text-cyan-500">Status po spotkaniu</p>
                                    <h3 className="text-base font-black text-slate-800 dark:text-slate-100">
                                        {getPostMeetingStatusTitle(postMeetingStatus)}
                                    </h3>
                                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                                        {getPostMeetingStatusDescription(postMeetingStatus)}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setShowPostMeetingStatusModal(false)}
                                    className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-gray-500 transition-colors hover:bg-gray-100 dark:border-slate-600 dark:bg-slate-700/40 dark:text-gray-300 dark:hover:bg-slate-700"
                                >
                                    Zamknij
                                </button>
                            </div>

                            <div className="space-y-4">
                                {saveError && (
                                    <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-600 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
                                        {saveError}
                                    </div>
                                )}

                                <div className="rounded-2xl border border-slate-200/80 bg-slate-50/85 p-3 dark:border-slate-700 dark:bg-slate-950/35">
                                    <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
                                        Wybrany status
                                    </p>
                                    <p className="mt-1 text-sm font-black text-slate-900 dark:text-white">
                                        {getPostMeetingStatusLabel(postMeetingStatus)}
                                    </p>
                                </div>

                                <div className="space-y-1">
                                    <p className="text-[10px] uppercase tracking-widest font-bold text-gray-500 ml-1">
                                        {getPostMeetingStatusNoteLabel(postMeetingStatus)}
                                        {postMeetingStatusRequiresNote(postMeetingStatus) ? ' *' : ''}
                                    </p>
                                    <textarea
                                        value={postMeetingStatusNote}
                                        onChange={(event) => setPostMeetingStatusNote(event.target.value)}
                                        placeholder={getPostMeetingStatusPlaceholder(postMeetingStatus)}
                                        className={`${input} min-h-[132px] resize-y text-sm`}
                                    />
                                </div>

                                <div className="flex flex-col gap-2 sm:flex-row">
                                    <button
                                        type="button"
                                        onClick={() => setShowPostMeetingStatusModal(false)}
                                        className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm font-black text-gray-500 transition-colors hover:bg-gray-100 dark:border-slate-600 dark:bg-slate-700/40 dark:text-gray-300 dark:hover:bg-slate-700"
                                    >
                                        Anuluj
                                    </button>
                                    <button
                                        type="button"
                                        onClick={savePostMeetingStatus}
                                        disabled={saving || (postMeetingStatusRequiresNote(postMeetingStatus) && !postMeetingStatusNote.trim())}
                                        className="w-full rounded-xl bg-cyan-500 px-4 py-3 text-sm font-black text-white transition-colors hover:bg-cyan-600 disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                        Zapisz status
                                    </button>
                                </div>
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>
        </div>
    )
}

