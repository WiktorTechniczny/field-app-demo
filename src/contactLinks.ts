import { normalizeSalesMeetingAddress } from './salesMeetingText'

const normalizeInlineValue = (value?: string | null): string => (value || '').trim()

export const buildPhoneHref = (phone?: string | null): string | null => {
    const trimmed = normalizeInlineValue(phone)
    if (!trimmed) return null

    const normalized = trimmed
        .replace(/[^\d+]/g, '')
        .replace(/(?!^)\+/g, '')

    return normalized ? `tel:${normalized}` : null
}

export const buildGoogleMapsDirectionsHref = (address?: string | null): string | null => {
    const trimmed = normalizeSalesMeetingAddress(address)
    if (!trimmed) return null
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(trimmed)}`
}
