# Field App Demo

Publiczna wersja pokazowa aplikacji terenowej / PWA przygotowana do portfolio Fullstack Studio.

Demo pokazuje:

- panel administratora z mapa, zespołem, spotkaniami i raportami,
- widok pracownika terenowego,
- plan dnia i statusy spotkan,
- przykladowe GPS logi, ankiety i przypisania,
- neutralne dane testowe bez polaczenia z prywatnym backendem.

Ta wersja nie laczy sie z firmowym Supabase. Frontend uzywa lokalnego mock API w pamieci przegladarki.

## Konta demo

- Admin: `admin` / `admin123`
- Pracownik: `adam` / `demo123`

## Uruchomienie lokalne

```powershell
npm install
npm run dev
```

## Build

```powershell
npm run build
```

## Zasady publicznego demo

- Nie wrzucac `.env`, kluczy API, danych klientow ani prywatnych eksportow.
- Nie laczyc publicznego demo z produkcyjna baza.
- Dane w repo sa neutralne i sluza tylko do prezentacji workflow.
