import type { Survey } from './db'

const EXTENSION_MATCH = /\.(mp3|m4a|mp4|webm|ogg|wav|aac)(?:$|\?)/i

const sanitizeFilenamePart = (raw: string): string => {
    const normalized = raw
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
    return normalized || 'plik'
}

const findExtensionInValue = (value?: string | null): string | null => {
    if (!value) return null
    const match = value.match(EXTENSION_MATCH)
    return match ? match[1].toLowerCase() : null
}

const toInt16Pcm = (input: Float32Array): Int16Array => {
    const out = new Int16Array(input.length)
    for (let i = 0; i < input.length; i += 1) {
        const s = Math.max(-1, Math.min(1, input[i]))
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    return out
}

const downmixToMono = (audioBuffer: AudioBuffer): Float32Array => {
    if (audioBuffer.numberOfChannels === 1) return audioBuffer.getChannelData(0)
    const left = audioBuffer.getChannelData(0)
    const right = audioBuffer.getChannelData(1)
    const mono = new Float32Array(audioBuffer.length)
    for (let i = 0; i < audioBuffer.length; i += 1) mono[i] = (left[i] + right[i]) * 0.5
    return mono
}

const convertBlobToMp3 = async (sourceBlob: Blob): Promise<Blob> => {
    if (typeof window === 'undefined') throw new Error('Brak wsparcia konwersji audio w tym srodowisku.')
    if (sourceBlob.type === 'audio/mpeg') return sourceBlob

    const audioCtxCtor = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
    if (!audioCtxCtor) throw new Error('Brak AudioContext w przegladarce.')

    const audioCtx = new audioCtxCtor()
    try {
        const arr = await sourceBlob.arrayBuffer()
        const decoded = await audioCtx.decodeAudioData(arr.slice(0))
        const mono = downmixToMono(decoded)
        const pcm = toInt16Pcm(mono)

        const lameModule = await import('lamejs')
        const Mp3EncoderCtor =
            (lameModule as unknown as { Mp3Encoder?: new (channels: number, sampleRate: number, kbps: number) => { encodeBuffer: (pcm: Int16Array) => Int8Array; flush: () => Int8Array } }).Mp3Encoder ||
            (lameModule as unknown as { default?: { Mp3Encoder?: new (channels: number, sampleRate: number, kbps: number) => { encodeBuffer: (pcm: Int16Array) => Int8Array; flush: () => Int8Array } } }).default?.Mp3Encoder

        if (!Mp3EncoderCtor) throw new Error('Brak Mp3Encoder w lamejs.')

        const encoder = new Mp3EncoderCtor(1, decoded.sampleRate, 128)
        const mp3Chunks: Int8Array[] = []
        const blockSize = 1152

        for (let i = 0; i < pcm.length; i += blockSize) {
            const chunk = pcm.subarray(i, i + blockSize)
            const encoded = encoder.encodeBuffer(chunk)
            if (encoded.length > 0) mp3Chunks.push(new Int8Array(encoded))
        }

        const flush = encoder.flush()
        if (flush.length > 0) mp3Chunks.push(new Int8Array(flush))

        return new Blob(mp3Chunks as unknown as BlobPart[], { type: 'audio/mpeg' })
    } finally {
        await audioCtx.close()
    }
}

const downloadBlob = (filename: string, blob: Blob): void => {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
}

export const getAudioExtension = (survey: Pick<Survey, 'audio_path' | 'audio_url'>): string => {
    const fromPath = findExtensionInValue(survey.audio_path)
    if (fromPath) return fromPath

    if (survey.audio_url) {
        try {
            const parsed = new URL(survey.audio_url)
            const fromUrlPath = findExtensionInValue(parsed.pathname)
            if (fromUrlPath) return fromUrlPath
        } catch {
            const fallback = findExtensionInValue(survey.audio_url)
            if (fallback) return fallback
        }
    }

    return 'audio'
}

export const getAudioDownloadFilename = (
    survey: Pick<Survey, 'audio_path' | 'audio_url'>,
    baseName: string
): string => {
    const ext = getAudioExtension(survey)
    return `${sanitizeFilenamePart(baseName)}.${ext}`
}

export const downloadSurveyAudioAsMp3 = async (
    survey: Pick<Survey, 'audio_path' | 'audio_url'>,
    baseName: string
): Promise<void> => {
    if (!survey.audio_url) {
        throw new Error('Brak nagrania audio do pobrania.')
    }

    const response = await fetch(survey.audio_url)
    if (!response.ok) {
        throw new Error(`Nie udalo sie pobrac nagrania (${response.status}).`)
    }

    const sourceBlob = await response.blob()
    const ext = getAudioExtension(survey)

    let mp3Blob: Blob
    if (sourceBlob.type === 'audio/mpeg' || ext === 'mp3') {
        const arr = await sourceBlob.arrayBuffer()
        mp3Blob = new Blob([arr], { type: 'audio/mpeg' })
    } else {
        mp3Blob = await convertBlobToMp3(sourceBlob)
    }

    downloadBlob(`${sanitizeFilenamePart(baseName)}.mp3`, mp3Blob)
}

export const getTranscriptFilename = (surveyId?: number): string => {
    return `transkrypcja_${surveyId ?? 'ankieta'}.txt`
}

export const buildTranscriptText = (
    survey: Pick<
        Survey,
        'id' | 'created_at' | 'user_name' | 'respondent_name' | 'respondent_phone' | 'address' | 'status' | 'audio_transcript'
    >
): string => {
    const createdAtLabel = survey.created_at ? new Date(survey.created_at).toLocaleString('pl-PL') : 'Brak daty'
    const transcriptBody = survey.audio_transcript?.trim() || '[Brak automatycznej transkrypcji dla tego nagrania]'

    return [
        'TRANSKRYPCJA ROZMOWY',
        `Ankieta ID: ${survey.id ?? 'brak'}`,
        `Data zapisu: ${createdAtLabel}`,
        `Pracownik: ${survey.user_name || 'brak'}`,
        `Respondent: ${survey.respondent_name || 'brak'}`,
        `Telefon: ${survey.respondent_phone || 'brak'}`,
        `Adres: ${survey.address || 'brak'}`,
        `Status: ${survey.status || 'brak'}`,
        '',
        '--- TREŚĆ ---',
        transcriptBody
    ].join('\n')
}

export const downloadText = (filename: string, content: string): void => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
}
