export const APP_NAME = 'Spotkania Handlowe'
export const APP_SHORT_NAME = 'Spotkania'
export const APP_TAGLINE = 'Panel spotka\u0144 terenowych'
export const APP_DESCRIPTION = 'Aplikacja do planowania, obs\u0142ugi i raportowania spotka\u0144 handlowc\u00f3w w terenie.'
export const APP_VERSION = '2.3.1'
export const ENTRY_SPLASH_STORAGE_KEY = 'showEntrySplash'

export type AppProfile = 'worker' | 'admin'

export const PROFILE_META: Record<
  AppProfile,
  { label: string; subtitle: string; icon: string; accentClass: string; panelClass: string }
> = {
  worker: {
    label: 'Handlowiec',
    subtitle: 'Profil terenowy',
    icon: '\u{1F9D1}',
    accentClass: 'text-cyan-300',
    panelClass: 'border-cyan-400/30 bg-cyan-500/10',
  },
  admin: {
    label: 'Administrator',
    subtitle: 'Profil zarz\u0105dzania',
    icon: '\u2699',
    accentClass: 'text-amber-300',
    panelClass: 'border-amber-400/30 bg-amber-500/10',
  },
}

export const getProfileLabel = (role: AppProfile): string => PROFILE_META[role].label
export const getProfileSubtitle = (role: AppProfile): string => PROFILE_META[role].subtitle
