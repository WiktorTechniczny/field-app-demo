import type { SalesMeeting } from './db'

export const sortSalesMeetingsByScheduledAt = (meetings: SalesMeeting[]): SalesMeeting[] =>
    [...meetings].sort((left, right) => new Date(left.scheduled_at).getTime() - new Date(right.scheduled_at).getTime())

const hasMeetingPatchChanges = (current: SalesMeeting, patch: SalesMeeting): boolean => {
    for (const key of Object.keys(patch) as Array<keyof SalesMeeting>) {
        if (patch[key] !== current[key]) {
            return true
        }
    }

    return false
}

export const mergeSalesMeetingPatch = (
    meetings: SalesMeeting[],
    patch?: SalesMeeting | null
): SalesMeeting[] => {
    if (!patch?.id) return meetings

    let changed = false
    const nextMeetings = meetings.map((meeting) => {
        if (meeting.id !== patch.id) return meeting
        if (!hasMeetingPatchChanges(meeting, patch)) return meeting
        changed = true
        return { ...meeting, ...patch }
    })

    return changed ? sortSalesMeetingsByScheduledAt(nextMeetings) : meetings
}
