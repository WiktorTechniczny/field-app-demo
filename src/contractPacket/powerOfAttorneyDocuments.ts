import type { ContractPacketContext, ContractParty } from './types'
import { COMPANY_NAME, COMPANY_REGISTRY, PROCESS_ATTORNEY_LINE } from './types'
import { normalizeLineValue } from './utils'

export const buildProcessPowerOfAttorneyText = (context: ContractPacketContext, party: ContractParty): string =>
    [
        'Ja, niżej podpisana/y',
        `${normalizeLineValue(party.fullName)}`,
        `(PESEL ${normalizeLineValue(party.pesel)}), adres: ${normalizeLineValue(party.address)}, w imieniu własnym, w trybie art. 91 k.p.c., udzielam pełnomocnictwa z prawem udzielania dalszych pełnomocnictw substytucyjnych:`,
        '',
        PROCESS_ATTORNEY_LINE,
        '',
        'do samodzielnego występowania w moim imieniu przed wszystkimi osobami oraz sądami, w sprawie przeciwko przedsiębiorstwu przesyłowemu lub każdemu jego następcy prawnemu (dalej jako: „Operator Przesyłowy”) w sprawie dotyczącej roszczeń o ustanowienie służebności przesyłu za wynagrodzeniem (dalej jako: „Umowa o służebność”) – na etapie przedsądowym, sądowym i egzekucyjnym.',
        '',
        'Niniejsze pełnomocnictwo obejmuje umocowanie do wszystkich łączących się ze sprawą czynności pozaprocesowych oraz procesowych, we wszelkich rodzajach postępowań przed wszelkimi osobami, organami administracji publicznej, sądami powszechnymi każdej instancji, Sądem Najwyższym, a także organami egzekucyjnymi, nie wyłączając złożenia skargi o wznowienie postępowania, skargi kasacyjnej, skargi o stwierdzenie niezgodności z prawem prawomocnego orzeczenia i postępowania wywołanego ich wniesieniem, a także wszelkich czynności dotyczących zabezpieczenia i egzekucji.',
        '',
        'Niniejsze pełnomocnictwo obejmuje również umocowanie do wszystkich łączących się ze sprawą czynności o charakterze materialnoprawnym, w tym szczególnie do:',
        'a) prowadzenia negocjacji oraz przedstawiania stanowiska i składania wszelkich oświadczeń w moim imieniu,',
        'b) negocjowania i zawierania ugód oraz porozumień w przedmiocie ustanowienia służebności przesyłu.',
        '',
        `Nieruchomość objęta sprawą: ${normalizeLineValue(context.propertyAddress)}`,
        `Opis nieruchomości / KW / działki: ${normalizeLineValue(context.propertyRegistryDetails)}`,
        '',
        'Przyjmuję pełnomocnictwo i udzielam pełnomocnictwa substytucyjnego w zakresie opisanym powyżej:',
        `1. ${PROCESS_ATTORNEY_LINE}`
    ].join('\n')

export const buildGeneralPowerOfAttorneyText = (context: ContractPacketContext, party: ContractParty): string =>
    [
        'Ja, niżej podpisany/a',
        normalizeLineValue(party.fullName),
        `adres: ${normalizeLineValue(party.address)}`,
        `PESEL: ${normalizeLineValue(party.pesel)},`,
        'niniejszym udzielam pełnomocnictwa',
        `${normalizeLineValue(context.representativeName)} - pełnomocnikowi ${COMPANY_NAME}`,
        `(${COMPANY_REGISTRY})`,
        '',
        'do reprezentowania mnie przed wszelkimi organami administracji publicznej, jednostkami samorządu terytorialnego, ich jednostkami organizacyjnymi, a także innymi podmiotami wykonującymi zadania publiczne, jak również przed osobami fizycznymi i prawnymi oraz innymi podmiotami, w szczególności przed:',
        '    • urzędami gmin i miast,',
        '    • starostwami powiatowymi,',
        '    • urzędami marszałkowskimi,',
        '    • organami administracji rządowej zespolonej i niezespolonej,',
        '    • innymi urzędami i instytucjami publicznymi,',
        '    • geodetami, biegłymi, rzeczoznawcami oraz innymi specjalistami z zakresu geodezji, kartografii i gospodarki nieruchomościami,',
        '',
        'w celu występowania o udostępnienie, uzyskanie, wgląd, sporządzanie kopii, odpisów, wypisów, wyciągów oraz poświadczonych kopii wszelkiej dokumentacji, informacji, opinii, analiz, ekspertyz i opracowań geodezyjnych i danych dotyczących lub związanych z:',
        '    • ustanowieniem, projektowaniem, przebiegiem, treścią lub skutkami prawnymi służebności przesyłu,',
        '    • nieruchomością lub nieruchomościami Mocodawcy, na których służebność przesyłu ma być lub była ustanawiana,',
        '    • inwestycjami infrastrukturalnymi, urządzeniami przesyłowymi, decyzjami administracyjnymi, uzgodnieniami, mapami, operatami geodezyjnymi, dokumentacją planistyczną i techniczną,',
        '    • postępowaniami administracyjnymi, które były lub są prowadzone w związku z ustanowieniem służebności przesyłu lub przygotowaniem do jej ustanowienia.',
        '',
        'Pełnomocnictwo obejmuje w szczególności prawo do:',
        '    • składania wniosków, zapytań i podań,',
        '    • odbioru korespondencji, dokumentów i informacji,',
        '    • działania w trybie przepisów o dostępie do informacji publicznej oraz innych przepisów szczególnych,',
        '    • reprezentowania mnie w czynnościach faktycznych i prawnych związanych z uzyskiwaniem powyższej dokumentacji.',
        '',
        'Pełnomocnictwo ma charakter ogólny w zakresie czynności niezbędnych do ustalenia stanu prawnego i faktycznego nieruchomości Mocodawcy oraz dokumentacji związanej z ustanowieniem służebności przesyłu.',
        'Pełnomocnik jest uprawniony do udzielania dalszych pełnomocnictw (substytucji).',
        'Pełnomocnictwo zostaje udzielone na czas nieoznaczony i może zostać w każdym czasie odwołane.'
    ].join('\n')
