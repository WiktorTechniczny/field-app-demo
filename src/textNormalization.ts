const scoreText = (value: string): number => {
    const mojibakeHits = (value.match(/[ÃÄÅĂÂĹĽÐÞ¤]/g) || []).length
    const replacementHits = (value.match(/�/g) || []).length
    const polishHits = (value.match(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g) || []).length
    return (mojibakeHits * 4) + (replacementHits * 8) - polishHits
}

const maybeDecodeLatin1AsUtf8 = (value: string): string => {
    if (!value) return ''

    try {
        const bytes = Uint8Array.from(value, (char) => char.charCodeAt(0) & 0xff)
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    } catch {
        return value
    }
}

export const repairMojibake = (value: string | null | undefined): string => {
    const original = `${value || ''}`.replace(/\s+/g, ' ').trim()
    if (!original) return ''

    const candidates = [original]
    const decoded = maybeDecodeLatin1AsUtf8(original).replace(/\s+/g, ' ').trim()
    if (decoded && decoded !== original) {
        candidates.push(decoded)
    }

    return candidates.reduce((best, candidate) => {
        const candidateScore = scoreText(candidate)
        const bestScore = scoreText(best)
        if (candidateScore < bestScore) return candidate
        if (candidateScore === bestScore && candidate.length < best.length) return candidate
        return best
    }, original)
}

export const cleanDisplayText = (value: string | null | undefined): string =>
    repairMojibake(value).replace(/\s+/g, ' ').trim()

export const normalizeNameKey = (value: string | null | undefined): string =>
    cleanDisplayText(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
