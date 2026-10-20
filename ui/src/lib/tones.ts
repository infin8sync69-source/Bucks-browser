/**
 * Decorative tones (the design system's categorical colours) for things that carry a colour as
 * data: mini-app icons, app-store categories, tab groups. A tone is a hue name; the colours come
 * from the tokens (--bucks-color-cat-<tone>, -strong, -deep), so they follow the theme.
 */
export type Tone =
    | 'slate' | 'red' | 'orange' | 'amber' | 'yellow' | 'green' | 'emerald' | 'teal' | 'cyan'
    | 'sky' | 'blue' | 'indigo' | 'violet' | 'purple' | 'fuchsia' | 'pink' | 'rose';

/**
 * CSS custom properties for a tone, for a style attribute: --tone (identity), --tone-strong and
 * --tone-deep (gradient stops), --tone-tint (`tint`% of the tone, for backgrounds) and --bucks-glow
 * (read by the shadow-glow and shadow-app-icon tokens).
 */
export function toneVars(tone: Tone, { glow = 40, tint = 19 }: { glow?: number; tint?: number } = {}): string {
    const c = (step = '') => `var(--bucks-color-cat-${tone}${step ? `-${step}` : ''})`;
    return [
        `--tone: ${c()}`,
        `--tone-strong: ${c('strong')}`,
        `--tone-deep: ${c('deep')}`,
        `--tone-tint: color-mix(in srgb, ${c()} ${tint}%, transparent)`,
        `--bucks-glow: color-mix(in srgb, ${c('strong')} ${glow}%, transparent)`,
    ].join('; ') + ';';
}
