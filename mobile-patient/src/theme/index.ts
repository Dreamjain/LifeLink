/**
 * The whole visual language of the app, in one file.
 *
 * The palette is deliberately small and high-contrast: this screen may be read one-handed, in
 * the dark, by someone who is frightened. Every foreground/background pair below exceeds the
 * WCAG AA 4.5:1 contrast ratio, the SOS control is the only red element so nothing competes
 * with it, and no information is carried by colour alone - every status is also spelled out in
 * words.
 */
export const colors = {
  background: '#0B0F14',
  surface: '#161C24',
  surfaceRaised: '#202934',
  border: '#36424F',
  text: '#F7FAFC',
  textMuted: '#C3CCD6',
  primary: '#2F6FED',
  primaryText: '#FFFFFF',
  danger: '#D7263D',
  dangerText: '#FFFFFF',
  success: '#2E9E5B',
  warning: '#E0A106',
  warningText: '#1A1203',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const radii = {
  sm: 8,
  md: 12,
  pill: 999,
} as const;

export const typography = {
  /** Screen titles. */
  title: { fontSize: 28, fontWeight: '700' as const, color: colors.text },
  /** Section headings. */
  heading: { fontSize: 20, fontWeight: '700' as const, color: colors.text },
  /** Default reading size. Kept at 16 so the OS text-size setting scales from a legible base. */
  body: { fontSize: 16, fontWeight: '400' as const, color: colors.text },
  /** Supporting copy. Never used for anything the patient must act on. */
  caption: { fontSize: 14, fontWeight: '400' as const, color: colors.textMuted },
} as const;

/** The minimum touch target this app ships. Matches the 44pt/48dp platform guidance. */
export const MIN_TOUCH_SIZE = 48;
