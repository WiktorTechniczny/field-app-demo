import L from 'leaflet'
import { getParcelNumberFromIdentifier } from './localityCatalog'
import {
    fetchParcelsByIds,
    fetchParcelRegions,
    fetchVisibleParcelsForMap,
    type ParcelRegionSummary,
    type PiekoszowParcel
} from './piekoszowParcels'
import { fetchPiekoszowLocalities } from './piekoszowLocalities'
import { resolveOfficialAddressForParcel, resolveOfficialAddressForParcelNumber } from './officialAddressPoints'
import { buildDisplayCivicAddress, getCivicAddressQuality, hasFullCivicAddress, normalizeCivicAddress } from './civicAddress'

type LayerRef<T extends L.Layer> = { current: T | null }
type ParcelLayerOptions = {
    localityCodes?: string[] | null
    precincts?: string[] | null
    getVisiblePoleAnchors?: () => Array<{ lat: number; lng: number; parcelId?: string | null; hasExactAddress?: boolean }>
    selectedParcelIds?: string[] | null
    addressFilter?: 'all' | 'exact' | 'missing'
}
type RegionLayerOptions = {
    localityCodes?: string[] | null
    precincts?: string[] | null
    activeRegionKey?: string | null
    activeRegionKeys?: string[] | null
    onSelectRegion?: (region: ParcelRegionSummary) => void
}
type ReloadableLayer = L.Layer & { __codexReloadKey?: string }

const PARCEL_NUMBER_MIN_ZOOM = 15
const PARCEL_GEOMETRY_MIN_ZOOM = 14
const PARCEL_LABEL_MAX_COUNT = 300
const PARCEL_RENDER_DEBOUNCE_MS = 260
const MAX_RENDERED_PARCELS = 350

type ParcelFeatureInfo = {
    parcelId?: string
    parcelNumber?: string
    addressResolved?: string
    localityLabel?: string
    voivodeship?: string
    county?: string
    municipality?: string
    precinct?: string
    areaHectares?: string
}

function escapeHtml(value: string) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
}

function sanitizeParcelAdminLabel(value?: string | null) {
    const text = `${value || ''}`.trim()
    if (!text) return ''
    if (/^\d+(?:[./-]\d+)*$/.test(text)) return ''
    if (/^obr\.?\s*\d+(?:[./-]\d+)*$/i.test(text)) return ''
    if (/^unknown::/i.test(text)) return ''
    return text
}

function buildParcelPopupContent(parcel: ParcelFeatureInfo) {
    const title = parcel.parcelNumber || getParcelNumberFromIdentifier(parcel.parcelId) || 'Nieznana dzia\u0142ka'
    const addressResolved = buildDisplayCivicAddress(
        normalizeCivicAddress(parcel.addressResolved),
        parcel.localityLabel,
        parcel.precinct,
        parcel.municipality
    )
    const addressQuality = getCivicAddressQuality(addressResolved)
    const locality = sanitizeParcelAdminLabel(parcel.localityLabel)
    const municipality = `${parcel.municipality || ''}`.trim()
    const precinct = sanitizeParcelAdminLabel(parcel.precinct)
    const showLocalityLine = locality.length > 0 && locality.localeCompare(municipality, 'pl', { sensitivity: 'base' }) !== 0
    const addressLabel = addressQuality === 'full' || addressQuality === 'partial'
        ? 'Adres'
        : ''

    return `
        <div class="parcel-card">
            <div class="parcel-card__title">Dzia\u0142ka ${escapeHtml(title)}</div>
            ${addressResolved && addressLabel ? `<div class="parcel-card__meta">${addressLabel}: <strong>${escapeHtml(addressResolved)}</strong></div>` : ''}
            ${showLocalityLine ? `<div class="parcel-card__meta">Miejscowo\u015b\u0107: <strong>${escapeHtml(locality)}</strong></div>` : ''}
            ${municipality ? `<div class="parcel-card__meta">Gmina: <strong>${escapeHtml(municipality)}</strong></div>` : ''}
            ${precinct ? `<div class="parcel-card__meta">Obr\u0119b: <strong>${escapeHtml(precinct)}</strong></div>` : ''}
            ${parcel.county ? `<div class="parcel-card__meta">Powiat: <strong>${escapeHtml(parcel.county)}</strong></div>` : ''}
            ${parcel.voivodeship ? `<div class="parcel-card__meta">Wojew\u00f3dztwo: <strong>${escapeHtml(parcel.voivodeship)}</strong></div>` : ''}
            ${parcel.areaHectares ? `<div class="parcel-card__meta">Powierzchnia: <strong>${escapeHtml(parcel.areaHectares)}</strong></div>` : ''}
        </div>
    `
}

function hasExactParcelAddress(parcel: Pick<ParcelFeatureInfo, 'addressResolved' | 'localityLabel' | 'precinct' | 'municipality'>) {
    return hasFullCivicAddress(buildDisplayCivicAddress(
        parcel.addressResolved,
        parcel.localityLabel,
        parcel.precinct,
        parcel.municipality
    ))
}

function extractHouseNumber(addressResolved?: string | null) {
    const normalized = normalizeCivicAddress(addressResolved)
    if (!normalized) return null

    const firstSegment = normalized.split(',')[0]?.trim() || normalized
    const match = firstSegment.match(/\d+[A-Za-z]?(?:\/\d+[A-Za-z]?)?/)
    return match ? match[0] : null
}

function buildParcelOverlayKey(map: L.Map) {
    const size = map.getSize()
    const bounds = map.getBounds()
    return [
        map.getZoom(),
        Math.round(size.x),
        Math.round(size.y),
        bounds.getSouth().toFixed(5),
        bounds.getWest().toFixed(5),
        bounds.getNorth().toFixed(5),
        bounds.getEast().toFixed(5)
    ].join('|')
}

function isPointWithinParcelBounds(parcel: Pick<PiekoszowParcel, 'south' | 'west' | 'north' | 'east'>, lat: number, lng: number) {
    return lat >= parcel.south && lat <= parcel.north && lng >= parcel.west && lng <= parcel.east
}

function isPointInsideParcel(parcel: PiekoszowParcel, lat: number, lng: number) {
    if (parcel.coords.length < 3) {
        return isPointWithinParcelBounds(parcel, lat, lng)
    }

    let inside = false
    for (let currentIndex = 0, previousIndex = parcel.coords.length - 1; currentIndex < parcel.coords.length; previousIndex = currentIndex++) {
        const [currentLng, currentLat] = parcel.coords[currentIndex]
        const [previousLng, previousLat] = parcel.coords[previousIndex]
        const intersects = ((currentLat > lat) !== (previousLat > lat)) &&
            (lng < ((previousLng - currentLng) * (lat - currentLat)) / ((previousLat - currentLat) || Number.EPSILON) + currentLng)

        if (intersects) inside = !inside
    }

    return inside
}

function filterParcelsForPoleAnchors(
    parcels: PiekoszowParcel[],
    anchors: Array<{ lat: number; lng: number; parcelId?: string | null; hasExactAddress?: boolean }>
) {
    if (anchors.length === 0) return []

    const normalizedParcelIds = new Set(
        anchors.map((anchor) => `${anchor.parcelId || ''}`.trim()).filter(Boolean)
    )

    return parcels.filter((parcel) => {
        if (normalizedParcelIds.has(parcel.id)) return true

        return anchors.some((anchor) =>
            isPointWithinParcelBounds(parcel, anchor.lat, anchor.lng) &&
            isPointInsideParcel(parcel, anchor.lat, anchor.lng)
        )
    })
}

function matchesPoleAnchorAddressFilter(
    anchor: { hasExactAddress?: boolean },
    addressFilter: ParcelLayerOptions['addressFilter']
) {
    if (addressFilter === 'exact') return Boolean(anchor.hasExactAddress)
    if (addressFilter === 'missing') return !anchor.hasExactAddress
    return true
}

function buildParcelStrokeWeight(zoom: number) {
    if (zoom >= 18) return 2
    if (zoom >= 16) return 1.6
    if (zoom >= 15) return 1.4
    return 1.8
}

function buildParcelFillOpacity(zoom: number) {
    if (zoom >= 18) return 0.05
    if (zoom >= 16) return 0.04
    if (zoom >= 15) return 0.05
    return 0.085
}

function buildParcelLabelIcon(label: string) {
    return L.divIcon({
        className: 'parcel-number-map-label',
        html: `<div style="transform: translate(-50%, -50%); white-space: nowrap; color: #1d4ed8; font-weight: 900; font-size: 11px; text-shadow: 0 0 2px rgba(255,255,255,0.96), 0 0 6px rgba(255,255,255,0.96); pointer-events: none;">${escapeHtml(label)}</div>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0]
    })
}



export function createParcelNumbersLayer(_options?: ParcelLayerOptions): L.Layer {
    const layerGroup = L.layerGroup()
    let activeMap: L.Map | null = null
    let parcelGeometryLayer: L.LayerGroup | null = null
    let parcelLabelLayer: L.LayerGroup | null = null
    let parcelCanvasRenderer: L.Renderer | null = null
    const highlightRef: { layer: L.LayerGroup | null; parcelId: string | null } = { layer: null, parcelId: null }
    let popupRequestId = 0
    let renderTimer: number | null = null
    let lastGeometryKey = ''
    let geometryRequestId = 0
    let visibleParcels: PiekoszowParcel[] = []

    const clearScheduledRender = () => {
        if (renderTimer === null) return
        window.clearTimeout(renderTimer)
        renderTimer = null
    }

    const renderParcelGeometries = async () => {
        if (!activeMap || !parcelGeometryLayer) return

        const map = activeMap
        const zoom = map.getZoom()

        if (zoom < PARCEL_GEOMETRY_MIN_ZOOM) {
            parcelGeometryLayer.clearLayers()
            parcelLabelLayer?.clearLayers()
            highlightRef.layer?.clearLayers()
            visibleParcels = []
            lastGeometryKey = ''
            return
        }

        const geometryLayer = parcelGeometryLayer
        const labelLayer = parcelLabelLayer
        const poleAnchors = (_options?.getVisiblePoleAnchors?.() || [])
            .filter((anchor) => Number.isFinite(anchor.lat) && Number.isFinite(anchor.lng))
        const addressMatchedPoleAnchors = poleAnchors.filter((anchor) => matchesPoleAnchorAddressFilter(anchor, _options?.addressFilter))
        const selectedParcelIds = Array.from(new Set((_options?.selectedParcelIds || []).map((value) => `${value || ''}`.trim()).filter(Boolean)))
        const poleAnchorKey = addressMatchedPoleAnchors
            .map((anchor) => `${anchor.parcelId || ''}|${anchor.lat.toFixed(6)}|${anchor.lng.toFixed(6)}|${anchor.hasExactAddress ? 'exact' : 'missing'}`)
            .sort()
            .join(',')
        const geometryKey = `${buildParcelOverlayKey(map)}|${[...(_options?.localityCodes || [])].sort().join(',')}|${[...(_options?.precincts || [])].sort().join(',')}|${poleAnchorKey}|${selectedParcelIds.sort().join(',')}`
        if (geometryKey === lastGeometryKey) return

        const requestId = ++geometryRequestId
        const normalizedParcelIds = Array.from(new Set(
            [...addressMatchedPoleAnchors.map((anchor) => `${anchor.parcelId || ''}`.trim()).filter(Boolean), ...selectedParcelIds]
        ))
        const [parcelsById, visibleCandidateParcels] = await Promise.all([
            normalizedParcelIds.length > 0
                ? fetchParcelsByIds(normalizedParcelIds).catch(() => [] as PiekoszowParcel[])
                : Promise.resolve([] as PiekoszowParcel[]),
            addressMatchedPoleAnchors.length > 0
                ? fetchVisibleParcelsForMap(map, {
                    localityCodes: _options?.localityCodes,
                    precincts: _options?.precincts
                }).catch(() => [] as PiekoszowParcel[])
                : Promise.resolve([] as PiekoszowParcel[])
        ])
        const anchorMatchedParcels = addressMatchedPoleAnchors.length > 0
            ? filterParcelsForPoleAnchors(visibleCandidateParcels, addressMatchedPoleAnchors)
            : []
        const parcels = Array.from(new Map(
            [...parcelsById, ...anchorMatchedParcels].map((parcel) => [parcel.id, parcel] as const)
        ).values())
        const selectedAddressFilteredParcels = parcels.filter((parcel) => {
            if (_options?.addressFilter === 'exact') return hasExactParcelAddress(parcel)
            if (_options?.addressFilter === 'missing') return !hasExactParcelAddress(parcel)
            return true
        })

        if (
            !activeMap ||
            activeMap !== map ||
            !labelLayer ||
            requestId !== geometryRequestId
        ) {
            return
        }

        visibleParcels = selectedParcelIds.length > 0
            ? selectedAddressFilteredParcels.filter((parcel) => selectedParcelIds.includes(parcel.id))
            : addressMatchedPoleAnchors.length > 0
                ? parcels
                : selectedAddressFilteredParcels.length > MAX_RENDERED_PARCELS
                    ? selectedAddressFilteredParcels.slice(0, MAX_RENDERED_PARCELS)
                    : selectedAddressFilteredParcels

        const selectedParcels = visibleParcels.filter((parcel) => selectedParcelIds.includes(parcel.id))

        geometryLayer.clearLayers()
        labelLayer.clearLayers()
        highlightRef.layer?.clearLayers()
        const showLabels = zoom >= PARCEL_NUMBER_MIN_ZOOM && visibleParcels.length <= PARCEL_LABEL_MAX_COUNT

        visibleParcels.forEach((parcel) => {
            if (parcel.coords.length >= 3) {
                L.polygon(
                    parcel.coords.map(([lng, lat]) => [lat, lng] as [number, number]),
                    {
                        color: '#2563eb',
                        weight: buildParcelStrokeWeight(zoom),
                        opacity: 0.82,
                        fillColor: '#3b82f6',
                        fillOpacity: buildParcelFillOpacity(zoom),
                        renderer: parcelCanvasRenderer || undefined,
                        interactive: false,
                        bubblingMouseEvents: false
                    }
                ).addTo(geometryLayer)
            }

            if (showLabels) {
                L.marker([parcel.centerLat, parcel.centerLng], {
                    icon: buildParcelLabelIcon(parcel.parcelNumber || getParcelNumberFromIdentifier(parcel.id) || parcel.id),
                    interactive: false,
                    keyboard: false,
                    zIndexOffset: 500
                }).addTo(labelLayer)
            }
        })

        selectedParcels.forEach((parcel) => {
            if (parcel.coords.length >= 3 && highlightRef.layer) {
                L.polygon(
                    parcel.coords.map(([lng, lat]) => [lat, lng] as [number, number]),
                    {
                        color: '#f59e0b',
                        weight: 3,
                        opacity: 1,
                        fillColor: '#fbbf24',
                        fillOpacity: 0.22,
                        renderer: parcelCanvasRenderer || undefined,
                        interactive: false,
                        bubblingMouseEvents: false
                    }
                ).addTo(highlightRef.layer)
            }
        })

        lastGeometryKey = geometryKey
    }

    const handleMapChange = () => {
        clearScheduledRender()
        renderTimer = window.setTimeout(() => {
            renderTimer = null
            void renderParcelGeometries()
        }, PARCEL_RENDER_DEBOUNCE_MS)
    }

    const handleMapInteractionStart = () => {
        clearScheduledRender()
        geometryRequestId += 1
        parcelLabelLayer?.clearLayers()
        highlightRef.layer?.clearLayers()
    }

    const clearHighlight = () => {
        highlightRef.layer?.clearLayers()
        highlightRef.parcelId = null
    }

    const highlightParcel = (parcel: PiekoszowParcel) => {
        highlightRef.layer?.clearLayers()
        highlightRef.parcelId = parcel.id
        if (parcel.coords.length >= 3 && highlightRef.layer) {
            L.polygon(
                parcel.coords.map(([lng, lat]) => [lat, lng] as [number, number]),
                {
                    color: '#f59e0b',
                    weight: 3,
                    opacity: 1,
                    fillColor: '#fbbf24',
                    fillOpacity: 0.28,
                    renderer: parcelCanvasRenderer || undefined,
                    interactive: false,
                    bubblingMouseEvents: false
                }
            ).addTo(highlightRef.layer)
        }
    }

    const handleMapClick = async (event: L.LeafletMouseEvent) => {
        if (!activeMap) return

        const map = activeMap
        if (map.getZoom() < PARCEL_GEOMETRY_MIN_ZOOM) return
        const currentPopupRequestId = ++popupRequestId

        try {
            const matchingVisibleParcel = visibleParcels.find((parcel) =>
                isPointWithinParcelBounds(parcel, event.latlng.lat, event.latlng.lng) &&
                isPointInsideParcel(parcel, event.latlng.lat, event.latlng.lng)
            )
            const parcel = matchingVisibleParcel || null
            if (!parcel || !activeMap || activeMap !== map || currentPopupRequestId !== popupRequestId) return

            highlightParcel(parcel)

            let resolvedAddress: string | undefined = parcel.addressResolved
            if (!hasFullCivicAddress(parcel.addressResolved)) {
                resolvedAddress = await resolveOfficialAddressForParcel(
                    parcel,
                    parcel.localityLabel || parcel.precinct || null
                ).catch(() => null) || undefined

                if (!hasFullCivicAddress(resolvedAddress)) {
                    const houseNumber = extractHouseNumber(parcel.addressResolved)
                    if (houseNumber) {
                        resolvedAddress = await resolveOfficialAddressForParcelNumber(
                            parcel,
                            houseNumber,
                            parcel.localityLabel || parcel.precinct || null
                        ).catch(() => resolvedAddress || null) || resolvedAddress
                    }
                }
            }

            const popup = L.popup({
                maxWidth: 280,
                className: 'parcel-leaflet-popup'
            })
                .setLatLng(event.latlng)
                .setContent(buildParcelPopupContent({
                    parcelId: parcel.id,
                    parcelNumber: parcel.parcelNumber,
                    addressResolved: resolvedAddress || parcel.addressResolved,
                    localityLabel: parcel.localityLabel,
                    municipality: parcel.municipality,
                    precinct: parcel.precinct,
                    county: parcel.county,
                    voivodeship: parcel.voivodeship
                }))

            popup.on('remove', () => {
                if (highlightRef.parcelId === parcel.id) clearHighlight()
            })

            popup.openOn(map)
        } catch (error) {
            console.error('Failed to load parcel details:', error)
        }
    }

    layerGroup.on('add', () => {
        const map = (layerGroup as unknown as { _map?: L.Map })._map || null
        if (!map) return

        activeMap = map
        parcelCanvasRenderer = L.canvas({ padding: 0.15 })
        parcelGeometryLayer = L.layerGroup().addTo(layerGroup)
        parcelLabelLayer = L.layerGroup().addTo(layerGroup)
        highlightRef.layer = L.layerGroup().addTo(layerGroup)
        map.on('click', handleMapClick)
        map.on('movestart', handleMapInteractionStart)
        map.on('zoomstart', handleMapInteractionStart)
        map.on('moveend', handleMapChange)
        map.on('zoomend', handleMapChange)
        map.on('resize', handleMapChange)
        void renderParcelGeometries()
    })

    layerGroup.on('remove', () => {
        popupRequestId += 1
        geometryRequestId += 1
        clearScheduledRender()

        if (parcelGeometryLayer) {
            layerGroup.removeLayer(parcelGeometryLayer)
            parcelGeometryLayer = null
        }

        if (parcelLabelLayer) {
            layerGroup.removeLayer(parcelLabelLayer)
            parcelLabelLayer = null
        }

        if (highlightRef.layer) {
            layerGroup.removeLayer(highlightRef.layer)
            highlightRef.layer = null
            highlightRef.parcelId = null
        }

        parcelCanvasRenderer = null

        if (activeMap) {
            activeMap.off('click', handleMapClick)
            activeMap.off('movestart', handleMapInteractionStart)
            activeMap.off('zoomstart', handleMapInteractionStart)
            activeMap.off('moveend', handleMapChange)
            activeMap.off('zoomend', handleMapChange)
            activeMap.off('resize', handleMapChange)
        }
        activeMap = null
        lastGeometryKey = ''
        visibleParcels = []
    })

    return layerGroup
}

export function createOpenInfraPowerLayer(): L.Layer {
    return L.layerGroup()
}

export function createParcelRegionsLayer(options?: RegionLayerOptions): L.Layer {
    const layerGroup = L.layerGroup()
    let activeMap: L.Map | null = null
    let regionsLayer: L.LayerGroup | null = null
    let renderTimer: number | null = null
    let renderRequestId = 0
    let lastRenderKey = ''

    const clearScheduledRender = () => {
        if (renderTimer === null) return
        window.clearTimeout(renderTimer)
        renderTimer = null
    }

    const renderRegions = async () => {
        if (!activeMap || !regionsLayer) return

        const map = activeMap
        const polygonLayer = regionsLayer
        const localityKey = [...(options?.localityCodes || [])].sort().join(',')
        const precinctKey = [...(options?.precincts || [])].sort().join(',')
        const activeKeys = [...(options?.activeRegionKeys || [])].sort().join(',')
        const renderKey = `${buildParcelOverlayKey(map)}|regions|${localityKey}|${precinctKey}|${activeKeys}|${options?.activeRegionKey || ''}`
        if (renderKey === lastRenderKey) return

        const requestId = ++renderRequestId
        const mapBounds = map.getBounds()
        const localityCodes = new Set(options?.localityCodes || [])
        const precincts = new Set((options?.precincts || []).map((item) => item.toLocaleLowerCase('pl-PL')))
        const regions = await fetchParcelRegions().then((items) => items.filter((region) => {
            if (localityCodes.size > 0 && !region.localityCodes.some((code) => localityCodes.has(code))) {
                return false
            }

            if (precincts.size > 0 && !region.precincts.some((precinct) => precincts.has(precinct.toLocaleLowerCase('pl-PL')))) {
                return false
            }

            return !(
                region.north < mapBounds.getSouth() ||
                region.south > mapBounds.getNorth() ||
                region.east < mapBounds.getWest() ||
                region.west > mapBounds.getEast()
            )
        })).catch(() => [])

        if (!activeMap || activeMap !== map || !regionsLayer || requestId !== renderRequestId) return

        polygonLayer.clearLayers()

        regions.forEach((region) => {
            const activeRegionKeys = new Set(options?.activeRegionKeys || [])
            const isActive = activeRegionKeys.size > 0
                ? activeRegionKeys.has(region.key)
                : region.key === options?.activeRegionKey
            const isMunicipalSeat = region.regionType === 'municipal-seat'
            const strokeColor = isActive
                ? '#b45309'
                : isMunicipalSeat
                    ? '#7c3aed'
                    : '#0f766e'
            const fillColor = isActive
                ? '#f59e0b'
                : isMunicipalSeat
                    ? '#8b5cf6'
                    : '#14b8a6'
            const polygonLatLngs = region.coords.map((ring) =>
                ring.map(([lng, lat]) => [lat, lng] as [number, number])
            )
            const polygon = L.polygon(
                polygonLatLngs,
                {
                    color: strokeColor,
                    weight: isActive ? 3 : 2,
                    opacity: isActive ? 0.95 : 0.75,
                    fillColor,
                    fillOpacity: isActive ? 0.12 : 0.06,
                    bubblingMouseEvents: false,
                    interactive: false
                }
            )
            polygon.addTo(polygonLayer)
        })

        lastRenderKey = renderKey
    }

    const handleMapChange = () => {
        clearScheduledRender()
        renderTimer = window.setTimeout(() => {
            renderTimer = null
            void renderRegions()
        }, 120)
    }

    layerGroup.on('add', () => {
        const map = (layerGroup as unknown as { _map?: L.Map })._map || null
        if (!map) return

        activeMap = map
        regionsLayer = L.layerGroup().addTo(layerGroup)
        map.on('moveend', handleMapChange)
        map.on('resize', handleMapChange)
        void renderRegions()
    })

    layerGroup.on('remove', () => {
        renderRequestId += 1
        clearScheduledRender()

        if (regionsLayer) {
            layerGroup.removeLayer(regionsLayer)
            regionsLayer = null
        }

        if (activeMap) {
            activeMap.off('moveend', handleMapChange)
            activeMap.off('resize', handleMapChange)
        }

        activeMap = null
        lastRenderKey = ''
    })

    return layerGroup
}

export function createLocalitiesLayer(): L.Layer {
    const layerGroup = L.layerGroup()
    let activeMap: L.Map | null = null
    let markersLayer: L.LayerGroup | null = null

    const renderLocalities = async () => {
        if (!activeMap || !markersLayer) return

        const localities = await fetchPiekoszowLocalities().catch(() => [])
        markersLayer.clearLayers()

        localities.forEach((locality) => {
            const isTown = locality.type === 'miasto'
            const iconColor = isTown ? '#7c3aed' : '#0f766e'
            const iconSize = isTown ? 10 : 7

            const marker = L.circleMarker([locality.centerLat, locality.centerLng], {
                radius: iconSize,
                fillColor: iconColor,
                color: '#ffffff',
                weight: 2,
                opacity: 0.9,
                fillOpacity: 0.7
            })

            marker.bindTooltip(locality.name, {
                permanent: false,
                direction: 'top',
                className: 'power-line-tooltip'
            })

            if (markersLayer) marker.addTo(markersLayer)
        })
    }

    layerGroup.on('add', () => {
        const map = (layerGroup as unknown as { _map?: L.Map })._map || null
        if (!map) return

        activeMap = map
        markersLayer = L.layerGroup().addTo(layerGroup)
        void renderLocalities()
    })

    layerGroup.on('remove', () => {
        if (markersLayer) {
            layerGroup.removeLayer(markersLayer)
            markersLayer = null
        }

        activeMap = null
    })

    return layerGroup
}

export function syncOverlayLayer<T extends L.Layer>(params: {
    map: L.Map | null
    layerRef: LayerRef<T>
    enabled: boolean
    createLayer: () => T
    reloadKey?: string
}) {
    const { map, layerRef, enabled, createLayer, reloadKey = '' } = params
    const currentLayer = layerRef.current

    if (!enabled) {
        currentLayer?.remove()
        return
    }

    if (!map) return

    const attachedMap = currentLayer ? (currentLayer as T & { _map?: L.Map })._map : null
    const currentReloadKey = currentLayer ? (currentLayer as unknown as ReloadableLayer).__codexReloadKey || '' : ''
    if (currentLayer && attachedMap === map && currentReloadKey === reloadKey) {
        if (!map.hasLayer(currentLayer)) currentLayer.addTo(map)
        return
    }

    currentLayer?.remove()
    const nextLayer = createLayer()
    ;(nextLayer as unknown as ReloadableLayer).__codexReloadKey = reloadKey
    layerRef.current = nextLayer
    nextLayer.addTo(map)
}
