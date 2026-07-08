const BR_TAG_REGEX = /<br\s*\/?>/gi
const HTML_TAG_REGEX = /<\/?[^>]+>/g
const LOWERCASE_TO_UPPERCASE_WORD_REGEX = /([a-ząćęłńóśźż])([A-ZĄĆĘŁŃÓŚŹŻ])/gu
const LETTER_TO_DIGIT_REGEX = /([A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż])(\d)/gu
const POSTAL_CODE_TO_TEXT_REGEX = /(\d{2}-\d{3})([A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż])/gu
const STREET_PREFIX_REGEX = /\b(ul|al|pl|os)\.\s*/giu
const POSTAL_CODE_REGEX = /(?:,\s*)?\d{2}-\d{3}(?=(?:,|\s|$))/u

export const SALES_MEETING_LEAD_SOURCE_OPTIONS = [
    { value: 'Ankiety', label: 'Ankiety' },
    { value: 'CC', label: 'CC' },
    { value: 'Spotkanie własne', label: 'Spotkanie własne' },
    { value: 'Po kontakcie ponownym', label: 'Po kontakcie ponownym' }
] as const

export const DEFAULT_WORKER_MEETING_LEAD_SOURCE = 'Spotkanie własne'

const normalizeComparableValue = (value: string): string =>
    value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()

const dedupeRepeatedLocality = (value: string): string => {
    const match = value.match(/^(.*?),\s*([^,]+),\s*(\d{2}-\d{3})\s+([^,]+)$/u)
    if (!match) return value

    const [, street, localityBeforePostal, postalCode, localityAfterPostal] = match
    if (normalizeComparableValue(localityBeforePostal) !== normalizeComparableValue(localityAfterPostal)) {
        return value
    }

    return `${street}, ${localityBeforePostal}, ${postalCode}`
}

const decodeBasicEntities = (value: string): string =>
    value
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")

export const normalizeSalesMeetingInlineText = (value: string | null | undefined): string => {
    if (!value) return ''

    return decodeBasicEntities(value)
        .replace(BR_TAG_REGEX, ' / ')
        .replace(HTML_TAG_REGEX, ' ')
        .replace(/\s*\/\s*/g, ' / ')
        .replace(/\s+/g, ' ')
        .trim()
}

export const normalizeSalesMeetingAddress = (value: string | null | undefined): string => {
    const inline = normalizeSalesMeetingInlineText(value)
    if (!inline) return ''

    return dedupeRepeatedLocality(
        inline
            .replace(/[;]+/g, ', ')
            .replace(LOWERCASE_TO_UPPERCASE_WORD_REGEX, '$1 $2')
            .replace(LETTER_TO_DIGIT_REGEX, '$1 $2')
            .replace(POSTAL_CODE_TO_TEXT_REGEX, '$1 $2')
            .replace(STREET_PREFIX_REGEX, (_, prefix: string) => `${prefix}. `)
            .replace(/\s*,\s*/g, ', ')
            .replace(/\s+/g, ' ')
            .trim()
    )
}

export const stripPostalCodeFromSalesMeetingAddress = (value: string | null | undefined): string =>
    normalizeSalesMeetingAddress(value)
        .replace(POSTAL_CODE_REGEX, '')
        .replace(/\s*,\s*/g, ', ')
        .replace(/\s+/g, ' ')
        .replace(/,\s*$/g, '')
        .trim()
