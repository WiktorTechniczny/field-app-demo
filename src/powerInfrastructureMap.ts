import L from 'leaflet'
import { fetchPowerData, getPowerPoleDisplayAddress, getPowerPoleSuggestedLocation, hasPowerPoleParcelAssignment, hasPowerPoleExactAddress, resolvePowerPoleDetails, resolvePowerPoleParcels, type PowerLine, type PowerPole, voltageConfig } from './powerPoles'
import { resolvePowerPolesWithLocalParcels } from './localPoleParcelResolution'
import type { BoundaryPolygon } from './mapScopeBoundaries'
import { buildDisplayCivicAddress, getCivicAddressQuality, normalizeCivicAddress } from './civicAddress'

type RenderPowerInfrastructureParams = {
    map: L.Map | null
    polesLayer: L.LayerGroup | null
    linesLayer: L.LayerGroup | null
    enabled: boolean
    linesEnabled?: boolean
    polesEnabled?: boolean
    maxArea?: number
    allowedVoltages?: PowerPole['voltage'][]
    localityCodes?: string[] | null
    countyLabels?: string[] | null
    precinctLabels?: string[] | null
    selectedParcelIds?: string[] | null
    boundaryPolygons?: BoundaryPolygon[] | null
    scopeBounds?: { south: number; west: number; north: number; east: number } | null
    excludePoleTypes?: PowerPole['type'][]
    minLineZoom?: number
    minPoleZoom?: number
    bulkResolvePoleParcelsMinZoom?: number
    assignedPolesOnly?: boolean
    addressFilter?: 'all' | 'exact' | 'missing'
    buildPolePopupContent?: (pole: PowerPole) => string
    onPoleCountChange?: (count: number) => void
    onVisiblePolesChange?: (poles: PowerPole[]) => void
}

const activeRenderRequestByMap = new WeakMap<L.Map, number>()
type NormalizedBounds = { south: number; west: number; north: number; east: number }
type PowerInfrastructureRenderCache = {
    zoom: number
    signature: string
    renderedBounds: NormalizedBounds
    poleCount: number
}
const renderCacheByMap = new WeakMap<L.Map, PowerInfrastructureRenderCache>()
type CachedPowerMarker = L.Marker & { __codexRenderKey?: string }
type CachedPowerLine = L.Polyline & { __codexRenderKey?: string }
type PowerInfrastructureLayerState = {
    poleMarkers: Map<number, CachedPowerMarker>
    lineLayers: Map<number, CachedPowerLine>
}
const layerStateByMap = new WeakMap<L.Map, PowerInfrastructureLayerState>()

function getLayerState(map: L.Map): PowerInfrastructureLayerState {
    const existing = layerStateByMap.get(map)
    if (existing) return existing

    const nextState: PowerInfrastructureLayerState = {
        poleMarkers: new Map(),
        lineLayers: new Map()
    }
    layerStateByMap.set(map, nextState)
    return nextState
}

function clearRenderedInfrastructure(map: L.Map, polesLayer: L.LayerGroup, linesLayer: L.LayerGroup) {
    const state = layerStateByMap.get(map)
    state?.poleMarkers.forEach((marker) => polesLayer.removeLayer(marker))
    state?.lineLayers.forEach((line) => linesLayer.removeLayer(line))
    state?.poleMarkers.clear()
    state?.lineLayers.clear()
    polesLayer.clearLayers()
    linesLayer.clearLayers()
}

function normalizeBounds(bounds: L.LatLngBounds): NormalizedBounds {
    return {
        south: bounds.getSouth(),
        west: bounds.getWest(),
        north: bounds.getNorth(),
        east: bounds.getEast()
    }
}

function normalizeScopeBounds(bounds: { south: number; west: number; north: number; east: number }): NormalizedBounds {
    return {
        south: bounds.south,
        west: bounds.west,
        north: bounds.north,
        east: bounds.east
    }
}

function intersectBounds(a: NormalizedBounds, b: NormalizedBounds): NormalizedBounds | null {
    const south = Math.max(a.south, b.south)
    const west = Math.max(a.west, b.west)
    const north = Math.min(a.north, b.north)
    const east = Math.min(a.east, b.east)
    if (south >= north || west >= east) return null
    return { south, west, north, east }
}

function isBoundsInside(inner: NormalizedBounds, outer: NormalizedBounds) {
    return (
        inner.south >= outer.south &&
        inner.north <= outer.north &&
        inner.west >= outer.west &&
        inner.east <= outer.east
    )
}

function expandBounds(bounds: NormalizedBounds, paddingFactor: number): NormalizedBounds {
    const latSpan = Math.max(0.0025, bounds.north - bounds.south)
    const lngSpan = Math.max(0.0025, bounds.east - bounds.west)
    const latPad = latSpan * paddingFactor
    const lngPad = lngSpan * paddingFactor

    return {
        south: bounds.south - latPad,
        west: bounds.west - lngPad,
        north: bounds.north + latPad,
        east: bounds.east + lngPad
    }
}

function escapeHtml(value: string) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

export function getPowerVoltageLabel(voltage: PowerPole['voltage'], voltageRaw?: string) {
    const normalizedRaw = `${voltageRaw || ''}`.trim()
    if (normalizedRaw.toLowerCase().endsWith('kv')) return normalizedRaw

    const config = voltageConfig[voltage] || voltageConfig.unknown
    return config.label
}

export function getPowerVoltageBadge(voltage: PowerPole['voltage'], voltageRaw?: string) {
    const label = getPowerVoltageLabel(voltage, voltageRaw)
    const match = label.match(/(\d+(?:\.\d+)?)/)
    return match ? match[1] : ''
}

export function getPowerPoleTypeLabel(type: PowerPole['type']) {
    if (type === 'tower') return 'Wie\u017ca'
    if (type === 'station') return 'Stacja'
    return 'S\u0142up'
}

export function buildPowerPoleDetailsHtml(pole: PowerPole) {
    const config = voltageConfig[pole.voltage] || voltageConfig.unknown
    const voltageLabel = escapeHtml(getPowerVoltageLabel(pole.voltage, pole.voltageRaw))
    const typeLabel = escapeHtml(getPowerPoleTypeLabel(pole.type))
    const exactAddress = getPowerPoleDisplayAddress(pole)
    const normalizedAddress = buildDisplayCivicAddress(
        normalizeCivicAddress(pole.address),
        pole.localityLabel,
        pole.precinct,
        pole.municipality
    )
    const addressQuality = getCivicAddressQuality(normalizedAddress)
    const suggestedLocation = getPowerPoleSuggestedLocation(pole)
    const normalizedLocality = `${pole.localityLabel || ''}`.trim().toLowerCase()
    const normalizedPrecinct = `${pole.precinct || ''}`.trim().toLowerCase()
    const showPrecinctLine = normalizedPrecinct && normalizedPrecinct !== normalizedLocality
    const precinctLabel = `${pole.precinct || ''}`
    const parcelLine = pole.parcelNumber
        ? `<div class="power-pole-card__meta">Dzia\u0142ka: <strong>${escapeHtml(pole.parcelNumber)}</strong></div>`
        : ''
    const parcelIdLine = pole.parcelId
        ? `<div class="power-pole-card__meta">ID dzia\u0142ki: ${escapeHtml(pole.parcelId)}</div>`
        : ''
    const addressLabel = pole.addressSource === 'assignment' ? 'Dokładny adres' : 'Adres'
    const addressLine = exactAddress
        ? `<div class="power-pole-card__meta">${addressLabel}: ${escapeHtml(exactAddress)}</div>`
        : ''
    const partialAddressLabel = 'Adres'
    const partialAddressLine = !exactAddress && addressQuality === 'partial'
        ? `<div class="power-pole-card__meta">${partialAddressLabel}: ${escapeHtml(normalizedAddress)}</div>`
        : ''
    const addressStatusLine = !exactAddress && !partialAddressLine && pole.address && !hasPowerPoleExactAddress(pole)
        ? '<div class="power-pole-card__meta">Status adresu: brak dokładnego adresu do działki</div>'
        : ''
    const suggestedLocationLine = !exactAddress && !partialAddressLine && suggestedLocation
        ? `<div class="power-pole-card__meta">Sugerowana lokalizacja: ${escapeHtml(suggestedLocation)}</div>`
        : ''
    const localityLine = pole.localityLabel
        ? `<div class="power-pole-card__meta">Miejscowość: ${escapeHtml(pole.localityLabel)}</div>`
        : ''
    const municipalityLine = pole.municipality
        ? `<div class="power-pole-card__meta">Gmina: ${escapeHtml(pole.municipality)}</div>`
        : ''
    const sourceLabel = pole.parcelSource === 'uldk_api' ? 'Pobrane z API ULDK' : 
                        pole.parcelSource === 'local_audit' ? 'Zidentyfikowane w audycie' : 
                        pole.parcelSource === 'live' ? 'Baza dynamiczna' : '';
    const sourceLine = sourceLabel
        ? `<div class="power-pole-card__source" style="font-size: 9px; margin-top: 4px; color: #94a3b8; font-style: italic;">Źródło: ${escapeHtml(sourceLabel)}</div>`
        : ''
    const precinctLine = showPrecinctLine
        ? `<div class="power-pole-card__meta">Obręb: ${escapeHtml(precinctLabel)}</div>`
        : ''

    return `
        <div class="power-pole-card">
            <div class="power-pole-card__header">
                <span class="power-pole-card__swatch" style="background:${config.color}; border-color:${config.border};"></span>
                <div>
                    <div class="power-pole-card__title">${typeLabel} ${voltageLabel}</div>
                    ${parcelLine}
                    ${parcelIdLine}
                    ${addressLine}
                    ${partialAddressLine}
                    ${addressStatusLine}
                    ${suggestedLocationLine}
                    ${localityLine}
                    ${municipalityLine}
                    ${precinctLine}
                    ${sourceLine}
                </div>
            </div>
        </div>
    `
}

export function createPowerPoleIcon(pole: PowerPole) {
    const badge = escapeHtml(getPowerVoltageBadge(pole.voltage, pole.voltageRaw))
    const glyph = pole.type === 'tower' ? 'T' : 'S'
    const voltageClass = `power-pole-marker--${pole.voltage}`
    const typeClass = pole.type === 'tower' ? 'power-pole-marker--tower' : 'power-pole-marker--pole'

    return L.divIcon({
        className: 'power-pole-marker-icon',
        html: `
            <div class="power-pole-marker ${voltageClass} ${typeClass}">
                <span class="power-pole-marker__glyph">${glyph}</span>
                ${badge ? `<span class="power-pole-marker__badge">${badge}</span>` : ''}
            </div>
        `,
        iconSize: pole.type === 'tower' ? [38, 38] : [34, 34],
        iconAnchor: pole.type === 'tower' ? [19, 19] : [17, 17],
        popupAnchor: [0, -18]
    })
}

const AUTO_RESOLVE_POLE_PARCELS_MIN_ZOOM = 13
const canvasRendererByMap = new WeakMap<L.Map, L.Renderer>()

function getPolePriority(pole: PowerPole) {
    const voltageRank = pole.voltage === 'wn' ? 3 : pole.voltage === 'sn' ? 2 : pole.voltage === 'nn' ? 1 : 0
    const typeRank = pole.type === 'tower' ? 2 : pole.type === 'station' ? 1 : 0
    return voltageRank * 10 + typeRank
}



function getMaxVisiblePolesForZoom(zoom: number) {
    if (zoom >= 16) return 4000
    if (zoom >= 15) return 3500
    if (zoom >= 14) return 3000
    if (zoom >= 13) return 2400
    if (zoom >= 12) return 2200
    if (zoom >= 11) return 1800
    if (zoom >= 10) return 1400
    return 900
}

function shouldUseLightweightPoleMarkers(zoom: number) {
    return zoom <= 10
}

function getPoleGridConfigForZoom(zoom: number) {
    if (zoom >= 13) return null
    if (zoom >= 12) return { cellSize: 0.008, perCell: 4 }
    if (zoom >= 11) return { cellSize: 0.012, perCell: 3 }
    if (zoom >= 10) return { cellSize: 0.018, perCell: 2 }
    return { cellSize: 0.026, perCell: 1 }
}

function capPolesWithSpatialBalance(poles: PowerPole[], maxVisiblePoles: number, zoom: number) {
    if (poles.length <= maxVisiblePoles) return poles

    const gridConfig = getPoleGridConfigForZoom(zoom)
    if (!gridConfig) {
        return poles
            .slice()
            .sort((left, right) => getPolePriority(right) - getPolePriority(left))
            .slice(0, maxVisiblePoles)
    }

    const byCell = new Map<string, PowerPole[]>()
    poles.forEach((pole) => {
        const latKey = Math.floor(pole.lat / gridConfig.cellSize)
        const lngKey = Math.floor(pole.lng / gridConfig.cellSize)
        const cellKey = `${latKey}:${lngKey}`
        const bucket = byCell.get(cellKey)
        if (bucket) {
            bucket.push(pole)
            return
        }
        byCell.set(cellKey, [pole])
    })

    const cellCandidates = Array.from(byCell.values())
        .map((bucket) =>
            bucket
                .slice()
                .sort((left, right) => getPolePriority(right) - getPolePriority(left))
                .slice(0, gridConfig.perCell)
        )
        .filter((bucket) => bucket.length > 0)
        .sort((left, right) => getPolePriority(right[0]) - getPolePriority(left[0]))

    const result: PowerPole[] = []
    const seenIds = new Set<number>()
    let addedInRound = true

    while (result.length < maxVisiblePoles && addedInRound) {
        addedInRound = false

        for (const bucket of cellCandidates) {
            const nextPole = bucket.shift()
            if (!nextPole || seenIds.has(nextPole.id)) continue
            seenIds.add(nextPole.id)
            result.push(nextPole)
            addedInRound = true
            if (result.length >= maxVisiblePoles) break
        }
    }

    return result
}

function downsamplePolesForZoom(poles: PowerPole[], zoom: number) {
    const gridConfig = getPoleGridConfigForZoom(zoom)
    if (!gridConfig) return poles

    const byCell = new Map<string, PowerPole[]>()
    poles.forEach((pole) => {
        const latKey = Math.floor(pole.lat / gridConfig.cellSize)
        const lngKey = Math.floor(pole.lng / gridConfig.cellSize)
        const cellKey = `${latKey}:${lngKey}`
        const bucket = byCell.get(cellKey)
        if (bucket) {
            bucket.push(pole)
            return
        }
        byCell.set(cellKey, [pole])
    })

    return Array.from(byCell.values()).flatMap((bucket) =>
        bucket
            .slice()
            .sort((left, right) => getPolePriority(right) - getPolePriority(left))
            .slice(0, gridConfig.perCell)
    )
}

function getCanvasRenderer(map: L.Map) {
    const cached = canvasRendererByMap.get(map)
    if (cached) return cached
    const renderer = L.canvas({ padding: 0.2 })
    canvasRendererByMap.set(map, renderer)
    return renderer
}

function getLineStyle(line: PowerLine): L.PolylineOptions {
    const config = voltageConfig[line.voltage] || voltageConfig.unknown
    return {
        color: config.color,
        weight: line.voltage === 'wn' ? 4 : line.voltage === 'sn' ? 3 : 2,
        opacity: 0.92,
        lineCap: 'round',
        lineJoin: 'round',
        dashArray: line.voltage === 'unknown' ? '7 8' : undefined
    }
}

function buildLineRenderKey(line: PowerLine) {
    return [
        line.type,
        line.voltage,
        line.voltageRaw || '',
        line.coords.length,
        ...line.coords.flatMap(([lng, lat]) => [`${lat.toFixed(5)}`, `${lng.toFixed(5)}`])
    ].join('|')
}

function buildPoleRenderKey(pole: PowerPole) {
    return [
        pole.type,
        pole.voltage,
        pole.voltageRaw || '',
        pole.lat.toFixed(6),
        pole.lng.toFixed(6),
        pole.parcelId || '',
        pole.parcelNumber || '',
        pole.localityLabel || '',
        pole.municipality || '',
        pole.precinct || ''
    ].join('|')
}

function createRenderedLine(line: PowerLine, canvasRenderer: L.Renderer) {
    const polyline = L.polyline(
        line.coords.map(([lng, lat]) => [lat, lng] as [number, number]),
        {
            ...getLineStyle(line),
            renderer: canvasRenderer
        }
    ) as CachedPowerLine

    polyline.__codexRenderKey = buildLineRenderKey(line)
    polyline.bindTooltip(getPowerVoltageLabel(line.voltage, line.voltageRaw), {
        sticky: true,
        className: 'power-line-tooltip'
    })
    return polyline
}

function createLightweightPoleMarker(pole: PowerPole, canvasRenderer: L.Renderer, buildPolePopupContent?: (pole: PowerPole) => string) {
    const config = voltageConfig[pole.voltage] || voltageConfig.unknown
    const marker = L.circleMarker([pole.lat, pole.lng], {
        renderer: canvasRenderer,
        radius: pole.type === 'tower' ? 7 : 5,
        fillColor: config.color,
        fillOpacity: 0.9,
        color: config.border || '#fff',
        weight: 2,
        opacity: 1
    }) as unknown as CachedPowerMarker

    marker.__codexRenderKey = buildPoleRenderKey(pole) + '|light'
    marker.bindTooltip(`${getPowerPoleTypeLabel(pole.type)} ${getPowerVoltageLabel(pole.voltage, pole.voltageRaw)}`, {
        direction: 'top',
        offset: [0, -8],
        className: 'power-pole-tooltip'
    })

    if (buildPolePopupContent) {
        marker.bindPopup(buildPolePopupContent(pole), {
            maxWidth: 260,
            className: 'power-pole-leaflet-popup'
        })
        marker.on('popupopen', () => {
            void resolvePowerPoleDetails(pole).then((resolved) => {
                const popup = (marker as unknown as L.CircleMarker).getPopup()
                if (!popup || !(marker as unknown as L.CircleMarker).isPopupOpen()) return
                popup.setContent(buildPolePopupContent(resolved))
            })
        })
    }

    return marker
}

function createRenderedPoleMarker(pole: PowerPole, buildPolePopupContent?: (pole: PowerPole) => string) {
    const marker = L.marker([pole.lat, pole.lng], {
        icon: createPowerPoleIcon(pole),
        zIndexOffset: 1200,
        keyboard: false
    }) as CachedPowerMarker

    marker.__codexRenderKey = buildPoleRenderKey(pole)

    if (buildPolePopupContent) {
        marker.bindPopup(buildPolePopupContent(pole), {
            maxWidth: 260,
            className: 'power-pole-leaflet-popup'
        })
        marker.on('popupopen', () => {
            const popup = marker.getPopup()
            if (popup && marker.isPopupOpen() && hasPowerPoleParcelAssignment(pole) && !hasPowerPoleExactAddress(pole)) {
                popup.setContent(buildPolePopupContent({ ...pole, address: '' }))
            }

            void resolvePowerPoleDetails(pole).then((resolved) => {
                const popup = marker.getPopup()
                if (!popup || !marker.isPopupOpen()) return
                popup.setContent(buildPolePopupContent(resolved))
            })
        })
    }

    return marker
}

function syncRenderedLines(params: {
    map: L.Map
    linesLayer: L.LayerGroup
    lines: PowerLine[]
    canvasRenderer: L.Renderer
}) {
    const { map, linesLayer, lines, canvasRenderer } = params
    const state = getLayerState(map)
    const desiredIds = new Set<number>()

    lines.forEach((line) => {
        desiredIds.add(line.id)
        const nextKey = buildLineRenderKey(line)
        const existing = state.lineLayers.get(line.id)

        if (existing && existing.__codexRenderKey === nextKey) {
            if (!linesLayer.hasLayer(existing)) existing.addTo(linesLayer)
            return
        }

        if (existing) {
            linesLayer.removeLayer(existing)
            state.lineLayers.delete(line.id)
        }

        const nextLine = createRenderedLine(line, canvasRenderer)
        nextLine.addTo(linesLayer)
        state.lineLayers.set(line.id, nextLine)
    })

    Array.from(state.lineLayers.entries()).forEach(([lineId, layer]) => {
        if (desiredIds.has(lineId)) return
        linesLayer.removeLayer(layer)
        state.lineLayers.delete(lineId)
    })
}

function syncRenderedPoles(params: {
    map: L.Map
    polesLayer: L.LayerGroup
    poles: PowerPole[]
    zoom: number
    canvasRenderer: L.Renderer
    buildPolePopupContent?: (pole: PowerPole) => string
}) {
    const { map, polesLayer, poles, zoom, canvasRenderer, buildPolePopupContent } = params
    const state = getLayerState(map)
    const useLightweight = shouldUseLightweightPoleMarkers(zoom)
    const desiredIds = new Set<number>()

    poles.forEach((pole) => {
        desiredIds.add(pole.id)
        const nextKey = useLightweight
            ? buildPoleRenderKey(pole) + '|light'
            : buildPoleRenderKey(pole)
        const existing = state.poleMarkers.get(pole.id)

        if (existing && existing.__codexRenderKey === nextKey) {
            if (!polesLayer.hasLayer(existing)) existing.addTo(polesLayer)
            return
        }

        if (existing) {
            polesLayer.removeLayer(existing)
            state.poleMarkers.delete(pole.id)
        }

        const nextMarker = useLightweight
            ? createLightweightPoleMarker(pole, canvasRenderer, buildPolePopupContent)
            : createRenderedPoleMarker(pole, buildPolePopupContent)
        nextMarker.addTo(polesLayer)
        state.poleMarkers.set(pole.id, nextMarker)
    })

    Array.from(state.poleMarkers.entries()).forEach(([poleId, marker]) => {
        if (desiredIds.has(poleId)) return
        polesLayer.removeLayer(marker)
        state.poleMarkers.delete(poleId)
    })
}

export async function renderPowerInfrastructure(params: RenderPowerInfrastructureParams) {
    const {
        map,
        polesLayer,
        linesLayer,
        enabled,
        linesEnabled = enabled,
        polesEnabled = enabled,
        maxArea = 0.2,
        allowedVoltages,
        localityCodes,
        countyLabels,
        precinctLabels,
        selectedParcelIds,
        boundaryPolygons,
        scopeBounds,
        excludePoleTypes = [],
        minLineZoom = 0,
        minPoleZoom = 0,
        bulkResolvePoleParcelsMinZoom = AUTO_RESOLVE_POLE_PARCELS_MIN_ZOOM,
        assignedPolesOnly = false,
        addressFilter = 'all',
        buildPolePopupContent,
        onPoleCountChange,
        onVisiblePolesChange
    } = params

    if (!map || !polesLayer || !linesLayer) return

    const renderRequest = (activeRenderRequestByMap.get(map) || 0) + 1
    activeRenderRequestByMap.set(map, renderRequest)

    if (!enabled) {
        clearRenderedInfrastructure(map, polesLayer, linesLayer)
        renderCacheByMap.delete(map)
        onPoleCountChange?.(0)
        onVisiblePolesChange?.([])
        return
    }

    const bounds = map.getBounds()
    const viewportBounds = normalizeBounds(bounds)
    const normalizedBounds = scopeBounds
        ? intersectBounds(viewportBounds, normalizeScopeBounds(scopeBounds))
        : viewportBounds
    const zoom = map.getZoom()
    if (!normalizedBounds) {
        clearRenderedInfrastructure(map, polesLayer, linesLayer)
        renderCacheByMap.delete(map)
        onPoleCountChange?.(0)
        onVisiblePolesChange?.([])
        return
    }
    const area = (normalizedBounds.north - normalizedBounds.south) * (normalizedBounds.east - normalizedBounds.west)
    const areaTooLargeForPoles = area > maxArea
    if (areaTooLargeForPoles && !linesEnabled) {
        clearRenderedInfrastructure(map, polesLayer, linesLayer)
        renderCacheByMap.delete(map)
        onPoleCountChange?.(0)
        onVisiblePolesChange?.([])
        return
    }

    const signature = JSON.stringify({
        enabled,
        linesEnabled,
        polesEnabled,
        allowedVoltages: allowedVoltages?.join(',') || '',
        localityCodes: localityCodes?.join(',') || '',
        countyLabels: countyLabels?.join(',') || '',
        precinctLabels: precinctLabels?.join(',') || '',
        selectedParcelIds: selectedParcelIds?.join(',') || '',
        boundaryPolygonCount: boundaryPolygons?.length || 0,
        scopeBounds: normalizedBounds ? `${normalizedBounds.south.toFixed(5)}|${normalizedBounds.west.toFixed(5)}|${normalizedBounds.north.toFixed(5)}|${normalizedBounds.east.toFixed(5)}` : '',
        excludePoleTypes: excludePoleTypes.join(','),
        minLineZoom,
        minPoleZoom,
        bulkResolvePoleParcelsMinZoom,
        assignedPolesOnly,
        addressFilter
    })
    const cachedRender = renderCacheByMap.get(map)
    if (cachedRender && cachedRender.zoom === zoom && cachedRender.signature === signature && isBoundsInside(normalizedBounds, cachedRender.renderedBounds)) {
        onPoleCountChange?.(cachedRender.poleCount)
        return
    }

    const fetchBounds = expandBounds(normalizedBounds, area > maxArea * 0.55 ? 0.14 : 0.24)

    const canvasRenderer = getCanvasRenderer(map)

    const zoomVoltages: PowerPole['voltage'][] = allowedVoltages
        ? allowedVoltages
        : zoom >= 14
            ? ['sn', 'wn', 'unknown']
            : zoom >= 13
                ? ['sn', 'wn']
                : zoom >= 12
                    ? ['wn']
                    : ['wn']
    const activeLineVoltages = new Set<PowerPole['voltage']>(zoomVoltages)
    const activePoleVoltages = new Set<PowerPole['voltage']>(
        allowedVoltages
            ? allowedVoltages
            : zoom >= 14
                ? ['sn', 'wn', 'unknown']
                : zoom >= 13
                    ? ['sn', 'wn']
                    : ['wn']
    )

    const { poles, lines } = await fetchPowerData(fetchBounds, { localityCodes, countyLabels, precinctLabels, boundaryPolygons })
    if (activeRenderRequestByMap.get(map) !== renderRequest) return

    const excludedPoleTypes = new Set<PowerPole['type']>(excludePoleTypes)

    const visibleLines = linesEnabled && zoom >= minLineZoom
        ? lines.filter((line) => activeLineVoltages.has(line.voltage))
        : []
    syncRenderedLines({
        map,
        linesLayer,
        lines: visibleLines,
        canvasRenderer
    })

    const shouldBulkResolvePoleParcels = zoom >= bulkResolvePoleParcelsMinZoom
    const baseVisiblePoles = polesEnabled && !areaTooLargeForPoles && zoom >= minPoleZoom
        ? poles.filter((pole) => activePoleVoltages.has(pole.voltage) && !excludedPoleTypes.has(pole.type))
        : []
    const parcelFilteredPoles =
        selectedParcelIds && selectedParcelIds.length > 0
            ? baseVisiblePoles.filter((pole) => {
                  const parcelId = `${pole.parcelId || ''}`.trim()
                  return parcelId.length > 0 && selectedParcelIds.includes(parcelId)
              })
            : baseVisiblePoles
    const candidateVisiblePoles = assignedPolesOnly && !shouldBulkResolvePoleParcels
        ? parcelFilteredPoles.filter((pole) => hasPowerPoleParcelAssignment(pole))
        : parcelFilteredPoles
    const sampledVisiblePoles = downsamplePolesForZoom(candidateVisiblePoles, zoom)
    const maxVisiblePoles = getMaxVisiblePolesForZoom(zoom)
    const cappedVisiblePoles = capPolesWithSpatialBalance(sampledVisiblePoles, maxVisiblePoles, zoom)
    const locallyResolvedVisiblePoles = shouldBulkResolvePoleParcels
        ? await resolvePowerPolesWithLocalParcels(cappedVisiblePoles)
        : cappedVisiblePoles
    const resolvedVisiblePoles =
        shouldBulkResolvePoleParcels && zoom >= AUTO_RESOLVE_POLE_PARCELS_MIN_ZOOM
            ? await resolvePowerPoleParcels(locallyResolvedVisiblePoles)
            : locallyResolvedVisiblePoles
    const addressFilteredPoles = resolvedVisiblePoles.filter((pole) => {
        if (addressFilter === 'exact') return Boolean(getPowerPoleDisplayAddress(pole))
        if (addressFilter === 'missing') return !getPowerPoleDisplayAddress(pole)
        return true
    })
    const visiblePoles = assignedPolesOnly
        ? addressFilteredPoles.filter((pole) => hasPowerPoleParcelAssignment(pole))
        : addressFilteredPoles

    syncRenderedPoles({
        map,
        polesLayer,
        poles: visiblePoles,
        zoom,
        canvasRenderer,
        buildPolePopupContent
    })

    onPoleCountChange?.(visiblePoles.length)
    onVisiblePolesChange?.(visiblePoles)
    renderCacheByMap.set(map, {
        zoom,
        signature,
        renderedBounds: fetchBounds,
        poleCount: visiblePoles.length
    })
}
