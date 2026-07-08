export type ContractParty = {
    fullName: string
    pesel: string
    address: string
    phone?: string
}

export type ContractPacketTemplateMeta = {
    variant: '1k' | '3k'
    version: string
    label: string
}

export type ContractPacketContext = {
    contractDate: string
    contractPlace: string
    representativeName: string
    propertyAddress: string
    propertyRegistryDetails: string
    baseFeeAmount: string
    baseFeeWords: string
    successFeePercent: string
    successFeeWords: string
    template: ContractPacketTemplateMeta
    parties: ContractParty[]
}

export const COMPANY_NAME = 'Demo Services sp. z o.o.'
export const COMPANY_ADDRESS = 'ul. Przykladowa 1, 00-000 Warszawa'
export const COMPANY_EMAIL = 'kontakt@example.test'
export const COMPANY_REGISTRY = 'KRS 0000000000, NIP 0000000000, REGON 000000000'
export const PROCESS_ATTORNEY_LINE = 'pelnomocnik demo, nr wpisu DEMO/000'
export const DOTTED_LINE = '..............................................................................................................'
