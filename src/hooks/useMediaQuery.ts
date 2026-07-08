import { useEffect, useState } from 'react'

const getMatch = (query: string): boolean => {
    if (typeof window === 'undefined') return false
    return window.matchMedia(query).matches
}

export function useMediaQuery(query: string): boolean {
    const [matches, setMatches] = useState(() => getMatch(query))

    useEffect(() => {
        if (typeof window === 'undefined') return

        const media = window.matchMedia(query)
        const sync = () => setMatches(media.matches)

        sync()

        if (typeof media.addEventListener === 'function') {
            media.addEventListener('change', sync)
            return () => media.removeEventListener('change', sync)
        }

        media.addListener(sync)
        return () => media.removeListener(sync)
    }, [query])

    return matches
}
