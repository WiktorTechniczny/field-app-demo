export const parseUnknownError = (error: unknown): { message: string; code?: string } => {
    if (error instanceof Error) {
        return { message: error.message || 'Nieznany błąd.' }
    }

    if (typeof error === 'string') {
        return { message: error }
    }

    if (error && typeof error === 'object') {
        const err = error as Record<string, unknown>
        const message = typeof err.message === 'string' ? err.message : ''
        const details = typeof err.details === 'string' ? err.details : ''
        const hint = typeof err.hint === 'string' ? err.hint : ''
        const code = typeof err.code === 'string' ? err.code : undefined
        const merged = [message, details, hint].filter(Boolean).join(' ').trim()

        if (merged) return { message: merged, code }

        try {
            return { message: JSON.stringify(error), code }
        } catch {
            return { message: 'Nieznany błąd.', code }
        }
    }

    return { message: 'Nieznany błąd.' }
}

export const isMissingSalesMeetingsLeadSourceColumnError = (error: unknown): boolean => {
    const { message } = parseUnknownError(error)
    const lower = message.toLowerCase()

    return (
        lower.includes('lead_source') &&
        lower.includes('sales_meetings') &&
        (lower.includes('schema cache') || lower.includes('column'))
    )
}

export const mapSalesMeetingsMutationError = (error: unknown): string => {
    if (isMissingSalesMeetingsLeadSourceColumnError(error)) {
        return 'Nagłówek CSV "Źródło pozyskania leada" jest poprawny, ale w bazie brakuje kolumny "lead_source" w tabeli "sales_meetings". Import został zatrzymany.'
    }

    const { message } = parseUnknownError(error)
    return message || 'Nieznany błąd zapisu spotkania.'
}

export const omitLeadSource = <T extends Record<string, unknown>>(payload: T): Omit<T, 'lead_source'> => {
    const rest = { ...payload }
    delete (rest as { lead_source?: unknown }).lead_source
    return rest as Omit<T, 'lead_source'>
}
