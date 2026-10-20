import type { TabColor } from './stores';

/** Tailwind background class for a tab / space colour (listed in full so Tailwind keeps them). */
const BG: Record<TabColor, string> = {
    blue: 'bg-accent',
    violet: 'bg-agent',
    emerald: 'bg-success',
    amber: 'bg-warning',
    rose: 'bg-cat-rose',
    cyan: 'bg-cat-cyan',
    slate: 'bg-cat-slate',
};

export function tabColorClass(color: TabColor | null | undefined): string {
    return color ? BG[color] ?? 'bg-surface-6' : 'bg-surface-6';
}
