import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { APPOINTMENT_SLOTS, DEFAULT_SLOT_LIMIT, normalizeTimeSlot } from '../appointmentSlots'

interface Props {
    selectedDate: string
    selectedTime: string
    onSelect: (time: string) => void
}

export default function AppointmentPicker({ selectedDate, selectedTime, onSelect }: Props) {
    const [takenSlots, setTakenSlots] = useState<Record<string, number>>({})
    const [slotLimits, setSlotLimits] = useState<Record<string, number>>({})
    const [loading, setLoading] = useState(false)

    useEffect(() => {
        if (!selectedDate) return

        const fetchAvailability = async () => {
            setLoading(true)
            try {
                const [appointmentsResp, limitsResp] = await Promise.all([
                    supabase
                        .from('appointments')
                        .select('appointment_time')
                        .eq('appointment_date', selectedDate)
                        .not('survey_id', 'is', null),
                    supabase
                        .from('appointment_limits')
                        .select('appointment_time, slot_limit')
                        .eq('appointment_date', selectedDate)
                ])

                if (appointmentsResp.error) throw appointmentsResp.error
                if (limitsResp.error) throw limitsResp.error

                const takenCounts: Record<string, number> = {}
                for (const appointment of appointmentsResp.data || []) {
                    const slot = normalizeTimeSlot(appointment.appointment_time)
                    takenCounts[slot] = (takenCounts[slot] || 0) + 1
                }

                const limitsMap: Record<string, number> = {}
                for (const limit of limitsResp.data || []) {
                    limitsMap[normalizeTimeSlot(limit.appointment_time)] = limit.slot_limit
                }

                setTakenSlots(takenCounts)
                setSlotLimits(limitsMap)
            } catch (error) {
                console.error('Error fetching appointments:', error)
            } finally {
                setLoading(false)
            }
        }

        fetchAvailability()

        const appointmentsChannel = supabase
            .channel(`appointments_sync_${selectedDate}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'appointments',
                    filter: `appointment_date=eq.${selectedDate}`
                },
                () => {
                    fetchAvailability()
                }
            )
            .subscribe()

        const limitsChannel = supabase
            .channel(`appointment_limits_sync_${selectedDate}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'appointment_limits',
                    filter: `appointment_date=eq.${selectedDate}`
                },
                () => {
                    fetchAvailability()
                }
            )
            .subscribe()

        return () => {
            supabase.removeChannel(appointmentsChannel)
            supabase.removeChannel(limitsChannel)
        }
    }, [selectedDate])

    useEffect(() => {
        if (!selectedTime) return
        const selectedLimit = slotLimits[selectedTime] ?? DEFAULT_SLOT_LIMIT
        const selectedTaken = takenSlots[selectedTime] ?? 0
        if (selectedTaken >= selectedLimit) onSelect('')
    }, [onSelect, selectedTime, slotLimits, takenSlots])

    if (!selectedDate) {
        return (
            <div className="p-4 bg-gray-50 dark:bg-slate-700/30 rounded-xl border border-dashed border-gray-200 dark:border-slate-600 text-center">
                <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Wybierz datę, aby zobaczyć dostępne terminy</p>
            </div>
        )
    }

    const allTaken = APPOINTMENT_SLOTS.every((slot) => {
        const taken = takenSlots[slot] ?? 0
        const limit = slotLimits[slot] ?? DEFAULT_SLOT_LIMIT
        return taken >= limit
    })

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between px-1">
                <p className="text-[9px] text-gray-400 font-black uppercase tracking-widest">Dostępne godziny (co 30 min)</p>
                {loading && <span className="w-3 h-3 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {APPOINTMENT_SLOTS.map((slot) => {
                    const limit = slotLimits[slot] ?? DEFAULT_SLOT_LIMIT
                    const taken = takenSlots[slot] ?? 0
                    const isTaken = taken >= limit
                    const isSelected = selectedTime === slot

                    return (
                        <button
                            key={slot}
                            type="button"
                            disabled={isTaken}
                            onClick={() => onSelect(slot)}
                            className={`
                                py-2.5 rounded-xl border text-xs font-black transition-all flex items-center justify-center gap-2
                                ${isTaken
                                    ? 'bg-gray-100 dark:bg-slate-800 border-transparent text-gray-300 dark:text-gray-600 cursor-not-allowed'
                                    : isSelected
                                        ? 'bg-cyan-500 border-cyan-500 text-white shadow-lg shadow-cyan-500/30 ring-2 ring-cyan-500/20'
                                        : 'bg-white dark:bg-slate-700 border-gray-100 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:border-cyan-400 hover:text-cyan-500'
                                }
                            `}
                        >
                            {slot}
                            <span className="text-[8px] opacity-60">{taken}/{limit}</span>
                        </button>
                    )
                })}
            </div>

            {allTaken && !loading && (
                <p className="text-[10px] text-red-500 font-black text-center uppercase tracking-tight py-2">
                    Brak wolnych terminów na ten dzień!
                </p>
            )}
        </div>
    )
}


