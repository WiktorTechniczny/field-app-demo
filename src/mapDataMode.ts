const MAP_DATA_LOCAL_ONLY_KEY = 'surveyapp_map_data_local_only'

function readLocalStorageFlag(key: string): boolean | null {
    if (typeof window === 'undefined') return null

    try {
        const raw = window.localStorage.getItem(key)
        if (!raw) return null
        const normalized = raw.trim().toLowerCase()
        if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
        if (['0', 'false', 'no', 'off'].includes(normalized)) return false
        return null
    } catch {
        return null
    }
}

export function isLocalOnlyMapDataEnabled() {
    const localStorageValue = readLocalStorageFlag(MAP_DATA_LOCAL_ONLY_KEY)
    if (localStorageValue !== null) return localStorageValue

    const envValue = `${import.meta.env.VITE_MAP_DATA_LOCAL_ONLY ?? '1'}`.trim().toLowerCase()
    if (['0', 'false', 'no', 'off'].includes(envValue)) return false
    return true
}

export function setLocalOnlyMapDataEnabled(enabled: boolean) {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.setItem(MAP_DATA_LOCAL_ONLY_KEY, enabled ? '1' : '0')
    } catch {
    }
}
