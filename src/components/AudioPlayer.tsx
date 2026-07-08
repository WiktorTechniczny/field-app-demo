import { useEffect, useRef, useState } from 'react'

export default function AudioPlayer({
    url,
    expectedDurationSeconds = null
}: {
    url: string
    expectedDurationSeconds?: number | null
}) {
    const audioRef = useRef<HTMLAudioElement | null>(null)
    const [isPlaying, setIsPlaying] = useState(false)
    const [duration, setDuration] = useState(0)
    const [currentTime, setCurrentTime] = useState(0)
    const [isLoaded, setIsLoaded] = useState(false)

    const shouldPreferExpectedDuration =
        expectedDurationSeconds !== null &&
        expectedDurationSeconds > 0 &&
        (!isFinite(duration) || duration <= 0 || duration > expectedDurationSeconds * 2.2)
    const uiDuration = shouldPreferExpectedDuration
        ? expectedDurationSeconds
        : (isFinite(duration) && duration > 0 ? duration : expectedDurationSeconds ?? 0)
    const progressValue = uiDuration > 0 ? Math.min(100, (currentTime / uiDuration) * 100) : 0

    useEffect(() => {
        const audio = audioRef.current
        if (!audio) return

        const trySetDuration = () => {
            if (!isFinite(audio.duration) || audio.duration <= 0) {
                // Chrome sometimes resolves webm duration only after forcing a seek.
                if (audio.duration === Infinity) {
                    audio.currentTime = 1e101
                    audio.ontimeupdate = function () {
                        this.ontimeupdate = null
                        audio.currentTime = 0
                    }
                }
                return
            }
            setDuration(audio.duration)
            setIsLoaded(true)
        }

        const onTimeUpdate = () => {
            setCurrentTime(audio.currentTime)
            const nextDuration = audio.duration
            if (isFinite(nextDuration) && nextDuration > 0) {
                setDuration(nextDuration)
                setIsLoaded(true)
            }
        }

        const onEnded = () => {
            setIsPlaying(false)
            setCurrentTime(0)
            audio.currentTime = 0
        }

        audio.addEventListener('loadedmetadata', trySetDuration)
        audio.addEventListener('durationchange', trySetDuration)
        audio.addEventListener('timeupdate', onTimeUpdate)
        audio.addEventListener('ended', onEnded)

        audio.load()
        const checkTimer = window.setTimeout(trySetDuration, 1000)

        return () => {
            window.clearTimeout(checkTimer)
            audio.removeEventListener('loadedmetadata', trySetDuration)
            audio.removeEventListener('durationchange', trySetDuration)
            audio.removeEventListener('timeupdate', onTimeUpdate)
            audio.removeEventListener('ended', onEnded)
        }
    }, [url])

    const togglePlayPause = () => {
        const audio = audioRef.current
        if (!audio) return

        if (isPlaying) {
            audio.pause()
            setIsPlaying(false)
            return
        }

        audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false))
    }

    const handleProgressChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const audio = audioRef.current
        if (!audio || !isFinite(uiDuration) || uiDuration <= 0) return

        const newTime = (Number(event.target.value) / 100) * uiDuration
        audio.currentTime = newTime
        setCurrentTime(newTime)
    }

    const formatTime = (time: number) => {
        if (!time || !isFinite(time) || time < 0) return '0:00'
        const mins = Math.floor(time / 60)
        const secs = Math.floor(time % 60)
        return `${mins}:${secs.toString().padStart(2, '0')}`
    }

    return (
        <div className="flex items-center gap-3 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700/60 rounded-full px-3 py-2 shadow-sm relative overflow-hidden group w-full">
            <audio ref={audioRef} src={url} preload="metadata" />

            <button
                onClick={togglePlayPause}
                className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-all ${
                    isLoaded || shouldPreferExpectedDuration
                        ? 'bg-cyan-500 hover:bg-cyan-600 text-white shadow-md shadow-cyan-500/20 hover:scale-105 active:scale-95'
                        : 'bg-gray-100 dark:bg-slate-700 text-gray-400'
                }`}
            >
                {isPlaying ? (
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6zm8 0h4v16h-4z" /></svg>
                ) : (
                    <svg className="w-5 h-5 ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                )}
            </button>

            <div className="flex-1 min-w-0 flex items-center gap-2">
                <span className="text-[10px] font-mono text-gray-500 dark:text-gray-400 shrink-0 w-8 text-right">
                    {formatTime(currentTime)}
                </span>

                <div className="relative flex-1 flex items-center h-5 cursor-pointer">
                    <input
                        type="range"
                        min="0"
                        max="100"
                        step="0.1"
                        value={progressValue || 0}
                        onChange={handleProgressChange}
                        disabled={!isLoaded && !shouldPreferExpectedDuration}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10 disabled:cursor-default"
                    />
                    <div className="w-full h-1.5 bg-gray-100 dark:bg-slate-700 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-cyan-500 transition-all duration-100 ease-linear rounded-full"
                            style={{ width: `${progressValue}%` }}
                        />
                    </div>
                </div>

                <span className="text-[10px] font-mono text-gray-400 dark:text-gray-500 shrink-0 w-8">
                    {(isLoaded || shouldPreferExpectedDuration) && uiDuration > 0 ? formatTime(uiDuration) : '...'}
                </span>
            </div>

            {!isLoaded && !shouldPreferExpectedDuration && (
                <div className="absolute inset-0 bg-white/50 dark:bg-slate-800/50 backdrop-blur-[1px] flex items-center justify-center pointer-events-none">
                    <div className="w-3 h-3 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
                </div>
            )}
        </div>
    )
}
