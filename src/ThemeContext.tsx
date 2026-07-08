/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'

interface ThemeState {
    dark: boolean
    toggle: () => void
}

const ThemeContext = createContext<ThemeState>({ dark: false, toggle: () => { } })

export function useTheme() {
    return useContext(ThemeContext)
}

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [dark, setDark] = useState(() => {
        const saved = localStorage.getItem('theme')
        if (saved) return saved === 'dark'
        return window.matchMedia('(prefers-color-scheme: dark)').matches
    })

    useEffect(() => {
        document.documentElement.classList.toggle('dark', dark)
        localStorage.setItem('theme', dark ? 'dark' : 'light')
    }, [dark])

    const toggle = () => setDark((d) => !d)

    return (
        <ThemeContext.Provider value={{ dark, toggle }}>
            {children}
        </ThemeContext.Provider>
    )
}
