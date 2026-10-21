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
        blue: { on: 'border-accent/40 bg-accent/10', ring: 'border-accent', dot: 'bg-accent' },
        emerald: { on: 'border-success/40 bg-success/10', ring: 'border-success', dot: 'bg-success' },
        violet: { on: 'border-agent/40 bg-agent/10', ring: 'border-agent', dot: 'bg-agent' },
    } as const;
    const st = $derived(styles[accent]);
</script>

<div role="radiogroup" aria-label={name} class="space-y-1.5">
    {#each options as o (o.id)}
        <label
            class="flex items-center gap-3 p-3 rounded-2xl border cursor-pointer transition-all
                   {value === o.id ? st.on : 'border-line bg-surface-1 hover:bg-surface-2'}"
        >
            <div class="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 {value === o.id ? st.ring : 'border-line-emphasis'}">
                {#if value === o.id}<div class="w-2 h-2 rounded-full {st.dot}"></div>{/if}
            </div>
            <input type="radio" {name} value={o.id} checked={value === o.id} onchange={() => onchange(o.id)} class="sr-only" />
            <span class="text-sm text-fg-muted">{o.label}</span>
            {#if o.hint}<span class="ml-auto text-3xs text-fg-faint font-mono truncate max-w-[200px]">{o.hint}</span>{/if}
        </label>
    {/each}
</div>
