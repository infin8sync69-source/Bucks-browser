<script lang="ts">
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

<div class="fixed inset-0 z-[150]" role="presentation" onclick={onclose}></div>
<div
    class="fixed top-[84px] right-4 z-[160] w-[340px] max-h-[calc(100vh-200px)] overflow-y-auto rounded-3xl border border-white/10 bg-[#0d0d14]/95 backdrop-blur-xl shadow-2xl"
    role="dialog"
    aria-label="Profile"
    transition:scale={{ duration: 150, start: 0.97 }}
>
    <div class="flex items-center gap-3 p-5 border-b border-white/[0.06]">
        <div class="relative w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center text-[20px] text-white font-medium">
            {initial($profileStore.name)}
            <span class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#0d0d14] {online ? 'bg-emerald-400' : 'bg-white/25'}"
                title={online ? "IPFS node online" : "IPFS node offline"}></span>
        </div>
        <div class="min-w-0">
            <p class="text-[15px] text-white/90 truncate">{$profileStore.name || "No name yet"}</p>
            <p class="text-[11px] text-white/35">{online ? "Online" : "Offline"}{pairedCount ? ` · ${pairedCount} paired device${pairedCount === 1 ? "" : "s"}` : ""}</p>
        </div>
        <button onclick={onclose} aria-label="Close profile" class="ml-auto self-start w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/10 text-white/40"><X size={14} /></button>
    </div>

    <div class="p-5 space-y-4">
        <form onsubmit={(e) => { e.preventDefault(); saveName(); }} class="space-y-1.5">
            <label for="profile-name" class="text-[10px] uppercase tracking-wider text-white/35">Display name</label>
            <div class="flex gap-2">
                <input id="profile-name" bind:value={name} maxlength={MAX_NAME} placeholder="Your name" spellcheck="false"
                    oninput={() => (nameMsg = "")}
                    class="flex-1 min-w-0 bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 text-[13px] text-white/85 placeholder-white/25 outline-none focus:border-white/20" />
                <button type="submit" class="px-3 rounded-xl bg-white/[0.07] hover:bg-white/[0.12] text-[12px] text-white/80">Save</button>
            </div>
            {#if nameMsg}<p class="text-[11px] {nameMsg === 'Saved' ? 'text-emerald-300/80' : 'text-amber-200/80'}" role="status">{nameMsg}</p>{/if}
        </form>

        <div class="space-y-1.5">
            <label for="profile-bio" class="text-[10px] uppercase tracking-wider text-white/35">Bio</label>
            <textarea id="profile-bio" bind:value={bio} maxlength={MAX_BIO} rows="3" placeholder="A line or two about you" oninput={() => (bioMsg = "")}
                class="w-full resize-none bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 text-[12px] text-white/80 placeholder-white/25 outline-none focus:border-white/20"></textarea>
            <div class="flex items-center gap-2">
                <button onclick={saveBio} class="px-3 py-1.5 rounded-xl bg-white/[0.07] hover:bg-white/[0.12] text-[12px] text-white/80">Save bio</button>
                <span class="text-[10px] text-white/25 ml-auto tabular-nums">{bio.length}/{MAX_BIO}</span>
                {#if bioMsg}<span class="text-[11px] text-emerald-300/80" role="status">{bioMsg}</span>{/if}
            </div>
        </div>

        <div class="space-y-1.5">
            <p class="text-[10px] uppercase tracking-wider text-white/35">Peer ID</p>
            {#if peerId}
                <div class="flex items-center gap-2">
                    <code class="flex-1 min-w-0 truncate text-[11px] text-white/60 font-mono" title={peerId}>{peerId}</code>
                    <CopyButton text={peerId} label="Copy peer ID" />
                </div>
                <div class="flex items-center gap-2 pt-1">
                    <span class="flex-1 text-[11px] text-white/40">Contact card: your peer ID and name, as one link</span>
                    <CopyButton text={contactCard(peerId, $profileStore.name)} label="Copy contact card" />
                </div>
            {:else}
                <p class="text-[11px] text-white/35">Available once the IPFS node is running.</p>
            {/if}
        </div>

        {#if stats}
            <div class="space-y-1.5">
                <div class="flex text-[10px] uppercase tracking-wider text-white/35">
                    <span>IPFS storage</span>
                    <span class="ml-auto normal-case tracking-normal text-white/50 tabular-nums">{formatBytes(stats.repo_size)}{stats.storage_max ? ` / ${formatBytes(stats.storage_max)}` : ""}</span>
                </div>
                {#if used !== null}
                    <div class="h-1.5 rounded-full bg-white/[0.06] overflow-hidden"><div class="h-full rounded-full bg-gradient-to-r from-cyan-400 to-blue-500" style="width: {used}%"></div></div>
                {/if}
                <p class="text-[11px] text-white/35">{stats.num_objects} objects · {stats.peers} peer{stats.peers === 1 ? "" : "s"} connected</p>
            </div>
        {/if}

        <button onclick={() => { browserStore.createOrFocusTab("bucks://settings"); onclose(); }}
            class="w-full py-2 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-[12px] text-white/60 transition-colors">Devices and settings</button>
    </div>
</div>
