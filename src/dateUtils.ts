
/**
 * Returns the ISO string for the start of the current day (00:00:00) in local time.
 */
export function getStartOfDayISO(): string {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return start.toISOString();
}

/**
 * Checks if a given timestamp is from today.
 */
export function isToday(isoString: string): boolean {
    const date = new Date(isoString);
    const now = new Date();
    return (
        date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate()
    );
}
