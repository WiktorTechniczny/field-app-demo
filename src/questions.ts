export type ContractSectionKey = 'agreement' | 'client' | 'property' | 'fees'

export interface QDef {
    id: string
    num: number
    text: string
    type: 'text' | 'textarea' | 'date' | 'tel' | 'radio'
    section: ContractSectionKey
    placeholder?: string
    required?: boolean
    rows?: number
    inputMode?: 'text' | 'numeric' | 'tel' | 'decimal'
    autoComplete?: string
    options?: string[]
    conditional?: { questionId: string; answer: string }
    suffix?: string
}

export const CONTRACT_SECTIONS: { key: ContractSectionKey; label: string; description: string }[] = [
    { key: 'agreement', label: 'Umowa', description: 'Data i miejsce podpisania umowy.' },
    { key: 'client', label: 'Klient', description: 'Dane klienta podpisującego umowę.' },
    { key: 'property', label: 'Nieruchomość', description: 'Adres nieruchomości i dane ewidencyjne.' },
    { key: 'fees', label: 'Wynagrodzenie', description: 'Podaj kwoty liczbami. System sam dopisze zapis słowny w umowie.' }
]

export const QS: QDef[] = [
    {
        id: 'contract_date',
        num: 1,
        text: 'Data zawarcia umowy',
        type: 'date',
        section: 'agreement',
        required: true
    },
    {
        id: 'contract_place',
        num: 2,
        text: 'Miejsce zawarcia umowy',
        type: 'text',
        section: 'agreement',
        required: true,
        placeholder: 'np. Warszawa',
        autoComplete: 'address-level2'
    },
    {
        id: 'client_name',
        num: 3,
        text: 'Klient (imię i nazwisko)',
        type: 'text',
        section: 'client',
        required: true,
        placeholder: 'Imię i nazwisko klienta',
        autoComplete: 'name'
    },
    {
        id: 'client_pesel',
        num: 4,
        text: 'PESEL klienta',
        type: 'text',
        section: 'client',
        required: true,
        placeholder: '11 cyfr',
        inputMode: 'numeric',
        autoComplete: 'off'
    },
    {
        id: 'client_phone',
        num: 5,
        text: 'Numer telefonu kontaktowego',
        type: 'tel',
        section: 'client',
        required: true,
        placeholder: 'np. 500 600 700',
        inputMode: 'tel',
        autoComplete: 'tel'
    },
    {
        id: 'property_address',
        num: 6,
        text: 'Adres nieruchomości objętej roszczeniem',
        type: 'textarea',
        section: 'property',
        required: true,
        rows: 3,
        placeholder: 'Ulica, numer, kod pocztowy, miejscowość'
    },
    {
        id: 'property_registry_details',
        num: 7,
        text: 'Nr KW / nr działki / obręb / gmina',
        type: 'textarea',
        section: 'property',
        required: true,
        rows: 3,
        placeholder: 'Np. WA1M/00000000/0; dz. 12/4; obręb 0012; gmina Warszawa'
    },
    {
        id: 'correspondence_address',
        num: 8,
        text: 'Adres do korespondencji, jeśli jest inny',
        type: 'textarea',
        section: 'property',
        required: false,
        rows: 3,
        placeholder: 'Opcjonalnie'
    },
    {
        id: 'base_fee_amount',
        num: 9,
        text: 'Kwota wynagrodzenia podstawowego brutto (w zł)',
        type: 'text',
        section: 'fees',
        required: true,
        placeholder: 'np. 5 000,00',
        inputMode: 'decimal'
    },
    {
        id: 'success_fee_percent',
        num: 10,
        text: 'Jaki procent premii za sukces od kwoty faktycznie uzyskanej przez klienta ustalono',
        type: 'text',
        section: 'fees',
        required: true,
        placeholder: 'np. 36',
        inputMode: 'decimal'
    }
]

export const CONTRACT_CLAUSES = {
    subject: [
        'Klient zleca, a Kancelaria przyjmuje do prowadzenia sprawę związaną z dochodzeniem roszczeń dotyczących nieruchomości Klienta, w szczególności:',
        'zapłaty wynagrodzenia za bezumowne korzystanie z gruntu,',
        'ustanowienia służebności przesyłu lub przechodu,',
        'zapłaty wynagrodzenia lub odszkodowania z tego tytułu,',
        'negocjacji z przedsiębiorstwami przesyłowymi,',
        'prowadzenia postępowań przedsądowych, sądowych, egzekucyjnych oraz mediacyjnych z tego tytułu.',
        'W ramach niniejszej Umowy, Kancelaria może korzystać z usług podmiotów współpracujących, w szczególności adwokatów lub radców prawnych, przy czym Kancelaria ponosi pełną odpowiedzialność wobec Klienta za działania tych osób, traktując je jak własne.',
        'Klient zobowiązuje się niezwłocznie informować Kancelarię o wszelkich zmianach swoich danych kontaktowych, takich jak numer telefonu, adres e-mail i adres do korespondencji.'
    ],
    remuneration: [
        'Wynagrodzenie podstawowe obejmuje wyłącznie czynności prawne i organizacyjne podejmowane przez Kancelarię w związku z prowadzeniem sprawy i nie obejmuje kosztów zewnętrznych, o których mowa w § 4.',
        'Wynagrodzenie, o którym mowa w ust. 1 będzie należne do zapłaty w ciągu 7 dni od daty podpisania niniejszej umowy. Płatność zostanie dokonana na rachunek bankowy Kancelarii, który jest prowadzony w mBank S.A. o numerze 18 1140 2004 0000 3102 8630 4220.',
        'Strony zgodnie ustalają, że wynagrodzenie podstawowe uiszczone przez Klienta obejmuje przeprowadzenie przez Kancelarię wstępnej analizy stanu faktycznego i prawnego sprawy w zakresie istnienia i zasadności roszczeń Klienta.',
        'Kancelaria zobowiązuje się do przeprowadzenia analizy, o której mowa powyżej, w terminie do 14 dni od dnia zawarcia niniejszej Umowy, przy założeniu terminowego przekazania przez Klienta kompletu dokumentów i informacji niezbędnych do jej przeprowadzenia.',
        'W przypadku, gdy z przeprowadzonej analizy będzie wynikać, że Klientowi nie przysługują roszczenia, o których mowa w § 1 Umowy, Kancelaria zobowiązuje się do zwrotu Klientowi całości uiszczonego wynagrodzenia podstawowego w terminie 14 dni od dnia przekazania Klientowi pisemnej informacji o wyniku analizy.',
        'Zwrot wynagrodzenia, o którym mowa powyżej, wyczerpuje wszelkie roszczenia Klienta wobec Kancelarii związane z zawarciem niniejszej umowy.',
        'W przypadku, gdy analiza wykaże istnienie roszczeń Klienta, wynagrodzenie, o którym mowa w ust. 1, nie podlega zwrotowi i zalicza się na poczet dalszego prowadzenia sprawy na zasadach określonych w Umowie.'
    ],
    successFee: [
        'Success fee naliczane jest od każdej kwoty faktycznie uzyskanej przez Klienta, w szczególności:',
        'zasądzonej wyrokiem,',
        'wypłaconej w wyniku ugody,',
        'zapłaconej dobrowolnie przez operatora przesyłowego,',
        'uzyskanej w postępowaniu egzekucyjnym.',
        'Podstawę obliczenia stanowi pełna kwota świadczenia głównego wraz z odsetkami.',
        'Klient upoważnia Kancelarię do odbioru wszelkich uzyskanych należności w jego imieniu.',
        'Kancelaria zobowiązuje się do przekazania Klientowi kwoty stanowiącej różnicę pomiędzy całością uzyskanej należności a należnym Kancelarii wynagrodzeniem (w tym success fee), w terminie 7 dni od daty faktycznego wpływu środków na rachunek bankowy Kancelarii.'
    ]
}

export const questionTextMap: Record<string, string> = Object.fromEntries(QS.map((q) => [q.id, `${q.num}. ${q.text}`]))
