import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { format } from 'date-fns'
import { pl } from 'date-fns/locale'
import { DayPicker, type DateRange } from 'react-day-picker'

interface DateRangePickerProps {
    dateFrom: string
    dateTo: string
    onChange: (dateFrom: string, dateTo: string) => void
}

function toLocalDate(value: string): Date {
    const [year, month, day] = value.split('-').map(Number)
    return new Date(year, month - 1, day)
}

function toIsoDate(date: Date): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

function normalizeIsoRange(dateFrom: string, dateTo: string): { from: string; to: string } {
    return dateFrom <= dateTo ? { from: dateFrom, to: dateTo } : { from: dateTo, to: dateFrom }
}

function formatPolishDate(value: string): string {
    return format(toLocalDate(value), 'dd.MM.yyyy', { locale: pl })
}

function getDraftSummary(range: DateRange): string {
    if (!range.from) return 'Wybierz początek zakresu'
    if (!range.to) return `Od: ${format(range.from, 'dd.MM.yyyy', { locale: pl })}`
    const normalized = normalizeIsoRange(toIsoDate(range.from), toIsoDate(range.to))
    return `${formatPolishDate(normalized.from)} - ${formatPolishDate(normalized.to)}`
}

export default function DateRangePicker({ dateFrom, dateTo, onChange }: DateRangePickerProps) {
    const normalizedRange = useMemo(() => normalizeIsoRange(dateFrom, dateTo), [dateFrom, dateTo])
    const committedRange = useMemo<DateRange>(() => ({
        from: toLocalDate(normalizedRange.from),
        to: toLocalDate(normalizedRange.to)
    }), [normalizedRange.from, normalizedRange.to])

    const [isOpen, setIsOpen] = useState(false)
    const [draftRange, setDraftRange] = useState<DateRange>(committedRange)
    const [visibleMonth, setVisibleMonth] = useState(committedRange.to ?? committedRange.from ?? new Date())
    const rootRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!isOpen) return

        const handlePointerDown = (event: MouseEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) {
                setDraftRange(committedRange)
                setIsOpen(false)
            }
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setDraftRange(committedRange)
                setIsOpen(false)
            }
        }

        document.addEventListener('mousedown', handlePointerDown)
        document.addEventListener('keydown', handleKeyDown)
        return () => {
            document.removeEventListener('mousedown', handlePointerDown)
            document.removeEventListener('keydown', handleKeyDown)
        }
    }, [committedRange, isOpen])

    const handleDayClick = (day: Date) => {
        const clickedDay = toLocalDate(toIsoDate(day))

        if (!draftRange.from || draftRange.to) {
            setDraftRange({ from: clickedDay, to: undefined })
            return
        }

        const nextRange = clickedDay.getTime() < draftRange.from.getTime()
            ? { from: clickedDay, to: draftRange.from }
            : { from: draftRange.from, to: clickedDay }

        setDraftRange(nextRange)
        onChange(toIsoDate(nextRange.from), toIsoDate(nextRange.to))
        setIsOpen(false)
    }

    return (
        <div ref={rootRef} className="relative w-full">
            <button
                type="button"
                onClick={() => {
                    setIsOpen((current) => {
                        const nextOpen = !current
                        if (nextOpen) {
                            setDraftRange(committedRange)
                            setVisibleMonth(committedRange.to ?? committedRange.from ?? new Date())
                        }
                        return nextOpen
                    })
                }}
                className="ui-pressable group flex min-h-[3.2rem] w-full items-center gap-2.5 rounded-2xl border border-cyan-500/15 bg-white/95 px-3 py-2 text-left shadow-lg shadow-slate-950/5 backdrop-blur dark:border-cyan-400/15 dark:bg-slate-800/95"
            >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl bg-cyan-500/12 text-cyan-500 shadow-inner shadow-cyan-500/10 dark:bg-cyan-500/10">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="h-4 w-4">
                        <rect x="3" y="4" width="18" height="17" rx="2" ry="2" strokeWidth="2" />
                        <line x1="16" y1="2" x2="16" y2="6" strokeWidth="2" />
                        <line x1="8" y1="2" x2="8" y2="6" strokeWidth="2" />
                        <line x1="3" y1="10" x2="21" y2="10" strokeWidth="2" />
                    </svg>
                </span>

                <div className="min-w-0 flex-1">
                    <div className="grid grid-cols-1 gap-y-0.5 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center sm:gap-x-2">
                        <div className="min-w-[92px]">
                            <p className="text-[7px] font-black uppercase tracking-[0.22em] text-cyan-500">Za okres od</p>
                            <p className="text-[13px] font-black leading-none text-slate-900 dark:text-white">{formatPolishDate(normalizedRange.from)}</p>
                        </div>
                        <span className="hidden shrink-0 text-center text-slate-300 sm:block">-</span>
                        <div className="min-w-[92px]">
                            <p className="text-[7px] font-black uppercase tracking-[0.22em] text-slate-400">Do</p>
                            <p className="text-[13px] font-black leading-none text-slate-900 dark:text-white">{formatPolishDate(normalizedRange.to)}</p>
                        </div>
                    </div>
                    <p className="mt-0.5 text-[8px] font-black uppercase tracking-[0.18em] text-slate-400 transition-colors group-hover:text-cyan-500">
                        Kalendarz zakresu
                    </p>
                </div>
            </button>

            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0, y: 10, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 6, scale: 0.985 }}
                        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                        className="absolute left-0 top-[calc(100%+12px)] z-50 w-full overflow-hidden rounded-[28px] border border-slate-200/80 bg-white/98 shadow-2xl shadow-slate-950/12 backdrop-blur dark:border-slate-700 dark:bg-slate-900/98 sm:left-auto sm:right-0 sm:w-[18.5rem]"
                    >
                        <div className="border-b border-slate-200/80 bg-gradient-to-r from-cyan-500/10 via-sky-500/8 to-transparent px-4 py-3 dark:border-slate-700 dark:from-cyan-500/8 dark:via-sky-500/6">
                            <p className="text-[10px] font-black uppercase tracking-[0.24em] text-cyan-500">Zakres historii</p>
                            <p className="mt-1 text-sm font-black text-slate-900 dark:text-white">{getDraftSummary(draftRange)}</p>
                        </div>

                        <div className="space-y-3 p-3.5">
                            <div className="date-range-picker rounded-[24px] border border-slate-200/80 bg-slate-50/85 p-3 shadow-inner dark:border-slate-700 dark:bg-slate-950/45">
                                <DayPicker
                                    animate
                                    fixedWeeks
                                    locale={pl}
                                    mode="range"
                                    month={visibleMonth}
                                    navLayout="around"
                                    selected={draftRange}
                                    showOutsideDays
                                    onDayClick={handleDayClick}
                                    onMonthChange={setVisibleMonth}
                                />
                            </div>

                            <p className="border-t border-slate-200/80 pt-3 text-[10px] font-black uppercase tracking-[0.18em] text-slate-400 dark:border-slate-700">
                                Klik 1: od. Klik 2: do.
                            </p>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}
