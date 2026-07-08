import type { PoleAssignment, SalesMeeting } from './db'
import { buildSalesMeetingImportKey, isPoleAssignmentMeetingImportKey } from './salesMeetingIdentity'
import { normalizeSalesMeetingAddress, normalizeSalesMeetingInlineText } from './salesMeetingText'
import { supabase } from './supabase'

type SyncableMeeting = Pick<
    SalesMeeting,
    | 'id'
    | 'import_key'
    | 'pole_assignment_id'
    | 'salesperson_id'
    | 'salesperson_name'
    | 'scheduled_at'
    | 'address'
    | 'region'
    | 'county'
    | 'municipality'
    | 'locality_label'
    | 'precinct'
    | 'parcel_id'
    | 'parcel_number'
    | 'surface_area'
    | 'pole_id'
    | 'pole_lat'
    | 'pole_lng'
    | 'status'
    | 'note'
    | 'worker_notes'
    | 'travel_minutes'
    | 'result_status'
    | 'client_name'
>

const normalizeComparableText = (value?: string | null): string =>
    normalizeSalesMeetingInlineText(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()

const buildMeetingPoleAssignmentImportKey = (meeting: Pick<SalesMeeting, 'import_key' | 'salesperson_id' | 'scheduled_at' | 'client_name' | 'address'>): string =>
    `meeting|${meeting.import_key || buildSalesMeetingImportKey({
        salespersonId: meeting.salesperson_id,
        scheduledAt: meeting.scheduled_at,
        clientName: meeting.client_name,
        address: meeting.address
    })}`

const getMeetingPlannedDate = (scheduledAt: string): string | null => {
    const date = new Date(scheduledAt)
    if (Number.isNaN(date.getTime())) return null
    return date.toLocaleDateString('sv-SE')
}

const buildMeetingFallbackAddress = (meeting: Pick<SyncableMeeting, 'address' | 'locality_label' | 'precinct' | 'parcel_number' | 'parcel_id'>): string | null => {
    const normalizedAddress = normalizeSalesMeetingAddress(meeting.address)
    if (normalizedAddress) return normalizedAddress

    const locality = normalizeSalesMeetingInlineText(meeting.locality_label || meeting.precinct)
    const parcel = normalizeSalesMeetingInlineText(meeting.parcel_number || meeting.parcel_id)
    const fallback = [locality, parcel ? `dzialka ${parcel}` : ''].filter(Boolean).join(', ')
    return fallback || null
}

const buildCandidateScore = (
    candidate: Pick<PoleAssignment, 'id' | 'parcel_id' | 'parcel_number' | 'address' | 'salesperson_id' | 'planned_date'>,
    meeting: SyncableMeeting,
    normalizedAddress: string | null,
    plannedDate: string | null
): number => {
    let score = 0

    if (typeof meeting.pole_assignment_id === 'number' && candidate.id === meeting.pole_assignment_id) score += 1000
    if (meeting.parcel_id && candidate.parcel_id === meeting.parcel_id) score += 320
    if (meeting.parcel_number && candidate.parcel_number === meeting.parcel_number) score += 140
    if (normalizedAddress && normalizeComparableText(candidate.address) === normalizeComparableText(normalizedAddress)) score += 260
    if (typeof meeting.salesperson_id === 'number' && candidate.salesperson_id === meeting.salesperson_id) score += 30
    if (plannedDate && candidate.planned_date === plannedDate) score += 18

    return score
}

const chooseBestCandidate = (candidates: PoleAssignment[], meeting: SyncableMeeting, normalizedAddress: string | null): PoleAssignment | null => {
    if (candidates.length === 0) return null

    const plannedDate = getMeetingPlannedDate(meeting.scheduled_at)
    return [...candidates]
        .sort((left, right) => {
            const scoreDiff =
                buildCandidateScore(right, meeting, normalizedAddress, plannedDate) -
                buildCandidateScore(left, meeting, normalizedAddress, plannedDate)
            if (scoreDiff !== 0) return scoreDiff
            return (left.id ?? Number.MAX_SAFE_INTEGER) - (right.id ?? Number.MAX_SAFE_INTEGER)
        })[0] || null
}

async function findExistingPoleAssignmentForMeeting(
    meeting: SyncableMeeting,
    normalizedAddress: string | null
): Promise<PoleAssignment | null> {
    if (typeof meeting.pole_assignment_id === 'number') {
        const { data, error } = await supabase
            .from('pole_assignments')
            .select('*')
            .eq('id', meeting.pole_assignment_id)
            .maybeSingle()

        if (error) throw error
        if (data) return data as PoleAssignment
    }

    const candidates: PoleAssignment[] = []
    const candidateIds = new Set<number>()

    const collect = (rows: PoleAssignment[] | null | undefined) => {
        ;(rows || []).forEach((row) => {
            if (typeof row.id === 'number') {
                if (candidateIds.has(row.id)) return
                candidateIds.add(row.id)
            }

            candidates.push(row)
        })
    }

    if (meeting.parcel_id) {
        const { data, error } = await supabase
            .from('pole_assignments')
            .select('*')
            .eq('parcel_id', meeting.parcel_id)
            .limit(20)

        if (error) throw error
        collect(data as PoleAssignment[])
    }

    if (normalizedAddress) {
        const { data, error } = await supabase
            .from('pole_assignments')
            .select('*')
            .eq('address', normalizedAddress)
            .limit(20)

        if (error) throw error
        collect(data as PoleAssignment[])
    }

    if (candidates.length === 0 && meeting.parcel_number) {
        let query = supabase
            .from('pole_assignments')
            .select('*')
            .eq('parcel_number', meeting.parcel_number)
            .limit(20)

        const locality = normalizeSalesMeetingInlineText(meeting.locality_label || meeting.precinct)
        if (locality) {
            query = query.eq('locality', locality)
        }

        const { data, error } = await query
        if (error) throw error
        collect(data as PoleAssignment[])
    }

    return chooseBestCandidate(candidates, meeting, normalizedAddress)
}

function buildPoleAssignmentPayload(
    existing: PoleAssignment | null,
    meeting: SyncableMeeting,
    normalizedAddress: string | null
): PoleAssignment {
    const fallbackAddress = buildMeetingFallbackAddress(meeting)
    const locality = normalizeSalesMeetingInlineText(meeting.locality_label || meeting.precinct) || existing?.locality || null
    const plannedDate = getMeetingPlannedDate(meeting.scheduled_at)

    return {
        import_key: existing?.import_key || buildMeetingPoleAssignmentImportKey(meeting),
        pole_id: meeting.pole_id || existing?.pole_id || null,
        pole_lat: Number.isFinite(meeting.pole_lat) ? Number(meeting.pole_lat) : existing?.pole_lat ?? null,
        pole_lng: Number.isFinite(meeting.pole_lng) ? Number(meeting.pole_lng) : existing?.pole_lng ?? null,
        voivodeship: normalizeSalesMeetingInlineText(meeting.region) || existing?.voivodeship || null,
        county: normalizeSalesMeetingInlineText(meeting.county) || existing?.county || null,
        municipality: normalizeSalesMeetingInlineText(meeting.municipality) || existing?.municipality || null,
        locality,
        address: normalizedAddress || existing?.address || fallbackAddress,
        parcel_number: normalizeSalesMeetingInlineText(meeting.parcel_number) || existing?.parcel_number || null,
        parcel_id: normalizeSalesMeetingInlineText(meeting.parcel_id) || existing?.parcel_id || null,
        surface_area: normalizeSalesMeetingInlineText(meeting.surface_area) || existing?.surface_area || null,
        pole_count: existing?.pole_count ?? 1,
        salesperson_id: meeting.salesperson_id ?? existing?.salesperson_id ?? null,
        salesperson_name: normalizeSalesMeetingInlineText(meeting.salesperson_name) || existing?.salesperson_name || null,
        planned_date: plannedDate || existing?.planned_date || null,
        status_ph: meeting.status || existing?.status_ph || 'planned',
        kw_mode: existing?.kw_mode ?? null,
        kw_value: existing?.kw_value ?? null,
        pge_servitude_status: existing?.pge_servitude_status ?? null,
        owner_details: existing?.owner_details ?? null,
        can_proceed: existing?.can_proceed ?? null,
        notes: normalizeSalesMeetingInlineText(meeting.note) || existing?.notes || null,
        travel_minutes: Number.isFinite(meeting.travel_minutes) ? Number(meeting.travel_minutes) : existing?.travel_minutes ?? null,
        result_status: normalizeSalesMeetingInlineText(meeting.result_status) || existing?.result_status || null,
        worker_notes: normalizeSalesMeetingInlineText(meeting.worker_notes) || existing?.worker_notes || null,
        imported_at: existing?.imported_at || new Date().toISOString()
    }
}

export async function syncPoleAssignmentForMeeting(meeting: SyncableMeeting): Promise<number | null> {
    if (typeof meeting.id !== 'number') return null
    if (isPoleAssignmentMeetingImportKey(meeting.import_key)) return meeting.pole_assignment_id ?? null

    const normalizedAddress = normalizeSalesMeetingAddress(meeting.address) || null
    const existing = await findExistingPoleAssignmentForMeeting(meeting, normalizedAddress)
    const payload = buildPoleAssignmentPayload(existing, meeting, normalizedAddress)

    let savedRowId = existing?.id ?? null

    if (typeof existing?.id === 'number') {
        const { data, error } = await supabase
            .from('pole_assignments')
            .update(payload)
            .eq('id', existing.id)
            .select('id')
            .maybeSingle()

        if (error) throw error
        savedRowId = typeof data?.id === 'number' ? data.id : existing.id
    } else {
        const { data, error } = await supabase
            .from('pole_assignments')
            .upsert(payload, { onConflict: 'import_key' })
            .select('id')
            .maybeSingle()

        if (error) throw error
        savedRowId = typeof data?.id === 'number' ? data.id : null
    }

    if (typeof savedRowId === 'number' && meeting.pole_assignment_id !== savedRowId) {
        const { error } = await supabase
            .from('sales_meetings')
            .update({ pole_assignment_id: savedRowId })
            .eq('id', meeting.id)

        if (error) throw error
    }

    return savedRowId
}

export async function syncPoleAssignmentsForMeetings(
    meetings: SyncableMeeting[],
    options?: { maxConcurrency?: number }
): Promise<void> {
    const uniqueMeetings = meetings.filter(
        (meeting, index, allMeetings) =>
            typeof meeting.id === 'number' &&
            allMeetings.findIndex((candidate) => candidate.id === meeting.id) === index
    )

    const maxConcurrency = Math.max(1, Math.min(options?.maxConcurrency ?? 4, uniqueMeetings.length))
    let cursor = 0

    await Promise.all(Array.from({ length: maxConcurrency }, async () => {
        while (true) {
            const currentIndex = cursor
            cursor += 1
            const meeting = uniqueMeetings[currentIndex]
            if (!meeting) return
            await syncPoleAssignmentForMeeting(meeting)
        }
    }))
}
