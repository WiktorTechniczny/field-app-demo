export type OfflineScopeStats = {
    code: string
    label: string
    kind: 'county' | 'locality'
    parcelCount?: number
    precincts?: string[]
    localityCodes?: string[]
    poles: number
    lines: number
    resolvedPoles: number
    exactAddresses: number
    assignmentAddresses: number
    byVoltage: {
        nn: number
        sn: number
        wn: number
        unknown: number
    }
}

export type OfflineScopeIndex = {
    generatedAt: string
    counties: Record<string, OfflineScopeStats>
    localities: Record<string, OfflineScopeStats>
}

let cachedOfflineScopeIndexPromise: Promise<OfflineScopeIndex> | null = null

export async function fetchOfflineScopeIndex(): Promise<OfflineScopeIndex> {
    if (!cachedOfflineScopeIndexPromise) {
        cachedOfflineScopeIndexPromise = fetch('/power_tiles/scope_index.json')
            .then(async (response) => {
                if (!response.ok) {
                    throw new Error(`Scope index HTTP ${response.status}`)
                }

                return response.json() as Promise<OfflineScopeIndex>
            })
            .catch((error) => {
                cachedOfflineScopeIndexPromise = null
                throw error
            })
    }

    return cachedOfflineScopeIndexPromise
}
