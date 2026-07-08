import type { ContractPacketContext } from './types'
import { buildGdprText, buildReceivablesAuthorizationText } from './gdprAndAuthorizationDocuments'
import { buildGeneralPowerOfAttorneyText, buildProcessPowerOfAttorneyText } from './powerOfAttorneyDocuments'
import { buildWithdrawalFormText, buildWithdrawalInstructionText } from './withdrawalDocuments'
import {
    buildContractMetaText,
    buildContractPartyShortLabel,
    escapeHtml,
    renderDocumentPage,
    renderMetaItems,
    renderPartySpecificPages,
    renderSignatureLines,
    renderTextBlock
} from './utils'

export type { ContractParty, ContractPacketContext, ContractPacketTemplateMeta } from './types'
export { formatContractPacketClientLabel } from './utils'

export const buildPrintableContractPacketHtml = (context: ContractPacketContext, contractText: string): string => {
    const clientLabel = buildContractPartyShortLabel(context.parties)
    const clientSignatureLabels = context.parties.map((_, index) =>
        context.parties.length > 1 ? `Podpis Klienta ${index + 1}` : 'Podpis Klienta'
    )

    return `<!doctype html>
<html lang="pl">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Komplet dokumentów - ${escapeHtml(clientLabel)}</title>
    <style>
        :root { color-scheme: light; }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            font-family: "Times New Roman", Georgia, serif;
            background: #eef2f7;
            color: #111827;
        }
        .toolbar {
            position: sticky;
            top: 0;
            z-index: 10;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 12px;
            padding: 16px 20px;
            background: rgba(15, 23, 42, 0.94);
            color: #f8fafc;
        }
        .toolbar-title {
            font: 600 14px/1.4 Arial, sans-serif;
            letter-spacing: 0.04em;
            text-transform: uppercase;
        }
        .toolbar-subtitle {
            margin-top: 6px;
            color: #cbd5e1;
        }
        .toolbar-meta-grid,
        .document-meta-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 6px 18px;
        }
        .toolbar-meta-grid {
            font: 400 13px/1.4 Arial, sans-serif;
        }
        .document-meta-grid {
            margin-top: 6px;
            font: 400 12px/1.5 Arial, sans-serif;
            color: #475569;
        }
        .toolbar-meta-grid-item,
        .document-meta-grid-item {
            min-width: 0;
        }
        .toolbar-actions {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }
        .toolbar button {
            border: 0;
            border-radius: 999px;
            padding: 10px 16px;
            font: 600 13px/1 Arial, sans-serif;
            cursor: pointer;
            background: #06b6d4;
            color: #fff;
        }
        .toolbar button.secondary {
            background: #1e293b;
            color: #e2e8f0;
            border: 1px solid #334155;
        }
        .page {
            width: min(210mm, calc(100% - 24px));
            margin: 24px auto;
            padding: 18mm 16mm;
            background: #fff;
            box-shadow: 0 18px 50px rgba(15, 23, 42, 0.14);
        }
        .meta {
            margin-bottom: 18px;
            padding-bottom: 12px;
            border-bottom: 1px solid #cbd5e1;
            font: 400 13px/1.6 Arial, sans-serif;
            color: #475569;
        }
        .meta strong { color: #0f172a; }
        .document-head {
            margin-bottom: 18px;
            padding-bottom: 12px;
            border-bottom: 1px solid #cbd5e1;
        }
        .document-head h2 {
            margin: 0;
            font: 700 18px/1.3 Arial, sans-serif;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            color: #0f172a;
        }
        .document-head p {
            margin: 6px 0 0;
            font: 400 12px/1.5 Arial, sans-serif;
            color: #475569;
        }
        .document-body {
            white-space: pre-wrap;
            font-size: 12.5pt;
            line-height: 1.72;
        }
        .packet-page + .packet-page {
            page-break-before: always;
        }
        .signatures {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 28px;
            margin-top: 36px;
            padding-top: 20px;
        }
        .signature-line {
            padding-top: 32px;
            border-top: 1px solid #334155;
            text-align: center;
            font: 600 12px/1.4 Arial, sans-serif;
            color: #334155;
        }
        @page {
            size: A4;
            margin: 14mm;
        }
        @media print {
            body { background: #fff; }
            .toolbar { display: none; }
            .page {
                width: 100%;
                margin: 0;
                padding: 0;
                box-shadow: none;
            }
        }
        @media (max-width: 720px) {
            .toolbar {
                align-items: flex-start;
                flex-direction: column;
            }
            .toolbar-meta-grid,
            .document-meta-grid {
                gap: 4px 12px;
            }
            .page {
                width: calc(100% - 16px);
                margin: 8px auto 24px;
                padding: 20px 16px;
            }
            .signatures {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <div>
            <div class="toolbar-title">Komplet umowy i załączników do druku</div>
            <div class="toolbar-subtitle">${renderMetaItems(`${buildContractMetaText(context)} | Klient: ${clientLabel}`, 'toolbar-meta-grid')}</div>
        </div>
        <div class="toolbar-actions">
            <button type="button" onclick="window.print()">Drukuj / Zapisz jako PDF</button>
            <button type="button" class="secondary" onclick="window.close()">Zamknij</button>
        </div>
    </div>
    <main>
        <section class="page packet-page">
            <div class="meta">
                <strong>Wersja pakietu:</strong> komplet dokumentów przygotowany automatycznie na podstawie danych z formularza i wariantu umowy ${escapeHtml(
                    context.template.label
                )}.
            </div>
            <article class="document-body">${renderTextBlock(contractText)}</article>
            ${renderSignatureLines(['Podpis w imieniu Kancelarii', ...clientSignatureLabels])}
        </section>
        ${renderPartySpecificPages(
            context,
            'Załącznik nr 1 - Pełnomocnictwo procesowe',
            (party) => `Mocodawca: ${party.fullName} | Nieruchomość: ${context.propertyAddress}`,
            (party) => buildProcessPowerOfAttorneyText(context, party),
            () => ['Data i podpis Mocodawcy']
        )}
        ${renderPartySpecificPages(
            context,
            'Załącznik nr 2 - Pełnomocnictwo ogólne',
            (party) => `Mocodawca: ${party.fullName} | Do organów i urzędów`,
            (party) => buildGeneralPowerOfAttorneyText(context, party),
            () => ['Data i podpis Mocodawcy']
        )}
        ${renderDocumentPage(
            'Załącznik nr 3 - Pouczenie o prawie do odstąpienia od umowy',
            `Umowa zawarta dnia ${context.contractDate} w ${context.contractPlace}`,
            buildWithdrawalInstructionText(context),
            renderSignatureLines(
                context.parties.map((_, index) =>
                    context.parties.length > 1
                        ? `Potwierdzenie odbioru pouczenia - Klient ${index + 1}`
                        : 'Potwierdzenie odbioru pouczenia'
                )
            )
        )}
        ${renderPartySpecificPages(
            context,
            'Załącznik nr 3 - Wzór oświadczenia o odstąpieniu od umowy',
            (party) => `Wzór do wykorzystania przez: ${party.fullName}`,
            (party) => buildWithdrawalFormText(context, party),
            () => ['Podpis Klienta']
        )}
        ${renderDocumentPage(
            'Załącznik nr 4 - Klauzula informacyjna RODO',
            'Informacja o przetwarzaniu danych osobowych',
            buildGdprText(context),
            renderSignatureLines(clientSignatureLabels)
        )}
        ${renderPartySpecificPages(
            context,
            'Załącznik nr 5 - Upoważnienie do odbioru należności',
            (party) => `Klient: ${party.fullName} | Rozliczenie zgodnie z umową ${context.template.label}`,
            (party) => buildReceivablesAuthorizationText(context, party),
            () => ['Miejscowość, data i podpis Klienta']
        )}
    </main>
</body>
</html>`
}
