<script lang="ts" generics="T extends string">
    interface Option {
        id: T;
        label: string;
        hint?: string;
    }

    let {
        name,
        options,
        value,
        accent = 'blue',
        onchange,
    }: {
        name: string;
        options: Option[];
        value: T;
        accent?: 'blue' | 'emerald' | 'violet';
        onchange: (value: T) => void;
    } = $props();

    const styles = {
        blue: { on: 'border-blue-500/40 bg-blue-500/10', ring: 'border-blue-400', dot: 'bg-blue-400' },
        emerald: { on: 'border-emerald-500/40 bg-emerald-500/10', ring: 'border-emerald-400', dot: 'bg-emerald-400' },
        violet: { on: 'border-violet-500/40 bg-violet-500/10', ring: 'border-violet-400', dot: 'bg-violet-400' },
    } as const;
    const st = $derived(styles[accent]);
</script>

<div role="radiogroup" aria-label={name} class="space-y-1.5">
    {#each options as o (o.id)}
        <label
            class="flex items-center gap-3 p-3 rounded-2xl border cursor-pointer transition-all
                   {value === o.id ? st.on : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]'}"
        >
            <div class="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 {value === o.id ? st.ring : 'border-white/20'}">
                {#if value === o.id}<div class="w-2 h-2 rounded-full {st.dot}"></div>{/if}
            </div>
            <input type="radio" {name} value={o.id} checked={value === o.id} onchange={() => onchange(o.id)} class="sr-only" />
            <span class="text-[13px] text-white/70">{o.label}</span>
            {#if o.hint}<span class="ml-auto text-[10px] text-white/25 font-mono truncate max-w-[200px]">{o.hint}</span>{/if}
        </label>
    {/each}
</div>
