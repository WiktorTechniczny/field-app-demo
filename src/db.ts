// ====== TYPES ======
export interface User {
    id?: number
    login: string
    password: string
    name: string
    role: 'worker' | 'admin'
}

export interface Shift {
    id?: number
    user_id: number
    user_name: string
    start_time: string
    end_time?: string
    total_surveys: number
}

export interface Survey {
    id?: number
    shift_id: number
    user_id: number
    user_name: string
    created_at: string

    // Adres
    address: string

    // Pytania ankiety
    answers: Record<string, string | string[]>

    // Dane osobowe respondenta
    respondent_name?: string
    respondent_phone?: string
    respondent_preferred_date?: string
    respondent_preferred_time?: string
    latitude?: number
    longitude?: number
    status?: 'completed' | 'attempted' | 'refused' | 'not_home' | 'no_cooperation' // completed = umowa podpisana, attempted = kontakt ponowny, refused = odmowa klienta, not_home = nie bylo nikogo
    audio_url?: string
    audio_path?: string
    audio_captured_at?: string
    audio_expires_at?: string
    audio_transcript?: string
}

export type SalesMeetingStatus =
    | 'planned'
    | 'signed'
    | 'refused'
    | 'no_cooperation'
    | 'not_home'
    | 'follow_up'
    | 'cancelled'

export interface SalesMeeting {
    id?: number
    import_key: string
    pole_assignment_id?: number | null
    salesperson_id?: number | null
    salesperson_name: string
    lead_source?: string | null
    scheduled_at: string
    phone?: string | null
    client_name: string
    region?: string | null
    county?: string | null
    address: string
    pole_id?: string | null
    pole_lat?: number | null
    pole_lng?: number | null
    parcel_id?: string | null
    parcel_number?: string | null
    surface_area?: string | null
    locality_code?: string | null
    locality_label?: string | null
    municipality?: string | null
    precinct?: string | null
    kw_mode?: PoleAssignmentKwMode | null
    kw_value?: string | null
    pge_servitude_status?: PoleAssignmentPgeServitudeStatus | null
    owner_details?: string | null
    can_proceed?: boolean | null
    note?: string | null
    status: SalesMeetingStatus
    status_note?: string | null
    travel_minutes?: number | null
    result_status?: string | null
    worker_notes?: string | null
    status_updated_at?: string | null
    cancelled_reason?: string | null
    linked_survey_id?: number | null
    imported_at?: string
    created_at?: string
    updated_at?: string
}

export type PoleAssignmentKwMode = 'known_address' | 'missing' | 'manual'
export type PoleAssignmentPgeServitudeStatus = 'yes' | 'no' | 'unknown'

export interface PoleAssignment {
    id?: number
    import_key: string
    pole_id?: string | null
    pole_lat?: number | null
    pole_lng?: number | null
    voivodeship?: string | null
    county?: string | null
    municipality?: string | null
    locality?: string | null
    address?: string | null
    parcel_number?: string | null
    parcel_id?: string | null
    surface_area?: string | null
    pole_count?: number | null
    salesperson_id?: number | null
    salesperson_name?: string | null
    planned_date?: string | null
    status_ph?: SalesMeetingStatus | null
    kw_mode?: PoleAssignmentKwMode | null
    kw_value?: string | null
    pge_servitude_status?: PoleAssignmentPgeServitudeStatus | null
    owner_details?: string | null
    can_proceed?: boolean | null
    notes?: string | null
    travel_minutes?: number | null
    result_status?: string | null
    worker_notes?: string | null
    imported_at?: string
    created_at?: string
    updated_at?: string
}

export interface GpsLog {
    id?: number
    user_id: number
    user_name: string
    shift_id: number
    latitude: number
    longitude: number
    timestamp: string
}

export interface Appointment {
    id?: number
    user_id: number
    survey_id?: number
    appointment_date: string
    appointment_time: string
    respondent_name: string
    address: string
    created_at?: string
}

export interface AppointmentLimit {
    id?: number
    appointment_date: string
    appointment_time: string
    slot_limit: number
    created_at?: string
    updated_at?: string
}
