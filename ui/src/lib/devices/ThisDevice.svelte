<script lang="ts">
    import { tick } from 'svelte';
    import { Pencil, Check, X } from 'lucide-svelte';
    import { devicesStore, type DeviceSelf } from '$lib/devicesStore';
    import { platformLabel, shortId } from '$lib/format';
    import CopyButton from './CopyButton.svelte';
    import PlatformIcon from './PlatformIcon.svelte';

    /** "This device" card: name (inline rename), platform, peer ID and pairing address. */
    let { self }: { self: DeviceSelf } = $props();

    let editing = $state(false);
    let draft = $state('');
    let saving = $state(false);
    let renameError = $state('');
    let nameInput = $state<HTMLInputElement>();

    const pairingAddress = $derived(self.peerId && self.addrs.length > 0 ? `${self.addrs[0]}/p2p/${self.peerId}` : null);

    async function startEdit() {
        draft = self.name;
        renameError = '';
        editing = true;
        await tick();
        nameInput?.select();
    }

    async function save() {
        const name = draft.trim();
        if (name === self.name) {
            editing = false;
            return;
        }
        if (name.length > 64) {
            renameError = 'Names can be at most 64 characters.';
            return;
        }
        saving = true;
        renameError = '';
        const r = await devicesStore.rename(name);
        saving = false;
        if (r.ok) editing = false;
        else renameError = r.error;
    }

    function onKey(e: KeyboardEvent) {
        if (e.key === 'Escape') {
            e.preventDefault();
            editing = false;
            renameError = '';
        }
    }
</script>

<div class="rounded-2xl border border-line-subtle bg-surface-1 p-4 space-y-3">
    <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
            <PlatformIcon platform={self.platform} size={18} />
        </div>
        <div class="min-w-0 flex-1">
            <p class="text-3xs uppercase tracking-widest text-fg-faint">This device</p>
            {#if editing}
                <form class="flex items-center gap-1.5 mt-0.5" onsubmit={(e) => { e.preventDefault(); void save(); }}>
                    <input
                        bind:this={nameInput}
                        bind:value={draft}
                        onkeydown={onKey}
                        maxlength={64}
                        disabled={saving}
                        placeholder="Leave empty to use the computer's name"
                        aria-label="Device name"
                        class="flex-1 min-w-0 bg-surface-2 border border-line-strong rounded-lg px-2 py-1 text-md text-fg placeholder-fg-faint focus:outline-none focus:border-accent/40"
                    />
                    <button type="submit" disabled={saving} aria-label="Save device name"
                            class="p-1.5 rounded-lg text-success-fg-strong hover:bg-success/10 disabled:opacity-40 transition-colors">
                        <Check size={14} />
                    </button>
                    <button type="button" onclick={() => { editing = false; renameError = ''; }} disabled={saving} aria-label="Cancel renaming"
                            class="p-1.5 rounded-lg text-fg-subtle hover:bg-surface-3 disabled:opacity-40 transition-colors">
                        <X size={14} />
                    </button>
                </form>
            {:else}
                <div class="flex items-center gap-1.5">
                    <span class="text-md font-medium text-fg truncate">{self.name || 'Unnamed device'}</span>
                    <button type="button" onclick={startEdit} aria-label="Rename this device" title="Rename this device"
                            class="p-1 rounded-md text-fg-faint hover:text-fg hover:bg-surface-3 transition-colors">
                        <Pencil size={12} />
                    </button>
                </div>
            {/if}
        </div>
        <span class="text-xs text-fg-faint shrink-0">{platformLabel(self.platform)}{self.version ? ` · v${self.version}` : ''}</span>
    </div>
    {#if renameError}<p class="text-xs text-danger-fg">{renameError}</p>{/if}

    <dl class="border-t border-line-subtle pt-3 grid grid-cols-[7.5rem_1fr] gap-y-2 text-xs items-center">
        <dt class="text-fg-faint">Peer ID</dt>
        <dd class="flex items-center gap-2 min-w-0">
            {#if self.peerId}
                <span class="font-mono text-fg-muted truncate" title={self.peerId}>{shortId(self.peerId, 10, 8)}</span>
                <CopyButton text={self.peerId} label="Copy peer ID" />
            {:else}
                <span class="text-fg-faint">Available once the IPFS node is running</span>
            {/if}
        </dd>
        <dt class="text-fg-faint self-start pt-1">Pairing address</dt>
        <dd class="min-w-0">
            {#if pairingAddress}
                <div class="flex items-start gap-2">
                    <span class="font-mono text-fg-muted break-all" data-testid="pairing-address">{pairingAddress}</span>
                    <CopyButton text={pairingAddress} label="Copy pairing address" />
                </div>
                <p class="text-2xs text-fg-faint mt-1">Paste this into "Pair manually" on your other device.</p>
                {#if self.addrs.length > 1}
                    <details class="mt-1 text-2xs">
                        <summary class="cursor-pointer text-fg-faint hover:text-fg-muted">{self.addrs.length - 1} other address{self.addrs.length === 2 ? '' : 'es'}</summary>
                        <ul class="mt-1 space-y-0.5">
                            {#each self.addrs.slice(1) as addr (addr)}
                                <li class="font-mono text-fg-faint break-all">{addr}/p2p/{self.peerId}</li>
                            {/each}
                        </ul>
                    </details>
                {/if}
            {:else if self.peerId}
                <span class="text-fg-faint">
                    This device has no network address yet. Connect it to a network (Wi-Fi or Ethernet); the address appears here once the IPFS node is listening on it.
                </span>
            {:else}
                <span class="text-fg-faint">Available once the IPFS node is running</span>
            {/if}
        </dd>
    </dl>
</div>
