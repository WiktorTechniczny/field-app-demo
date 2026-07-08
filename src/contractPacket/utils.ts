import type { ContractPacketContext, ContractParty } from './types'
import { DOTTED_LINE } from './types'

export const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')

export const renderTextBlock = (value: string): string => escapeHtml(value)

export const renderMetaItems = (value: string, className = 'document-meta-grid'): string => {
    const items = value
        .split('|')
        .map((item) => item.trim())
        .filter(Boolean)

    if (items.length <= 1) {
        return `<p>${escapeHtml(value)}</p>`
    }

    return `<div class="${className}">${items
        .map((item) => `<div class="${className}-item">${escapeHtml(item)}</div>`)
        .join('')}</div>`
}

export const normalizeLineValue = (value: string | undefined): string => {
    const trimmed = (value || '').trim()
    return trimmed || DOTTED_LINE
}

export const buildContractPartyShortLabel = (parties: ContractParty[]): string => {
    if (parties.length === 0) return 'Klient'
    if (parties.length === 1) return parties[0].fullName
    return `${parties[0].fullName} + ${parties.length - 1}`
}

export const buildContractPartyFullLabel = (parties: ContractParty[]): string => {
    const names = parties
        .map((party) => party.fullName.trim())
        .filter(Boolean)

    if (names.length === 0) return 'Klient'
    if (names.length === 1) return names[0]
    if (names.length === 2) return `${names[0]} i ${names[1]}`
    return `${names.slice(0, -1).join(', ')} i ${names[names.length - 1]}`
}

export const formatContractPacketClientLabel = (parties: ContractParty[]): string => buildContractPartyShortLabel(parties)

export const renderSignatureLines = (labels: string[]): string =>
    `<section class="signatures">${labels
        .map((label) => `<div class="signature-line">${escapeHtml(label)}</div>`)
        .join('')}</section>`

export const renderDocumentPage = (title: string, subtitle: string, bodyText: string, signaturesHtml: string): string => `
    <section class="page packet-page">
        <div class="document-head">
            <h2>${escapeHtml(title)}</h2>
            ${renderMetaItems(subtitle)}
        </div>
        <article class="document-body">${renderTextBlock(bodyText)}</article>
        ${signaturesHtml}
    </section>
`

export const renderPartySpecificPages = (
    context: ContractPacketContext,
    title: string,
    subtitleBuilder: (party: ContractParty, index: number) => string,
    bodyBuilder: (party: ContractParty, index: number) => string,
    signatureLabelBuilder: (party: ContractParty, index: number) => string[]
): string =>
    context.parties
        .map((party, index) =>
            renderDocumentPage(
                title,
                subtitleBuilder(party, index),
                bodyBuilder(party, index),
                renderSignatureLines(signatureLabelBuilder(party, index))
            )
        )
        .join('')

export const buildContractMetaText = (context: ContractPacketContext): string =>
    [
        `Wariant umowy: ${context.template.label}`,
        `Data umowy: ${context.contractDate}`,
        `Miejsce zawarcia: ${context.contractPlace}`,
        `Nieruchomość: ${context.propertyAddress}`,
        `Nr KW / działki / obręb / gmina: ${context.propertyRegistryDetails}`
    ].join(' | ')
