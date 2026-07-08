import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { APPOINTMENT_SLOTS, DEFAULT_SLOT_LIMIT, normalizeTimeSlot } from '../appointmentSlots'
import { toast } from 'react-hot-toast'

type SlotMap = Record<string, number>
type AppointmentLimitsPanelProps = {
  selectedDate: string
}

const card = 'bg-white dark:bg-slate-800 rounded-xl border border-gray-200/60 dark:border-slate-700 shadow-md'

function toSlotMap(rows: { appointment_time: string; slot_limit: number }[]): SlotMap {
  return rows.reduce<SlotMap>((acc, row) => {
    acc[normalizeTimeSlot(row.appointment_time)] = row.slot_limit
    return acc
  }, {})
}

function toBookedMap(rows: { appointment_time: string }[]): SlotMap {
  return rows.reduce<SlotMap>((acc, row) => {
    const slot = normalizeTimeSlot(row.appointment_time)
    acc[slot] = (acc[slot] || 0) + 1
    return acc
  }, {})
}

export default function AppointmentLimitsPanel({ selectedDate }: AppointmentLimitsPanelProps) {
  const [limits, setLimits] = useState<SlotMap>({})
  const [booked, setBooked] = useState<SlotMap>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (!selectedDate) return

    const load = async () => {
      setLoading(true)
      setMessage(null)
      try {
        const [limitsResp, appointmentsResp] = await Promise.all([
          supabase
            .from('appointment_limits')
            .select('appointment_time, slot_limit')
            .eq('appointment_date', selectedDate),
          supabase
            .from('appointments')
            .select('appointment_time')
            .eq('appointment_date', selectedDate)
            .not('survey_id', 'is', null)
        ])

        if (limitsResp.error) throw limitsResp.error
        if (appointmentsResp.error) throw appointmentsResp.error

        setLimits(toSlotMap(limitsResp.data || []))
        setBooked(toBookedMap(appointmentsResp.data || []))
      } catch (error) {
        const text = error instanceof Error ? error.message : 'Nie udało się pobrać limitów.'
        setMessage({ type: 'error', text })
      } finally {
        setLoading(false)
      }
    }

    load()

    const limitsChannel = supabase
      .channel(`limits_${selectedDate}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'appointment_limits',
          filter: `appointment_date=eq.${selectedDate}`
        },
        () => {
          load()
        }
      )
      .subscribe()

    const appointmentsChannel = supabase
      .channel(`appointments_${selectedDate}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'appointments',
          filter: `appointment_date=eq.${selectedDate}`
        },
        () => {
          load()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(limitsChannel)
      supabase.removeChannel(appointmentsChannel)
    }
  }, [selectedDate])

  const rows = useMemo(() => {
    return APPOINTMENT_SLOTS.map((slot) => {
      const slotLimit = limits[slot] ?? DEFAULT_SLOT_LIMIT
      const slotBooked = booked[slot] ?? 0
      return {
        slot,
        slotLimit,
        slotBooked,
        available: Math.max(0, slotLimit - slotBooked)
      }
    })
  }, [booked, limits])

  const saveLimits = async () => {
    if (!selectedDate) return

    setSaving(true)
    setMessage(null)
    try {
      const payload = APPOINTMENT_SLOTS.map((slot) => {
        const raw = limits[slot]
        const parsed = Number.isFinite(raw) ? raw : DEFAULT_SLOT_LIMIT
        return {
          appointment_date: selectedDate,
          appointment_time: `${slot}:00`,
          slot_limit: Math.max(0, Math.floor(parsed))
        }
      })

      const { error } = await supabase
        .from('appointment_limits')
        .upsert(payload, { onConflict: 'appointment_date,appointment_time' })

      if (error) throw error

      toast.success('Zapisano limity dla dnia: ' + selectedDate)
      setMessage({ type: 'success', text: 'Zapisano limity dla wybranego dnia.' })
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Nie udało się zapisać limitów.'
      toast.error(text)
      setMessage({ type: 'error', text })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className={`${card} p-4 space-y-4`}>
        <div className="flex flex-col sm:flex-row sm:items-end gap-3 sm:justify-between">
          <div>
            <p className="text-[10px] font-black text-cyan-500 uppercase tracking-widest">Limity terminów</p>
            <h3 className="text-lg font-black text-slate-800 dark:text-white">Dostępność godzin na dzień</h3>
          </div>
</div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-gray-400 border-b border-gray-100 dark:border-slate-700">
                <th className="py-2">Godzina</th>
                <th className="py-2">Zajęte</th>
                <th className="py-2">Limit</th>
                <th className="py-2">Wolne</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.slot} className="border-b border-gray-50 dark:border-slate-700/60 last:border-0">
                  <td className="py-3 font-black text-slate-700 dark:text-slate-100">{row.slot}</td>
                  <td className="py-3 text-gray-500 dark:text-gray-300">{row.slotBooked}</td>
                  <td className="py-3">
                    <input
                      type="number"
                      min={0}
                      value={limits[row.slot] ?? DEFAULT_SLOT_LIMIT}
                      onChange={(event) => {
                        const value = Math.max(0, Number(event.target.value || 0))
                        setLimits((prev) => ({ ...prev, [row.slot]: value }))
                      }}
                      className="w-24 bg-white dark:bg-slate-700 border border-gray-200 dark:border-slate-600 rounded-lg px-2 py-1.5 text-sm font-bold dark:text-white"
                    />
                  </td>
                  <td className={`py-3 font-black ${row.available > 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
                    {row.available}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between">
          <p className="text-[10px] text-gray-400 font-black uppercase tracking-widest">
            Domyślny limit dla nieustawionego slotu: {DEFAULT_SLOT_LIMIT}
          </p>
          <button
            type="button"
            onClick={saveLimits}
            disabled={saving || loading}
            className="px-4 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-600 text-white text-xs font-black uppercase tracking-widest disabled:opacity-40"
          >
            {saving ? 'Zapisywanie...' : 'Zapisz limity'}
          </button>
        </div>

        {message && (
          <p className={`text-xs font-bold ${message.type === 'success' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {message.text}
          </p>
        )}
      </div>
    </div>
  )
}


