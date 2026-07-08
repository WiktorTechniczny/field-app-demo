import type { SalesMeeting } from './db'
import { supabase } from './supabase'

type SlotConflict = Pick<SalesMeeting, 'id' | 'import_key' | 'salesperson_id' | 'scheduled_at' | 'client_name' | 'address' | 'status'>

export async function findSalesMeetingSlotConflict(params: {
    salespersonId?: number | null
    scheduledAt: string
    excludeMeetingId?: number | null
    excludeImportKey?: string | null
}): Promise<SlotConflict | null> {
    if (typeof params.salespersonId !== 'number') return null

    const scheduledAt = new Date(params.scheduledAt)
    if (Number.isNaN(scheduledAt.getTime())) return null

    const { data, error } = await supabase
        .from('sales_meetings')
        .select('id, import_key, salesperson_id, scheduled_at, client_name, address, status')
        .eq('salesperson_id', params.salespersonId)
        .eq('scheduled_at', scheduledAt.toISOString())
        .neq('status', 'cancelled')
        .limit(20)

    if (error) throw error

    return ((data || []) as SlotConflict[]).find((meeting) => {
        if (typeof params.excludeMeetingId === 'number' && meeting.id === params.excludeMeetingId) return false
        if (params.excludeImportKey && meeting.import_key === params.excludeImportKey) return false
        return true
    }) || null
}
