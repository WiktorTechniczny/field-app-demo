export interface LocalityDefinition {
    code: string
    label: string
    aliases: string[]
}

const LOCALITY_DEFINITIONS: LocalityDefinition[] = [
    { code: '260414', label: 'Piekoszow', aliases: ['piekoszow', 'piekoszow gmina'] },
    { code: '260409', label: 'Pruszkow', aliases: ['pruszkow', 'pruszkow gmina'] },
    { code: '260404', label: 'Daleszyce', aliases: ['daleszyce'] },
    { code: '260403', label: 'Checiny', aliases: ['checiny', 'checiny miasto', 'checiny - miasto'] },
    { code: '260408', label: 'Miedziana Gora', aliases: ['miedziana gora', 'miedziana gora gmina'] },
    { code: '260410', label: 'Morawica', aliases: ['morawica'] },
    { code: '260417', label: 'Strawczyn', aliases: ['strawczyn', 'promnik'] },
    { code: '260418', label: 'Piaseczno', aliases: ['piaseczno'] },
    { code: '266101', label: 'Warszawa', aliases: ['warszawa'] }
]

function normalizeText(value: string) {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
}

export function getParcelNumberFromIdentifier(value?: string | null) {
    const normalized = `${value || ''}`.trim()
    if (!normalized) return ''

    const lastDotIndex = normalized.lastIndexOf('.')
    const parcelNumber = lastDotIndex >= 0 ? normalized.slice(lastDotIndex + 1) : normalized
    return parcelNumber || normalized
}

export function getLocalityCodeFromParcelId(parcelId?: string | null) {
    const normalized = `${parcelId || ''}`.trim()
    const match = normalized.match(/^(\d{6})_/)
    return match?.[1] || null
}

export function getLocalityDefinition(code?: string | null) {
    if (!code) return null
    return LOCALITY_DEFINITIONS.find((item) => item.code === code) || null
}

export function getLocalityLabelFromCode(code?: string | null) {
    if (!code) return null
    return getLocalityDefinition(code)?.label || `Obszar ${code}`
}

export function getLocalityLabelFromParcelId(parcelId?: string | null) {
    return getLocalityLabelFromCode(getLocalityCodeFromParcelId(parcelId))
}

export function findMatchingLocalityCodes(query: string) {
    const normalizedQuery = normalizeText(query)
    if (normalizedQuery.length < 3) return null

    const matches = LOCALITY_DEFINITIONS
        .filter((locality) =>
            normalizeText(locality.code).includes(normalizedQuery) ||
            normalizeText(locality.label).includes(normalizedQuery) ||
            locality.aliases.some((alias) => normalizeText(alias).includes(normalizedQuery))
        )
        .map((locality) => locality.code)

    return matches.length > 0 ? matches : null
}
