import type { SalesMeeting } from './db'
import { normalizeSalesMeetingAddress, normalizeSalesMeetingInlineText } from './salesMeetingText'

type MeetingLocationPick = Pick<
    SalesMeeting,
    | 'address'
    | 'region'
    | 'pole_id'
    | 'pole_lat'
    | 'pole_lng'
    | 'parcel_id'
    | 'parcel_number'
    | 'locality_code'
    | 'locality_label'
    | 'municipality'
    | 'precinct'
>

export interface SalesMeetingMapLocation {
    lat: number
    lng: number
    label: string
}

const trimInline = (value?: string | null): string => `${value || ''}`.trim()
const HOUSE_NUMBER_PATTERN = /\b\d+[a-zA-Z]?(?:\/\d+[a-zA-Z]?)?(?=\s*(?:,|$))/u

const uniqueLabels = (values: Array<string | null | undefined>): string[] => {
    const seen = new Set<string>()
    const output: string[] = []

    values.forEach((value) => {
        const normalized = trimInline(value)
        if (!normalized) return

        const key = normalized
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()

        if (seen.has(key)) return
        seen.add(key)
        output.push(normalized)
    })

    return output
}

export const getSalesMeetingParcelLabel = (meeting: Pick<SalesMeeting, 'parcel_number' | 'parcel_id'>): string => {
    const parcelNumber = trimInline(meeting.parcel_number)
    if (parcelNumber) return `Działka ${parcelNumber}`

    const parcelId = trimInline(meeting.parcel_id)
    return parcelId ? `Działka ${parcelId}` : ''
}

export const getSalesMeetingLocalityLabel = (
    meeting: Pick<SalesMeeting, 'locality_label' | 'municipality' | 'precinct' | 'region'>
): string => {
    const [label] = uniqueLabels([
        normalizeSalesMeetingInlineText(meeting.locality_label),
        normalizeSalesMeetingInlineText(meeting.precinct),
        normalizeSalesMeetingInlineText(meeting.municipality),
        normalizeSalesMeetingInlineText(meeting.region)
    ])

    return label || ''
}

export const getSalesMeetingLocationBadges = (meeting: MeetingLocationPick): string[] =>
    uniqueLabels([
        getSalesMeetingParcelLabel(meeting),
        getSalesMeetingLocalityLabel(meeting),
        trimInline(meeting.pole_id) ? `Słup ${trimInline(meeting.pole_id)}` : ''
    ])

export const getSalesMeetingPrimaryLocationLabel = (meeting: MeetingLocationPick): string => {
    const address = normalizeSalesMeetingAddress(meeting.address)
    if (address) return address

    const [firstBadge, secondBadge] = getSalesMeetingLocationBadges(meeting)
    return [firstBadge, secondBadge].filter(Boolean).join(', ') || 'Brak lokalizacji'
}

export const hasSalesMeetingPreciseAddress = (meeting: Pick<SalesMeeting, 'address'>): boolean => {
    const address = normalizeSalesMeetingAddress(meeting.address)
    if (!address) return false
    if (/^(gps:|punkt:)/iu.test(address)) return true
    return HOUSE_NUMBER_PATTERN.test(address)
}

export interface SalesMeetingEnhancedAddress {
    main: string
    suggestion?: string
    isPrecise: boolean
}

export const getSalesMeetingEnhancedAddress = (meeting: MeetingLocationPick): SalesMeetingEnhancedAddress => {
    const isPrecise = hasSalesMeetingPreciseAddress(meeting)
    const primary = normalizeSalesMeetingAddress(meeting.address)

    if (primary && isPrecise) {
        return { main: primary, isPrecise: true }
    }

    const suggestionParts = [
        normalizeSalesMeetingInlineText(meeting.locality_label) || normalizeSalesMeetingInlineText(meeting.precinct),
        normalizeSalesMeetingInlineText(meeting.parcel_number) ? `dz. ${normalizeSalesMeetingInlineText(meeting.parcel_number)}` : null
    ].filter(Boolean).join(', ')

    const fallbackSecondary = [
        normalizeSalesMeetingInlineText(meeting.municipality),
        normalizeSalesMeetingInlineText(meeting.region)
    ].filter(Boolean).join(', ')

    const suggestion = suggestionParts || fallbackSecondary || primary || undefined

    return {
        main: 'Brak dokładnego adresu',
        suggestion: suggestion,
        isPrecise: false
    }
}

export const needsSalesMeetingAddressClarification = (meeting: Pick<SalesMeeting, 'address'>): boolean =>
    !hasSalesMeetingPreciseAddress(meeting)

export const getSalesMeetingMapLocation = (meeting: MeetingLocationPick): SalesMeetingMapLocation | null => {
    const rawLat = meeting.pole_lat
    const rawLng = meeting.pole_lng
    if (!Number.isFinite(rawLat) || !Number.isFinite(rawLng)) return null
    const lat = Number(rawLat)
    const lng = Number(rawLng)

    const badges = getSalesMeetingLocationBadges(meeting)
    const primaryLocation = getSalesMeetingPrimaryLocationLabel(meeting)
    const label = uniqueLabels([
        badges.join(', '),
        primaryLocation
    ]).join(' • ')

    return {
        lat,
        lng,
        label: label || primaryLocation
    }
}
