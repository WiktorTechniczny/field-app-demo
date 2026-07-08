type Row = Record<string, any>
type TableName =
  | 'users'
  | 'shifts'
  | 'surveys'
  | 'gps_logs'
  | 'sales_meetings'
  | 'pole_assignments'
  | 'appointments'
  | 'appointment_limits'

type QueryResult<T = any> = {
  data: T | null
  error: { message: string; code?: string } | null
  count?: number | null
}

const now = new Date()
const today = now.toISOString().slice(0, 10)
const at = (hour: number, minute = 0) => {
  const date = new Date(now)
  date.setHours(hour, minute, 0, 0)
  return date.toISOString()
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))

const seed = {
  users: [
    { id: 1, login: 'admin', password: 'admin123', name: 'Demo Admin', role: 'admin' },
    { id: 2, login: 'adam', password: 'demo123', name: 'Adam Nowak', role: 'worker' },
    { id: 3, login: 'marta', password: 'demo123', name: 'Marta Zielinska', role: 'worker' },
    { id: 4, login: 'piotr', password: 'demo123', name: 'Piotr Wisniewski', role: 'worker' },
  ],
  shifts: [
    { id: 1, user_id: 2, user_name: 'Adam Nowak', start_time: at(8, 5), total_surveys: 2 },
    { id: 2, user_id: 3, user_name: 'Marta Zielinska', start_time: at(8, 25), end_time: at(15, 45), total_surveys: 3 },
    { id: 3, user_id: 4, user_name: 'Piotr Wisniewski', start_time: at(9, 0), total_surveys: 1 },
  ],
  gps_logs: [
    { id: 1, user_id: 2, user_name: 'Adam Nowak', shift_id: 1, latitude: 50.8721, longitude: 20.6316, timestamp: at(9, 12) },
    { id: 2, user_id: 2, user_name: 'Adam Nowak', shift_id: 1, latitude: 50.8758, longitude: 20.6451, timestamp: at(10, 30) },
    { id: 3, user_id: 3, user_name: 'Marta Zielinska', shift_id: 2, latitude: 50.8528, longitude: 20.6067, timestamp: at(11, 10) },
    { id: 4, user_id: 4, user_name: 'Piotr Wisniewski', shift_id: 3, latitude: 50.8891, longitude: 20.6507, timestamp: at(12, 5) },
  ],
  surveys: [
    {
      id: 1,
      shift_id: 1,
      user_id: 2,
      user_name: 'Adam Nowak',
      created_at: at(9, 40),
      address: 'ul. Spacerowa 12, Warszawa',
      answers: { decision: 'Kontakt ponowny', note: 'Klient prosi o telefon jutro.' },
      respondent_name: 'Klient A',
      respondent_phone: '600 100 200',
      latitude: 50.8721,
      longitude: 20.6316,
      status: 'attempted',
      audio_transcript: 'Krótka notatka demonstracyjna z rozmowy.',
    },
    {
      id: 2,
      shift_id: 2,
      user_id: 3,
      user_name: 'Marta Zielinska',
      created_at: at(11, 15),
      address: 'ul. Polna 8, Pruszkow',
      answers: { decision: 'Umowa podpisana', note: 'Komplet dokumentów.' },
      respondent_name: 'Klient B',
      respondent_phone: '600 200 300',
      latitude: 50.8962,
      longitude: 20.7234,
      status: 'completed',
    },
    {
      id: 3,
      shift_id: 3,
      user_id: 4,
      user_name: 'Piotr Wisniewski',
      created_at: at(12, 20),
      address: 'ul. Lesna 4, Piaseczno',
      answers: { decision: 'Brak osoby decyzyjnej' },
      respondent_name: 'Klient C',
      respondent_phone: '600 300 400',
      latitude: 50.9705,
      longitude: 20.6602,
      status: 'not_home',
    },
  ],
  sales_meetings: [
    {
      id: 1,
      import_key: 'demo-spotkanie-1',
      salesperson_id: 2,
      salesperson_name: 'Adam Nowak',
      scheduled_at: at(13, 0),
      client_name: 'Firma ABC',
      phone: '600 111 222',
      address: 'ul. Testowa 14, Warszawa',
      region: 'mazowieckie',
      county: 'warszawski',
      municipality: 'Warszawa',
      status: 'planned',
      note: 'Spotkanie demonstracyjne z neutralnymi danymi.',
      pole_lat: 50.8721,
      pole_lng: 20.6316,
      parcel_number: 'demo/24',
      created_at: at(7, 50),
      updated_at: at(7, 50),
    },
    {
      id: 2,
      import_key: 'demo-spotkanie-2',
      salesperson_id: 3,
      salesperson_name: 'Marta Zielinska',
      scheduled_at: at(15, 30),
      client_name: 'Firma Delta',
      phone: '600 222 333',
      address: 'ul. Parkowa 2, Pruszkow',
      region: 'mazowieckie',
      county: 'warszawski',
      municipality: 'Pruszkow',
      status: 'follow_up',
      status_note: 'Kontakt ponowny',
      note: 'Klient chce doprecyzować termin.',
      pole_lat: 50.8962,
      pole_lng: 20.7234,
      parcel_number: 'demo/31',
      created_at: at(8, 15),
      updated_at: at(10, 5),
    },
    {
      id: 3,
      import_key: 'demo-spotkanie-3',
      salesperson_id: 4,
      salesperson_name: 'Piotr Wisniewski',
      scheduled_at: at(10, 0),
      client_name: 'Firma Nova',
      phone: '600 333 444',
      address: 'ul. Gorna 6, Piaseczno',
      region: 'mazowieckie',
      county: 'warszawski',
      municipality: 'Piaseczno',
      status: 'signed',
      linked_survey_id: 3,
      pole_lat: 50.9705,
      pole_lng: 20.6602,
      parcel_number: 'demo/42',
      created_at: at(8, 30),
      updated_at: at(12, 20),
    },
  ],
  pole_assignments: [
    {
      id: 1,
      import_key: 'demo-slup-1',
      pole_id: 'P-001',
      pole_lat: 50.8721,
      pole_lng: 20.6316,
      voivodeship: 'mazowieckie',
      county: 'warszawski',
      municipality: 'Warszawa',
      locality: 'Warszawa',
      address: 'ul. Testowa 14',
      parcel_number: 'demo/24',
      salesperson_id: 2,
      salesperson_name: 'Adam Nowak',
      planned_date: today,
      status_ph: 'planned',
      can_proceed: true,
    },
    {
      id: 2,
      import_key: 'demo-slup-2',
      pole_id: 'P-002',
      pole_lat: 50.8962,
      pole_lng: 20.7234,
      voivodeship: 'mazowieckie',
      county: 'warszawski',
      municipality: 'Pruszkow',
      locality: 'Pruszkow',
      address: 'ul. Parkowa 2',
      parcel_number: 'demo/31',
      salesperson_id: 3,
      salesperson_name: 'Marta Zielinska',
      planned_date: today,
      status_ph: 'follow_up',
      can_proceed: true,
    },
  ],
  appointments: [
    { id: 1, user_id: 2, appointment_date: today, appointment_time: '13:00:00', respondent_name: 'Klient A', address: 'ul. Testowa 14', created_at: at(8, 0) },
    { id: 2, user_id: 3, appointment_date: today, appointment_time: '15:30:00', respondent_name: 'Klient B', address: 'ul. Parkowa 2', created_at: at(8, 5) },
  ],
  appointment_limits: [
    { id: 1, appointment_date: today, appointment_time: '13:00:00', slot_limit: 4, created_at: at(7, 0), updated_at: at(7, 0) },
    { id: 2, appointment_date: today, appointment_time: '15:30:00', slot_limit: 4, created_at: at(7, 0), updated_at: at(7, 0) },
  ],
} satisfies Record<TableName, Row[]>

const db: Record<TableName, Row[]> = clone(seed)
const counters: Record<TableName, number> = Object.fromEntries(
  Object.entries(db).map(([table, rows]) => [table, Math.max(0, ...rows.map((row) => Number(row.id || 0))) + 1]),
) as Record<TableName, number>

const normalize = (value: any) => String(value ?? '').toLowerCase()

class MockQueryBuilder {
  private table: TableName
  private action: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
  private payload: any = null
  private filters: Array<(row: Row) => boolean> = []
  private orderBy: { column: string; ascending: boolean }[] = []
  private limitCount: number | null = null
  private rangeBounds: [number, number] | null = null
  private singleMode: 'single' | 'maybeSingle' | null = null
  private countMode: 'exact' | null = null
  private headOnly = false

  constructor(table: TableName) {
    this.table = table
  }

  select(_columns = '*', options?: { count?: 'exact'; head?: boolean }) {
    this.action = this.action === 'insert' || this.action === 'update' || this.action === 'upsert' ? this.action : 'select'
    this.countMode = options?.count === 'exact' ? 'exact' : null
    this.headOnly = !!options?.head
    return this
  }

  insert(payload: Row | Row[]) {
    this.action = 'insert'
    this.payload = Array.isArray(payload) ? payload : [payload]
    return this
  }

  update(payload: Row) {
    this.action = 'update'
    this.payload = payload
    return this
  }

  upsert(payload: Row | Row[], options?: { onConflict?: string }) {
    this.action = 'upsert'
    this.payload = { rows: Array.isArray(payload) ? payload : [payload], key: options?.onConflict || 'id' }
    return this
  }

  delete() {
    this.action = 'delete'
    return this
  }

  eq(column: string, value: any) {
    this.filters.push((row) => row[column] === value)
    return this
  }

  neq(column: string, value: any) {
    this.filters.push((row) => row[column] !== value)
    return this
  }

  ilike(column: string, value: string) {
    const needle = normalize(value).replace(/%/g, '')
    this.filters.push((row) => normalize(row[column]).includes(needle))
    return this
  }

  is(column: string, value: any) {
    this.filters.push((row) => (value === null ? row[column] == null : row[column] === value))
    return this
  }

  not(column: string, operator: string, value: any) {
    if (operator === 'is' && value === null) this.filters.push((row) => row[column] != null)
    return this
  }

  gte(column: string, value: any) {
    this.filters.push((row) => String(row[column] ?? '') >= String(value))
    return this
  }

  lte(column: string, value: any) {
    this.filters.push((row) => String(row[column] ?? '') <= String(value))
    return this
  }

  in(column: string, values: any[]) {
    this.filters.push((row) => values.includes(row[column]))
    return this
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orderBy.push({ column, ascending: options?.ascending !== false })
    return this
  }

  limit(count: number) {
    this.limitCount = count
    return this
  }

  range(from: number, to: number) {
    this.rangeBounds = [from, to]
    return this
  }

  single() {
    this.singleMode = 'single'
    return this
  }

  maybeSingle() {
    this.singleMode = 'maybeSingle'
    return this
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return this.execute().then(onfulfilled, onrejected)
  }

  private applyFilters(rows: Row[]) {
    return this.filters.reduce((current, filter) => current.filter(filter), rows)
  }

  private applyReadWindow(rows: Row[]) {
    let result = [...rows]
    this.orderBy.forEach(({ column, ascending }) => {
      result.sort((a, b) => {
        const left = a[column] ?? ''
        const right = b[column] ?? ''
        if (left === right) return 0
        return (left > right ? 1 : -1) * (ascending ? 1 : -1)
      })
    })
    if (this.rangeBounds) result = result.slice(this.rangeBounds[0], this.rangeBounds[1] + 1)
    if (this.limitCount !== null) result = result.slice(0, this.limitCount)
    return result
  }

  private async execute(): Promise<QueryResult> {
    const tableRows = db[this.table]

    if (this.action === 'insert') {
      const inserted = this.payload.map((row: Row) => ({ ...clone(row), id: row.id ?? counters[this.table]++ }))
      tableRows.push(...inserted)
      return this.formatResult(inserted)
    }

    if (this.action === 'upsert') {
      const { rows, key } = this.payload as { rows: Row[]; key: string }
      const saved = rows.map((row) => {
        const existingIndex = tableRows.findIndex((current) => current[key] === row[key])
        if (existingIndex >= 0) {
          tableRows[existingIndex] = { ...tableRows[existingIndex], ...clone(row) }
          return tableRows[existingIndex]
        }
        const inserted = { ...clone(row), id: row.id ?? counters[this.table]++ }
        tableRows.push(inserted)
        return inserted
      })
      return this.formatResult(saved)
    }

    const matching = this.applyFilters(tableRows)

    if (this.action === 'update') {
      const updated = matching.map((row) => Object.assign(row, clone(this.payload)))
      return this.formatResult(updated)
    }

    if (this.action === 'delete') {
      const deleted = [...matching]
      deleted.forEach((row) => {
        const index = tableRows.indexOf(row)
        if (index >= 0) tableRows.splice(index, 1)
      })
      return this.formatResult(deleted)
    }

    const readRows = this.applyReadWindow(matching)
    return this.formatResult(readRows, matching.length)
  }

  private formatResult(rows: Row[], count = rows.length): QueryResult {
    if (this.headOnly) return { data: null, error: null, count: this.countMode ? count : null }
    const data = clone(rows)
    if (this.singleMode) return { data: data[0] ?? null, error: null, count: this.countMode ? count : null }
    return { data, error: null, count: this.countMode ? count : null }
  }
}

export const supabase = {
  from(table: TableName) {
    if (!db[table]) db[table] = []
    return new MockQueryBuilder(table)
  },
  rpc(_name: string) {
    return Promise.resolve({ data: null, error: null })
  },
  channel(_name: string) {
    const channel = {
      on: (..._args: any[]) => channel,
      subscribe: (callback?: (status: string) => void) => {
        window.setTimeout(() => callback?.('SUBSCRIBED'), 0)
        return channel
      },
      unsubscribe: () => Promise.resolve('ok'),
    }
    return channel
  },
  removeChannel(_channel: unknown) {
    return Promise.resolve('ok')
  },
  storage: {
    from(_bucket: string) {
      return {
        upload: async (path: string, ..._args: any[]) => ({ data: { path }, error: null }),
        getPublicUrl: (path: string) => ({ data: { publicUrl: '' }, error: null }),
      }
    },
  },
}
