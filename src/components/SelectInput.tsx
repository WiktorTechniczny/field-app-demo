import React, { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

export interface SelectOption {
    value: string
    label: string
}

interface SelectInputProps {
    value: string
    onChange: (value: string) => void
    options: SelectOption[]
    placeholder?: string
    className?: string
}

export const SelectInput: React.FC<SelectInputProps> = ({
    value,
    onChange,
    options,
    placeholder = 'Wybierz...',
    className = ''
}) => {
    const [isOpen, setIsOpen] = useState(false)
    const containerRef = useRef<HTMLDivElement>(null)

    const selectedOption = options.find((opt) => opt.value === value)

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setIsOpen(false)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    return (
        <div ref={containerRef} className="relative w-full text-left">
            <button
                type="button"
                className={`flex w-full items-center justify-between text-left ${className} ${isOpen ? 'ring-2! ring-cyan-500!' : ''}`}
                onClick={() => setIsOpen(!isOpen)}
            >
                <span className={`block truncate ${!selectedOption && placeholder ? 'text-gray-400 dark:text-slate-400' : ''}`}>
                    {selectedOption ? selectedOption.label : placeholder}
                </span>
                <span className="pointer-events-none flex items-center pl-2">
                    <motion.svg
                        animate={{ rotate: isOpen ? 180 : 0 }}
                        transition={{ duration: 0.2, ease: 'easeOut' }}
                        className="h-4 w-4 text-gray-400"
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        aria-hidden="true"
                    >
                        <path
                            fillRule="evenodd"
                            d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
                            clipRule="evenodd"
                        />
                    </motion.svg>
                </span>
            </button>

            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0, scale: 0.95, y: -10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: -10 }}
                        transition={{ duration: 0.15, ease: 'easeOut' }}
                        className="absolute z-50 mt-2 w-full origin-top rounded-xl bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 shadow-xl focus:outline-none overflow-hidden"
                    >
                        <ul className="max-h-60 overflow-y-auto w-full" role="listbox">
                            {options.map((option) => {
                                const isSelected = value === option.value
                                return (
                                    <li
                                        key={option.value}
                                        role="option"
                                        aria-selected={isSelected}
                                        className={`relative cursor-pointer select-none py-2.5 px-4 text-sm transition-colors ${
                                            isSelected
                                                ? 'bg-cyan-50 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-300 font-bold'
                                                : 'text-slate-700 dark:text-slate-200 hover:bg-gray-50 dark:hover:bg-slate-700/50'
                                        }`}
                                        onClick={() => {
                                            onChange(option.value)
                                            setIsOpen(false)
                                        }}
                                    >
                                        <span className={`block truncate ${isSelected ? 'font-bold' : 'font-medium'}`}>
                                            {option.label}
                                        </span>
                                    </li>
                                )
                            })}
                        </ul>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}
