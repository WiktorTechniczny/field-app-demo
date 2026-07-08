export type CivicAddressQuality = 'none' | 'partial' | 'full'

const STREET_PREFIX_PATTERN = /\b(ul\.?|aleja|alei|al\.?|os\.?|pl\.?|plac|rondo)\b/iu
const POSTAL_CODE_PATTERN = /\b\d{2}-\d{3}\b/u
const HOUSE_NUMBER_PATTERN = /\b\d+[a-zA-Z]?(?:\/\d+[a-zA-Z]?)?\b/u
const BARE_PROPERTY_NUMBER_PATTERN = /^\d+[a-zA-Z]?(?:\/\d+[a-zA-Z]?)?$/u
const RURAL_LOCALITY_NUMBER_PATTERN = /^[^\d,]+?\s+\d+[a-zA-Z]?(?:\/\d+[a-zA-Z]?)?(?:\s*,.*)?$/u
const ADMIN_PRECINCT_PLACEHOLDER_PATTERN = /^obr(?:\.|eb|ęb)?\s*\d+(?:[./-]\d+)*$/iu

export const normalizeCivicAddress = (value?: string | null): string => `${value || ''}`.trim()

export const isAdministrativePrecinctPlaceholder = (value?: string | null): boolean => {
    const normalized = normalizeCivicAddress(value)
    if (!normalized) return false

    const firstSegment = normalized.split(',')[0]?.trim() || normalized
    const comparable = firstSegment
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()

    return ADMIN_PRECINCT_PLACEHOLDER_PATTERN.test(comparable)
}

export const isBarePropertyNumberAddress = (value?: string | null): boolean => {
    const normalized = normalizeCivicAddress(value)
    if (!normalized) return false

    const firstSegment = normalized.split(',')[0]?.trim() || normalized
    return BARE_PROPERTY_NUMBER_PATTERN.test(firstSegment)
}

export const extractCivicHouseNumber = (value?: string | null): string | null => {
    const normalized = normalizeCivicAddress(value)
    if (!normalized) return null

    const firstSegment = normalized.split(',')[0]?.trim() || normalized
    const match = firstSegment.match(/\d+[a-zA-Z]?(?:\/\d+[a-zA-Z]?)?/u)
    return match ? match[0] : null
}

export const buildDisplayCivicAddress = (
    value?: string | null,
    ...localityHints: Array<string | null | undefined>
): string => {
    const normalized = normalizeCivicAddress(value)
    if (!normalized) return ''
    if (!isBarePropertyNumberAddress(normalized)) return normalized

    const houseNumber = extractCivicHouseNumber(normalized)
    const locality = localityHints
        .map((hint) => `${hint || ''}`.trim())
        .find((hint) => hint && !/^\d+(?:[./-]\d+)*$/u.test(hint) && !isAdministrativePrecinctPlaceholder(hint))

    return locality && houseNumber ? `${locality} ${houseNumber}` : normalized
}

export const getCivicAddressQuality = (value?: string | null): CivicAddressQuality => {
    const normalized = normalizeCivicAddress(value)
    if (!normalized) return 'none'
    if (/dzia[łl]ka/iu.test(normalized)) return 'none'
    if (isAdministrativePrecinctPlaceholder(normalized)) return 'none'
    if (/^(gps:|punkt:)/iu.test(normalized)) return 'full'
    if (POSTAL_CODE_PATTERN.test(normalized) && HOUSE_NUMBER_PATTERN.test(normalized)) return 'full'
    if (STREET_PREFIX_PATTERN.test(normalized) && HOUSE_NUMBER_PATTERN.test(normalized)) return 'full'
    if (RURAL_LOCALITY_NUMBER_PATTERN.test(normalized)) return 'full'
    if (isBarePropertyNumberAddress(normalized)) return 'partial'
    if (HOUSE_NUMBER_PATTERN.test(normalized) && normalized.includes(',')) return 'partial'
    return 'none'
}

export const hasFullCivicAddress = (value?: string | null): boolean =>
    getCivicAddressQuality(value) === 'full'

export const hasPartialCivicAddress = (value?: string | null): boolean =>
    getCivicAddressQuality(value) === 'partial'
