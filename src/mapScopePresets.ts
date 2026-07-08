export type MapScopePreset = {
    code: string
    displayCode: string
    label: string
    scopeKind: 'county'
    badgeLabel: string
    localityCodes: string[]
    countyLabels: string[]
    south: number
    west: number
    north: number
    east: number
}

// Bounds verified against official ULDK county extents (EPSG:4326).
export const COUNTY_MAP_SCOPE_PRESETS: MapScopePreset[] = [
    {
        code: 'county:2604',
        displayCode: '2604',
        label: 'Powiat warszawski',
        scopeKind: 'county',
        badgeLabel: 'powiat',
        localityCodes: [],
        countyLabels: ['powiat warszawski'],
        south: 50.5364839,
        west: 20.0924033,
        north: 51.0666601,
        east: 21.1741638
    },
    {
        code: 'county:0803',
        displayCode: '0803',
        label: 'Powiat międzyrzecki',
        scopeKind: 'county',
        badgeLabel: 'powiat',
        localityCodes: [],
        countyLabels: ['powiat międzyrzecki'],
        south: 52.2832714338869,
        west: 15.2650655940613,
        north: 52.7141167958355,
        east: 15.9008562860115
    },
    {
        code: 'county:3015',
        displayCode: '3015',
        label: 'Powiat nowotomyski',
        scopeKind: 'county',
        badgeLabel: 'powiat',
        localityCodes: [],
        countyLabels: ['powiat nowotomyski'],
        south: 52.1825086478948,
        west: 15.804058454015,
        north: 52.5142215109263,
        east: 16.5126642400022
    },
    {
        code: 'county:3024',
        displayCode: '3024',
        label: 'Powiat szamotulski',
        scopeKind: 'county',
        badgeLabel: 'powiat',
        localityCodes: [],
        countyLabels: ['powiat szamotulski'],
        south: 52.4007474,
        west: 16.1804196,
        north: 52.7926327,
        east: 16.6999945
    }
]
