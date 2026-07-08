export interface PiekoszowLocality {
    name: string
    type: 'miasto' | 'wieś'
    gmina: string
    centerLat: number
    centerLng: number
}

interface LocalityFeature {
    type: 'Feature'
    properties: {
        name: string
        type: string
        gmina: string
    }
    geometry: {
        type: 'Point'
        coordinates: [number, number]
    }
}

interface LocalityCollection {
    type: 'FeatureCollection'
    features: LocalityFeature[]
}

let cachedLocalities: PiekoszowLocality[] | null = null

export async function fetchPiekoszowLocalities(): Promise<PiekoszowLocality[]> {
    if (cachedLocalities) return cachedLocalities

    const response = await fetch('/piekoszow_localities.json')
    if (!response.ok) {
        throw new Error(`Failed to load localities (${response.status})`)
    }

    const payload = await response.json() as LocalityCollection
    cachedLocalities = (payload.features || []).flatMap((feature) => {
        const properties = feature.properties || {}
        const name = `${properties.name || ''}`.trim()
        if (!name) return []

        const type = properties.type === 'miasto' ? 'miasto' : 'wieś'
        const gmina = `${properties.gmina || ''}`.trim()
        const coords = feature.geometry?.coordinates || []
        const centerLng = Number(coords[0])
        const centerLat = Number(coords[1])

        if (!Number.isFinite(centerLat) || !Number.isFinite(centerLng)) {
            return []
        }

        return [{
            name,
            type,
            gmina,
            centerLat,
            centerLng
        }] satisfies PiekoszowLocality[]
    })

    return cachedLocalities
}
