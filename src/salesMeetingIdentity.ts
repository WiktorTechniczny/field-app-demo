import { normalizeSalesMeetingAddress, normalizeSalesMeetingInlineText } from './salesMeetingText'

const normalizeMeetingIdentityText = (value: string | null | undefined): string =>
    normalizeSalesMeetingInlineText(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()

export const normalizeSalesMeetingIdentityAddress = (value: string | null | undefined): string =>
    normalizeMeetingIdentityText(normalizeSalesMeetingAddress(value))

export const normalizeSalesMeetingIdentityName = (value: string | null | undefined): string =>
    normalizeMeetingIdentityText(value)

export const toSalesMeetingIdentityScheduledAt = (value: string): string => {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
        return `${value || ''}`.trim()
    }

    return date.toISOString()
}

export const buildSalesMeetingImportKey = (params: {
    salespersonId?: number | string | null
    scheduledAt: string
    clientName: string
    address: string
}): string =>
    [
        params.salespersonId ?? 'unassigned',
        toSalesMeetingIdentityScheduledAt(params.scheduledAt),
        normalizeSalesMeetingIdentityName(params.clientName),
        normalizeSalesMeetingIdentityAddress(params.address)
    ].join('|')

export const buildSalesMeetingSlotKey = (salespersonId: number | string | null | undefined, scheduledAt: string): string =>
    [salespersonId ?? 'unassigned', toSalesMeetingIdentityScheduledAt(scheduledAt)].join('|')

export const isPoleAssignmentMeetingImportKey = (importKey?: string | null): boolean =>
    `${importKey || ''}`.startsWith('pole-assignment|')
