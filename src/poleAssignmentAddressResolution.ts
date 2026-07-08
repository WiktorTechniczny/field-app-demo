import type { PoleAssignment } from './db'
import { resolveOfficialAddressForParcel } from './officialAddressPoints'
import { fetchParcelByCoordinates, fetchParcelGeometryById } from './piekoszowParcels'
import { normalizeSalesMeetingAddress } from './salesMeetingText'

export async function resolvePoleAssignmentOfficialAddress(
    assignment: Pick<PoleAssignment, 'address' | 'parcel_id' | 'pole_lat' | 'pole_lng' | 'locality'>
): Promise<string | null> {
    let parcel = null

    const parcelId = assignment.parcel_id?.trim()
    if (parcelId) {
        parcel = await fetchParcelGeometryById(parcelId)
    }

    if (!parcel && Number.isFinite(assignment.pole_lat) && Number.isFinite(assignment.pole_lng)) {
        parcel = await fetchParcelByCoordinates(Number(assignment.pole_lat), Number(assignment.pole_lng), { exactOnly: true })
    }

    if (!parcel) return null

    const resolvedAddress = await resolveOfficialAddressForParcel(parcel, assignment.locality || parcel.localityLabel || parcel.precinct || null)
    if (!resolvedAddress) return null

    const normalizedCurrent = normalizeSalesMeetingAddress(assignment.address)
    const normalizedResolved = normalizeSalesMeetingAddress(resolvedAddress)
    if (normalizedCurrent && normalizedCurrent === normalizedResolved) return null

    return resolvedAddress
}
