import type { TabColor } from './stores';

/** Tailwind background class for a tab / space colour (listed in full so Tailwind keeps them). */
const BG: Record<TabColor, string> = {
    blue: 'bg-blue-400',
    violet: 'bg-violet-400',
    emerald: 'bg-emerald-400',
    amber: 'bg-amber-400',
    rose: 'bg-rose-400',
    cyan: 'bg-cyan-400',
    slate: 'bg-slate-400',
};

export function tabColorClass(color: TabColor | null | undefined): string {
    return color ? BG[color] ?? 'bg-white/30' : 'bg-white/30';
}
