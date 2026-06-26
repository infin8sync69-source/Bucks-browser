<script lang="ts">
    import { fade, scale } from "svelte/transition";
    import { cubicOut } from "svelte/easing";
    import { browserStore } from "$lib/stores";

    // DID identity — generate & persist in localStorage
    const DID_KEY = "bucks_did";
    const PROFILE_KEY = "bucks_profile";

    interface Profile { name: string; bio: string; did: string; createdAt: number; }

    function loadProfile(): Profile | null {
        try { return JSON.parse(localStorage.getItem(PROFILE_KEY) ?? "null"); } catch { return null; }
    }
    function saveProfile(p: Profile) { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); }

    function generateDID(): string {
        // Simple did:key stub — replace with real key gen when crypto module is wired
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const hex = Array.from(bytes).map(b => b.toString(16).padStart(2,"0")).join("");
        return `did:key:z${hex.slice(0, 44)}`;
    }

    let profile = $state<Profile | null>(loadProfile());
    let editMode = $state(!profile);
    let name = $state(profile?.name ?? "");
    let bio  = $state(profile?.bio  ?? "");
    let copied = $state(false);

    function create() {
        if (!name.trim()) return;
        const p: Profile = { name: name.trim(), bio: bio.trim(), did: generateDID(), createdAt: Date.now() };
        saveProfile(p);
        profile = p;
        editMode = false;
    }

    function copyDid() {
        navigator.clipboard.writeText(profile!.did).catch(() => {});
        copied = true;
        setTimeout(() => copied = false, 1500);
    }

    function reset() {
        if (!confirm("Remove identity and start fresh?")) return;
        localStorage.removeItem(PROFILE_KEY);
        profile = null; editMode = true; name = ""; bio = "";
    }

    function formatDate(ts: number) {
        return new Date(ts).toLocaleDateString("en-US", { month:"long", day:"numeric", year:"numeric" });
    }
</script>

<div class="min-h-screen bg-[#07070a] text-white px-8 py-10 max-w-lg mx-auto" in:fade={{ duration: 300 }}>

    {#if editMode}
        <!-- Create / edit profile -->
        <div class="space-y-8" in:scale={{ duration: 400, easing: cubicOut, start: 0.97 }}>
            <div class="flex items-center gap-3">
                <div class="w-9 h-9 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">👤</div>
                <div>
                    <h1 class="text-lg font-semibold">{profile ? "Edit Profile" : "Create Identity"}</h1>
                    <p class="text-[11px] text-white/30">Your decentralised ID on the Bucks network</p>
                </div>
            </div>

            <!-- Avatar placeholder -->
            <div class="flex justify-center">
                <div class="w-20 h-20 rounded-[2rem] bg-gradient-to-br from-blue-500/30 via-purple-500/30 to-pink-500/30 border border-white/10 flex items-center justify-center text-3xl">
                    {name ? name[0].toUpperCase() : "?"}
                </div>
            </div>

            <div class="space-y-3">
                <div>
                    <label class="text-[10px] uppercase tracking-[0.25em] text-white/30 font-bold block mb-1.5">Display Name *</label>
                    <input bind:value={name} placeholder="Your name"
                        class="w-full bg-white/[0.04] border border-white/[0.08] rounded-2xl px-4 py-3 text-[13px] text-white placeholder-white/25 focus:outline-none focus:border-blue-500/40 transition-colors" />
                </div>
                <div>
                    <label class="text-[10px] uppercase tracking-[0.25em] text-white/30 font-bold block mb-1.5">Bio</label>
                    <textarea bind:value={bio} placeholder="Short description (optional)" rows="2"
                        class="w-full bg-white/[0.04] border border-white/[0.08] rounded-2xl px-4 py-3 text-[13px] text-white placeholder-white/25 focus:outline-none focus:border-blue-500/40 transition-colors resize-none"></textarea>
                </div>
            </div>

            <button onclick={create} disabled={!name.trim()}
                class="w-full py-3 rounded-2xl bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/30 text-blue-300 text-[13px] font-semibold transition-all disabled:opacity-40 active:scale-[0.98]">
                {profile ? "Save Changes" : "Create Identity →"}
            </button>
        </div>

    {:else if profile}
        <!-- View profile -->
        <div class="space-y-8" in:scale={{ duration: 400, easing: cubicOut, start: 0.97 }}>
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-3">
                    <div class="w-9 h-9 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">👤</div>
                    <h1 class="text-lg font-semibold">My Identity</h1>
                </div>
                <button onclick={() => editMode = true}
                    class="text-[11px] text-white/30 hover:text-white/70 transition-colors border border-white/10 rounded-xl px-3 py-1.5">
                    Edit
                </button>
            </div>

            <!-- Avatar + info -->
            <div class="flex items-center gap-5 p-5 rounded-3xl bg-white/[0.03] border border-white/[0.07]">
                <div class="w-16 h-16 rounded-[1.5rem] bg-gradient-to-br from-blue-500/40 via-purple-500/40 to-pink-500/40 border border-white/15 flex items-center justify-center text-2xl font-bold shrink-0">
                    {profile.name[0].toUpperCase()}
                </div>
                <div class="min-w-0">
                    <p class="text-[16px] font-bold text-white/90">{profile.name}</p>
                    {#if profile.bio}
                        <p class="text-[12px] text-white/40 mt-0.5">{profile.bio}</p>
                    {/if}
                    <p class="text-[10px] text-white/25 mt-1">Member since {formatDate(profile.createdAt)}</p>
                </div>
            </div>

            <!-- DID -->
            <div class="space-y-2">
                <p class="text-[10px] uppercase tracking-[0.3em] text-white/25 font-bold">Decentralised Identifier (DID)</p>
                <div class="flex items-center gap-2 p-3 rounded-2xl bg-white/[0.03] border border-white/[0.07]">
                    <p class="flex-1 font-mono text-[10px] text-white/50 truncate">{profile.did}</p>
                    <button onclick={copyDid}
                        class="px-3 py-1.5 rounded-xl text-[10px] font-medium transition-all shrink-0
                               {copied ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-white/[0.06] text-white/40 hover:text-white/70 border border-white/[0.08]'}">
                        {copied ? "✓ Copied" : "Copy"}
                    </button>
                </div>
                <p class="text-[10px] text-white/20">Share your DID to receive signed events on the Bucks network.</p>
            </div>

            <!-- Quick links -->
            <div class="grid grid-cols-2 gap-2">
                <button onclick={() => browserStore.createOrFocusTab("bucks://wallet")}
                    class="p-4 rounded-2xl bg-white/[0.03] border border-white/[0.07] hover:bg-white/[0.06] transition-all text-left">
                    <p class="text-xl mb-2">💰</p>
                    <p class="text-[12px] font-semibold text-white/65">Wallet</p>
                    <p class="text-[10px] text-white/30 mt-0.5">Balances & transfers</p>
                </button>
                <button onclick={() => browserStore.createOrFocusTab("bucks://settings")}
                    class="p-4 rounded-2xl bg-white/[0.03] border border-white/[0.07] hover:bg-white/[0.06] transition-all text-left">
                    <p class="text-xl mb-2">⚙️</p>
                    <p class="text-[12px] font-semibold text-white/65">Settings</p>
                    <p class="text-[10px] text-white/30 mt-0.5">Preferences & data</p>
                </button>
            </div>

            <button onclick={reset}
                class="text-[11px] text-red-400/40 hover:text-red-400/70 transition-colors">
                Remove identity
            </button>
        </div>
    {/if}
</div>
