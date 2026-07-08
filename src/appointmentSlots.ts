export const APPOINTMENT_SLOTS = [
  '09:00',
  '09:30',
  '10:00',
  '10:30',
  '11:00',
  '11:30',
  '12:00',
  '12:30',
  '13:00',
  '13:30',
  '14:00',
  '14:30',
  '15:00',
  '15:30',
  '16:00',
  '16:30',
  '17:00',
  '17:30'
] as const

export type AppointmentSlot = (typeof APPOINTMENT_SLOTS)[number]

export const DEFAULT_SLOT_LIMIT = 1

export function normalizeTimeSlot(value: string): string {
  return value.substring(0, 5)
}

