import type { Survey, GpsLog } from './db'

export const OFFLINE_SURVEYS_KEY = 'surveyapp_offline_surveys'
export const OFFLINE_GPS_KEY = 'surveyapp_offline_gps'

// Get pending surveys
export const getOfflineSurveys = (): Survey[] => {
    try {
        const data = localStorage.getItem(OFFLINE_SURVEYS_KEY)
        return data ? JSON.parse(data) : []
    } catch { return [] }
}

// Add a survey to offline queue
export const addOfflineSurvey = (survey: Survey) => {
    const list = getOfflineSurveys()
    // give it a temporary negative id or string to satisfy types, but Supabase will ignore it and autogenerate
    list.push({ ...survey, id: -(Date.now()) })
    localStorage.setItem(OFFLINE_SURVEYS_KEY, JSON.stringify(list))
}

// Remove surveys from offline queue (e.g., after successful sync)
export const removeOfflineSurveys = (idsToRemove: number[]) => {
    let list = getOfflineSurveys()
    list = list.filter(s => !s.id || !idsToRemove.includes(s.id))
    localStorage.setItem(OFFLINE_SURVEYS_KEY, JSON.stringify(list))
}

// Get pending GPS logs
export const getOfflineGpsLogs = (): GpsLog[] => {
    try {
        const data = localStorage.getItem(OFFLINE_GPS_KEY)
        return data ? JSON.parse(data) : []
    } catch { return [] }
}

// Add GPS log to offline queue
export const addOfflineGpsLog = (log: GpsLog) => {
    const list = getOfflineGpsLogs()
    list.push({ ...log, id: -(Date.now()) })
    localStorage.setItem(OFFLINE_GPS_KEY, JSON.stringify(list))
}

export const clearOfflineGpsLogs = () => {
    localStorage.removeItem(OFFLINE_GPS_KEY)
}
