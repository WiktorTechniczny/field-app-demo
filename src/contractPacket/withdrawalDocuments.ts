import type { ContractPacketContext, ContractParty } from './types'
import { COMPANY_ADDRESS, COMPANY_EMAIL, COMPANY_NAME } from './types'
import { buildContractPartyFullLabel, normalizeLineValue } from './utils'

export const buildWithdrawalInstructionText = (context: ContractPacketContext): string => {
    const clientLabel = buildContractPartyFullLabel(context.parties)
    return [
        'Wszelkie terminy pisane wielką literą mają znaczenie określone w umowie o świadczenie usług zawartej między Demo Services sp. z o.o. (dalej jako: Demo Services lub „my”) jako przyjmującym zlecenie a ' +
            `${clientLabel} (dalej jako: „Klient” lub „Ty”) jako dającym zlecenie (dalej jako: „Umowa”), chyba że co innego wynika z treści lub kontekstu niniejszego pouczenia.`,
        '',
        'PRAWO DO ODSTĄPIENIA OD UMOWY',
        '',
        'Zgodnie z przepisami ustawy z dnia 30 maja 2014 r. o prawach konsumenta (Dz. U. z 2023 r., poz. 2759 ze zm.), (dalej jako: „Ustawa o prawach konsumenta”) w związku z zawartą Umową informujemy, że masz prawo odstąpić od niniejszej Umowy w terminie 14 dni od dnia zawarcia Umowy, bez podania jakiejkolwiek przyczyny.',
        `W celu skorzystania z prawa do odstąpienia od Umowy, musisz poinformować nas o takiej decyzji w drodze jednoznacznego oświadczenia, na przykład pismem wysłanym pocztą na adres: ${COMPANY_NAME}, ${COMPANY_ADDRESS}, lub pocztą elektroniczną na adres: ${COMPANY_EMAIL}.`,
        'W tym celu możesz skorzystać z załączonego wzoru oświadczenia o odstąpieniu od Umowy, jednak nie jest to obowiązkowe.',
        'Aby zachować termin do odstąpienia od Umowy, wystarczy, abyś wysłał informację dotyczącą wykonania przysługującego Tobie prawa do odstąpienia od Umowy przed upływem czternastodniowego terminu do odstąpienia od Umowy.',
        '',
        'SKUTKI ODSTĄPIENIA OD UMOWY',
        '',
        'W przypadku odstąpienia od niniejszej Umowy, Demo Services niezwłocznie zwraca wszelkie płatności otrzymane od Klienta, a w każdym wypadku nie później niż 14 dni od dnia, w którym Demo Services został poinformowany o Twojej decyzji o skorzystaniu z prawa odstąpienia od niniejszej Umowy.',
        'Demo Services dokona zwrotu płatności przy użyciu takich samych sposobów płatności, jakie zostały przez Ciebie użyte w pierwotnej transakcji, chyba że wyraźnie zgodzisz się na inne rozwiązanie, w każdym przypadku nie poniesiesz żadnych opłat w związku z tym zwrotem.',
        'Jeżeli żądałeś od nas rozpoczęcia świadczenia usług przed upływem terminu do odstąpienia od Umowy, zapłacisz Demo Services kwotę proporcjonalną do zakresu świadczeń spełnionych do chwili, w której poinformowałeś nas o odstąpieniu od niniejszej Umowy.',
        'Jeżeli na skutek złożonego przez Ciebie żądania rozpoczęcia świadczenia usług przez Demo Services przed upływem terminu do odstąpienia od Umowy, Demo Services wykona całą usługę przed upływem terminu do odstąpienia od Umowy, utracisz prawo do odstąpienia od Umowy na podstawie art. 38 pkt 1 Ustawy o prawach konsumenta.',
        '',
        'REKLAMACJA',
        '',
        `Klientowi przysługuje prawo do złożenia reklamacji na świadczone przez Demo Services usługi w ramach Umowy. Reklamację można złożyć w formie pisemnej, listem poleconym na adres: ${COMPANY_NAME}, ${COMPANY_ADDRESS}, lub pocztą elektroniczną na adres: ${COMPANY_EMAIL}.`,
        'Demo Services rozpatrzy reklamację w terminie 14 dni od dnia jej otrzymania.',
        'Odpowiedź na złożoną reklamację zostanie udzielona na piśmie i zostanie przesłana na adres Klienta podany w Umowie lub na inny adres, wskazany w treści reklamacji.',
        '',
        'POZASĄDOWE SPOSOBY ROZPATRYWANIA REKLAMACJI',
        '',
        'Jeżeli złożona przez Ciebie reklamacja na usługi Demo Services nie zostanie uwzględniona, masz prawo skorzystać z pozasądowych sposobów rozpatrywania reklamacji w drodze mediacji lub za pomocą sądów polubownych, składając na odpowiednim formularzu wniosek do właściwego terenowo Wojewódzkiego Inspektoratu Inspekcji Handlowej.',
        'Możesz również zwrócić się o pomoc do właściwego terenowo miejskiego lub powiatowego rzecznika konsumentów.',
        'Ze wskazanych sposobów rozwiązywania sporów można skorzystać dobrowolnie i nieodpłatnie.',
        'Więcej informacji na ten temat można uzyskać we wskazanych instytucjach oraz w Urzędzie Ochrony Konkurencji i Konsumentów i na stronie internetowej www.uokik.gov.pl.'
    ].join('\n')
}

export const buildWithdrawalFormText = (context: ContractPacketContext, party: ContractParty): string =>
    [
        `${normalizeLineValue(context.contractPlace)}, dnia ____________________`,
        normalizeLineValue(party.fullName),
        normalizeLineValue(party.address),
        '',
        COMPANY_NAME,
        COMPANY_ADDRESS,
        '',
        'OŚWIADCZENIE O ODSTĄPIENIU OD UMOWY',
        '',
        `Ja niżej podpisany/a oświadczam, że odstępuję od umowy o świadczenie pomocy prawnej zawartej dnia ${normalizeLineValue(context.contractDate)}.`,
        'Wobec odstąpienia od umowy, wypowiadam także pełnomocnictwo do prowadzenia sprawy udzielone przy zawarciu umowy.'
    ].join('\n')
