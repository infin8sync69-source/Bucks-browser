<script lang="ts">
    import { duration as motion } from '$design/dist/tokens.js';
    // Profile panel (header avatar): your display name and bio, your IPFS peer ID and a contact card
    // to give people, and what your node holds. Name and bio stay on this computer.
    import { onMount } from "svelte";
    import { scale } from "svelte/transition";
    import { X } from "lucide-svelte";
    import { bucks, type IpfsStats } from "$lib/bridge";
    import { ipfsStore } from "$lib/ipfsStore";
    import { browserStore } from "$lib/stores";
    import { formatBytes } from "$lib/format";
    import { pushOverlay, popOverlay } from "$lib/uiState";
    import { profileStore } from "$lib/newtab/stores";
    import { MAX_BIO, MAX_NAME, contactCard, initial, nameError } from "$lib/newtab/profile";
    import CopyButton from "$lib/devices/CopyButton.svelte";

    let { onclose }: { onclose: () => void } = $props();

    let name = $state($profileStore.name);
    let bio = $state($profileStore.bio);
    let nameMsg = $state("");
    let bioMsg = $state("");
    let stats = $state<IpfsStats | null>(null);
    let pairedCount = $state<number | null>(null);

    const peerId = $derived($ipfsStore.status?.peer_id ?? null);
    const online = $derived($ipfsStore.status?.state === "ready");

    function saveName() {
        const err = nameError(name);
        if (err) { nameMsg = err; return; }
        profileStore.save({ name });
        name = $profileStore.name;
        nameMsg = "Saved";
        setTimeout(() => nameMsg === "Saved" && (nameMsg = ""), 2000);
    }

    function saveBio() {
        profileStore.save({ bio });
        bioMsg = "Saved";
        setTimeout(() => bioMsg === "Saved" && (bioMsg = ""), 2000);
    }

    onMount(() => {
        pushOverlay();
        if (online) bucks.ipfs.stats().then((s) => (stats = s)).catch(() => {});
        bucks.devices.status().then((d) => (pairedCount = d.paired.length)).catch(() => {});
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onclose();
        window.addEventListener("keydown", onKey);
        return () => { window.removeEventListener("keydown", onKey); popOverlay(); };
    });

    const used = $derived(stats && stats.storage_max ? Math.min(100, (stats.repo_size / stats.storage_max) * 100) : null);
</script>

<div class="fixed inset-0 z-panel-backdrop" role="presentation" onclick={onclose}></div>
<div
    class="fixed top-[84px] right-4 z-panel w-[340px] max-h-[calc(100vh-200px)] overflow-y-auto rounded-3xl border border-line-strong bg-surface-raised/95 backdrop-blur-xl shadow-2xl"
    role="dialog"
    aria-label="Profile"
    transition:scale={{ duration: motion.fast, start: 0.97 }}
>
    <div class="flex items-center gap-3 p-5 border-b border-line">
        <div class="relative w-12 h-12 rounded-2xl bg-gradient-to-br from-agent to-accent-emphasis flex items-center justify-center text-xl text-on-emphasis font-medium">
            {initial($profileStore.name)}
            <span class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-surface-raised {online ? 'bg-success' : 'bg-surface-6'}"
                title={online ? "IPFS node online" : "IPFS node offline"}></span>
        </div>
        <div class="min-w-0">
            <p class="text-md text-fg truncate">{$profileStore.name || "No name yet"}</p>
            <p class="text-2xs text-fg-faint">{online ? "Online" : "Offline"}{pairedCount ? ` · ${pairedCount} paired device${pairedCount === 1 ? "" : "s"}` : ""}</p>
        </div>
        <button onclick={onclose} aria-label="Close profile" class="ml-auto self-start w-7 h-7 flex items-center justify-center rounded-full hover:bg-surface-4 text-fg-faint"><X size={14} /></button>
    </div>

    <div class="p-5 space-y-4">
        <form onsubmit={(e) => { e.preventDefault(); saveName(); }} class="space-y-1.5">
            <label for="profile-name" class="text-3xs uppercase tracking-wider text-fg-faint">Display name</label>
            <div class="flex gap-2">
                <input id="profile-name" bind:value={name} maxlength={MAX_NAME} placeholder="Your name" spellcheck="false"
                    oninput={() => (nameMsg = "")}
                    class="flex-1 min-w-0 bg-surface-2 border border-line rounded-xl px-3 py-2 text-sm text-fg-muted placeholder-fg-faint outline-none focus:border-line-emphasis" />
                <button type="submit" class="px-3 rounded-xl bg-surface-3 hover:bg-surface-4 text-xs text-fg-muted">Save</button>
            </div>
            {#if nameMsg}<p class="text-2xs {nameMsg === 'Saved' ? 'text-success-fg-strong/80' : 'text-warning-fg-strong/80'}" role="status">{nameMsg}</p>{/if}
        </form>

        <div class="space-y-1.5">
            <label for="profile-bio" class="text-3xs uppercase tracking-wider text-fg-faint">Bio</label>
            <textarea id="profile-bio" bind:value={bio} maxlength={MAX_BIO} rows="3" placeholder="A line or two about you" oninput={() => (bioMsg = "")}
                class="w-full resize-none bg-surface-2 border border-line rounded-xl px-3 py-2 text-xs text-fg-muted placeholder-fg-faint outline-none focus:border-line-emphasis"></textarea>
            <div class="flex items-center gap-2">
                <button onclick={saveBio} class="px-3 py-1.5 rounded-xl bg-surface-3 hover:bg-surface-4 text-xs text-fg-muted">Save bio</button>
                <span class="text-3xs text-fg-faint ml-auto tabular-nums">{bio.length}/{MAX_BIO}</span>
                {#if bioMsg}<span class="text-2xs text-success-fg-strong/80" role="status">{bioMsg}</span>{/if}
            </div>
        </div>

        <div class="space-y-1.5">
            <p class="text-3xs uppercase tracking-wider text-fg-faint">Peer ID</p>
            {#if peerId}
                <div class="flex items-center gap-2">
                    <code class="flex-1 min-w-0 truncate text-2xs text-fg-subtle font-mono" title={peerId}>{peerId}</code>
                    <CopyButton text={peerId} label="Copy peer ID" />
                </div>
                <div class="flex items-center gap-2 pt-1">
                    <span class="flex-1 text-2xs text-fg-faint">Contact card: your peer ID and name, as one link</span>
                    <CopyButton text={contactCard(peerId, $profileStore.name)} label="Copy contact card" />
                </div>
            {:else}
                <p class="text-2xs text-fg-faint">Available once the IPFS node is running.</p>
            {/if}
        </div>

        {#if stats}
            <div class="space-y-1.5">
                <div class="flex text-3xs uppercase tracking-wider text-fg-faint">
                    <span>IPFS storage</span>
                    <span class="ml-auto normal-case tracking-normal text-fg-faint tabular-nums">{formatBytes(stats.repo_size)}{stats.storage_max ? ` / ${formatBytes(stats.storage_max)}` : ""}</span>
                </div>
                {#if used !== null}
                    <div class="h-1.5 rounded-full bg-surface-3 overflow-hidden"><div class="h-full rounded-full bg-gradient-to-r from-cat-cyan to-accent" style="width: {used}%"></div></div>
                {/if}
                <p class="text-2xs text-fg-faint">{stats.num_objects} objects · {stats.peers} peer{stats.peers === 1 ? "" : "s"} connected</p>
            </div>
        {/if}

        <button onclick={() => { browserStore.createOrFocusTab("bucks://settings"); onclose(); }}
            class="w-full py-2 rounded-xl bg-surface-2 hover:bg-surface-4 text-xs text-fg-subtle transition-colors">Devices and settings</button>
    </div>
</div>
