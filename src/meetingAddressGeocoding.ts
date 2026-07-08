import type { SalesMeeting } from './db'
import {
    normalizeSalesMeetingAddress,
    normalizeSalesMeetingInlineText,
    stripPostalCodeFromSalesMeetingAddress
} from './salesMeetingText'

export interface GeocodedMeetingAddress {
    lat: number
    lng: number
    label: string
}

type CachedEntry = GeocodedMeetingAddress & {
    savedAt: number
}

const STORAGE_KEY = 'sales-meeting-geocode-cache-v3'
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 180
const STREET_PREFIX_REGEX = /^(ul\.?|ulica|al\.?|aleja|pl\.?|plac|os\.?|osiedle)\s*/iu

let memoryCache: Record<string, CachedEntry | null> | null = null

const normalizeKey = (value: string): string =>
    value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()

const normalizeAddressPart = (value: string | null | undefined): string =>
    normalizeSalesMeetingAddress(value)

const normalizeRegionPart = (value: string | null | undefined): string =>
    normalizeSalesMeetingInlineText(value)
        .replace(/\s*,\s*/g, ', ')
        .replace(/\s+/g, ' ')
        .trim()

const stripAddressContext = (value: string): string =>
    value
        .replace(/\s*\/\s*.*/u, '')
        .replace(/\s*\|\s*.*/u, '')
        .trim()

const stripStreetPrefix = (value: string): string =>
    value.replace(STREET_PREFIX_REGEX, '').trim()

const stripPostalCode = (value: string): string =>
    stripPostalCodeFromSalesMeetingAddress(value)

const readCache = (): Record<string, CachedEntry | null> => {
    if (memoryCache) return memoryCache
    memoryCache = {}

    if (typeof window === 'undefined') return memoryCache

    try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (!raw) return memoryCache
        const parsed = JSON.parse(raw) as Record<string, CachedEntry | null>
        const now = Date.now()
        Object.entries(parsed).forEach(([key, value]) => {
            if (!value) {
                memoryCache![key] = null
                return
            }
            if (typeof value.savedAt === 'number' && now - value.savedAt < CACHE_TTL_MS) {
                memoryCache![key] = value
            }
        })
    } catch {
        memoryCache = {}
    }

    return memoryCache
}

const writeCache = () => {
    if (typeof window === 'undefined' || !memoryCache) return
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(memoryCache))
    } catch {
        // Ignore storage quota or private mode issues.
    }
}

export const buildMeetingAddressQueries = (meeting: Pick<SalesMeeting, 'address' | 'region'>): string[] => {
    const address = normalizeAddressPart(meeting.address)
    const region = normalizeRegionPart(meeting.region)
    const simplifiedAddress = stripAddressContext(address)
    const addressWithoutStreetPrefix = stripStreetPrefix(address)
    const simplifiedWithoutStreetPrefix = stripStreetPrefix(simplifiedAddress)
    const addressWithoutPostalCode = stripPostalCode(address)
    const simplifiedWithoutPostalCode = stripPostalCode(simplifiedAddress)
    const addressWithoutStreetPrefixOrPostalCode = stripPostalCode(addressWithoutStreetPrefix)
    const simplifiedWithoutStreetPrefixOrPostalCode = stripPostalCode(simplifiedWithoutStreetPrefix)

    return Array.from(
        new Set(
            [
                [address, region, 'Polska'].filter(Boolean).join(', '),
                [address, 'Polska'].filter(Boolean).join(', '),
                simplifiedAddress !== address ? [simplifiedAddress, region, 'Polska'].filter(Boolean).join(', ') : '',
                simplifiedAddress !== address ? [simplifiedAddress, 'Polska'].filter(Boolean).join(', ') : '',
                addressWithoutStreetPrefix && addressWithoutStreetPrefix !== address ? [addressWithoutStreetPrefix, region, 'Polska'].filter(Boolean).join(', ') : '',
                addressWithoutStreetPrefix && addressWithoutStreetPrefix !== address ? [addressWithoutStreetPrefix, 'Polska'].filter(Boolean).join(', ') : '',
                simplifiedWithoutStreetPrefix &&
                simplifiedWithoutStreetPrefix !== simplifiedAddress &&
                simplifiedWithoutStreetPrefix !== addressWithoutStreetPrefix
                    ? [simplifiedWithoutStreetPrefix, region, 'Polska'].filter(Boolean).join(', ')
                    : '',
                simplifiedWithoutStreetPrefix &&
                simplifiedWithoutStreetPrefix !== simplifiedAddress &&
                simplifiedWithoutStreetPrefix !== addressWithoutStreetPrefix
                    ? [simplifiedWithoutStreetPrefix, 'Polska'].filter(Boolean).join(', ')
                    : ''
                ,
                addressWithoutPostalCode && addressWithoutPostalCode !== address ? [addressWithoutPostalCode, region, 'Polska'].filter(Boolean).join(', ') : '',
                addressWithoutPostalCode && addressWithoutPostalCode !== address ? [addressWithoutPostalCode, 'Polska'].filter(Boolean).join(', ') : '',
                simplifiedWithoutPostalCode &&
                simplifiedWithoutPostalCode !== simplifiedAddress &&
                simplifiedWithoutPostalCode !== addressWithoutPostalCode
                    ? [simplifiedWithoutPostalCode, region, 'Polska'].filter(Boolean).join(', ')
                    : '',
                simplifiedWithoutPostalCode &&
                simplifiedWithoutPostalCode !== simplifiedAddress &&
                simplifiedWithoutPostalCode !== addressWithoutPostalCode
                    ? [simplifiedWithoutPostalCode, 'Polska'].filter(Boolean).join(', ')
                    : '',
                addressWithoutStreetPrefixOrPostalCode &&
                addressWithoutStreetPrefixOrPostalCode !== addressWithoutStreetPrefix &&
                addressWithoutStreetPrefixOrPostalCode !== addressWithoutPostalCode
                    ? [addressWithoutStreetPrefixOrPostalCode, region, 'Polska'].filter(Boolean).join(', ')
                    : '',
                addressWithoutStreetPrefixOrPostalCode &&
                addressWithoutStreetPrefixOrPostalCode !== addressWithoutStreetPrefix &&
                addressWithoutStreetPrefixOrPostalCode !== addressWithoutPostalCode
                    ? [addressWithoutStreetPrefixOrPostalCode, 'Polska'].filter(Boolean).join(', ')
                    : '',
                simplifiedWithoutStreetPrefixOrPostalCode &&
                simplifiedWithoutStreetPrefixOrPostalCode !== simplifiedWithoutStreetPrefix &&
                simplifiedWithoutStreetPrefixOrPostalCode !== simplifiedWithoutPostalCode &&
                simplifiedWithoutStreetPrefixOrPostalCode !== addressWithoutStreetPrefixOrPostalCode
                    ? [simplifiedWithoutStreetPrefixOrPostalCode, region, 'Polska'].filter(Boolean).join(', ')
                    : '',
                simplifiedWithoutStreetPrefixOrPostalCode &&
                simplifiedWithoutStreetPrefixOrPostalCode !== simplifiedWithoutStreetPrefix &&
                simplifiedWithoutStreetPrefixOrPostalCode !== simplifiedWithoutPostalCode &&
                simplifiedWithoutStreetPrefixOrPostalCode !== addressWithoutStreetPrefixOrPostalCode
                    ? [simplifiedWithoutStreetPrefixOrPostalCode, 'Polska'].filter(Boolean).join(', ')
                    : ''
            ].filter(Boolean)
        )
    )
}

export const buildMeetingAddressQuery = (meeting: Pick<SalesMeeting, 'address' | 'region'>): string =>
    buildMeetingAddressQueries(meeting)[0] ?? ''

export const getMeetingAddressCacheKey = (query: string): string => normalizeKey(query)

export const geocodeMeetingAddress = async (
    query: string,
    signal?: AbortSignal,
    options?: { force?: boolean }
): Promise<GeocodedMeetingAddress | null> => {
    const key = getMeetingAddressCacheKey(query)
    if (!key) return null

    const cache = readCache()
    const cachedValue = options?.force ? undefined : cache[key]
    if (cachedValue === null) return null
    if (cachedValue) {
        return {
            lat: cachedValue.lat,
            lng: cachedValue.lng,
            label: cachedValue.label
        }
    }

    if (options?.force) {
        delete cache[key]
    }

    try {
        const response = await fetch(
            `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=pl&accept-language=pl&q=${encodeURIComponent(query)}`,
            {
                method: 'GET',
                headers: {
                    Accept: 'application/json'
                },
                signal
            }
        )

        if (!response.ok) return null

        const data = (await response.json()) as Array<{
            lat?: string
            lon?: string
            display_name?: string
        }>
        const first = data[0]
        const lat = first?.lat ? Number(first.lat) : NaN
        const lng = first?.lon ? Number(first.lon) : NaN
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            cache[key] = null
            writeCache()
            return null
        }

        const value: CachedEntry = {
            lat,
            lng,
            label: first.display_name || query,
            savedAt: Date.now()
        }
        cache[key] = value
        writeCache()

        return {
            lat: value.lat,
            lng: value.lng,
            label: value.label
        }
    } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        return null
    }
}
