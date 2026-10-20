<script lang="ts">
    import { duration as motion } from '$design/dist/tokens.js';
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

    const savedProfile = loadProfile();
    let profile = $state<Profile | null>(savedProfile);
    let editMode = $state(!savedProfile);
    let name = $state(savedProfile?.name ?? "");
    let bio  = $state(savedProfile?.bio  ?? "");
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

<div class="min-h-screen bg-canvas text-fg px-8 py-10 max-w-lg mx-auto" in:fade={{ duration: motion.moderate }}>

    {#if editMode}
        <!-- Create / edit profile -->
        <div class="space-y-8" in:scale={{ duration: motion.moderate, easing: cubicOut, start: 0.97 }}>
            <div class="flex items-center gap-3">
                <div class="w-9 h-9 rounded-2xl bg-surface-2 border border-line-strong flex items-center justify-center">👤</div>
                <div>
                    <h1 class="text-lg font-semibold">{profile ? "Edit Profile" : "Create Identity"}</h1>
                    <p class="text-2xs text-fg-faint">Your decentralised ID on the Bucks network</p>
                </div>
            </div>

            <!-- Avatar placeholder -->
            <div class="flex justify-center">
                <div class="w-20 h-20 rounded-4xl bg-gradient-to-br from-accent/30 via-cat-purple/30 to-cat-pink/30 border border-line-strong flex items-center justify-center text-3xl">
                    {name ? name[0].toUpperCase() : "?"}
                </div>
            </div>

            <div class="space-y-3">
                <div>
                    <label for="profile-name" class="text-3xs uppercase tracking-caps text-fg-faint font-bold block mb-1.5">Display Name *</label>
                    <input id="profile-name" bind:value={name} placeholder="Your name"
                        class="w-full bg-surface-2 border border-line rounded-2xl px-4 py-3 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-accent/40 transition-colors" />
                </div>
                <div>
                    <label for="profile-bio" class="text-3xs uppercase tracking-caps text-fg-faint font-bold block mb-1.5">Bio</label>
                    <textarea id="profile-bio" bind:value={bio} placeholder="Short description (optional)" rows="2"
                        class="w-full bg-surface-2 border border-line rounded-2xl px-4 py-3 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-accent/40 transition-colors resize-none"></textarea>
                </div>
            </div>

            <button onclick={create} disabled={!name.trim()}
                class="w-full py-3 rounded-2xl bg-accent/20 hover:bg-accent/30 border border-accent/30 text-accent-fg-strong text-sm font-semibold transition-all disabled:opacity-40 active:scale-[0.98]">
                {profile ? "Save Changes" : "Create Identity →"}
            </button>
        </div>

    {:else if profile}
        <!-- View profile -->
        <div class="space-y-8" in:scale={{ duration: motion.moderate, easing: cubicOut, start: 0.97 }}>
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-3">
                    <div class="w-9 h-9 rounded-2xl bg-surface-2 border border-line-strong flex items-center justify-center">👤</div>
                    <h1 class="text-lg font-semibold">My Identity</h1>
                </div>
                <button onclick={() => editMode = true}
                    class="text-2xs text-fg-faint hover:text-fg-muted transition-colors border border-line-strong rounded-xl px-3 py-1.5">
                    Edit
                </button>
            </div>

            <!-- Avatar + info -->
            <div class="flex items-center gap-5 p-5 rounded-3xl bg-surface-1 border border-line">
                <div class="w-16 h-16 rounded-3xl bg-gradient-to-br from-accent/40 via-cat-purple/40 to-cat-pink/40 border border-line-emphasis flex items-center justify-center text-2xl font-bold shrink-0">
                    {profile.name[0].toUpperCase()}
                </div>
                <div class="min-w-0">
                    <p class="text-base font-bold text-fg">{profile.name}</p>
                    {#if profile.bio}
                        <p class="text-xs text-fg-faint mt-0.5">{profile.bio}</p>
                    {/if}
                    <p class="text-3xs text-fg-faint mt-1">Member since {formatDate(profile.createdAt)}</p>
                </div>
            </div>

            <!-- DID -->
            <div class="space-y-2">
                <p class="text-3xs uppercase tracking-caps-wide text-fg-faint font-bold">Decentralised Identifier (DID)</p>
                <div class="flex items-center gap-2 p-3 rounded-2xl bg-surface-1 border border-line">
                    <p class="flex-1 font-mono text-3xs text-fg-faint truncate">{profile.did}</p>
                    <button onclick={copyDid}
                        class="px-3 py-1.5 rounded-xl text-3xs font-medium transition-all shrink-0
                               {copied ? 'bg-success/20 text-success-fg border border-success/30' : 'bg-surface-3 text-fg-faint hover:text-fg-muted border border-line'}">
                        {copied ? "✓ Copied" : "Copy"}
                    </button>
                </div>
                <p class="text-3xs text-fg-disabled">Share your DID to receive signed events on the Bucks network.</p>
            </div>

            <!-- Quick links -->
            <div class="grid grid-cols-2 gap-2">
                <button onclick={() => browserStore.createOrFocusTab("bucks://wallet")}
                    class="p-4 rounded-2xl bg-surface-1 border border-line hover:bg-surface-3 transition-all text-left">
                    <p class="text-xl mb-2">💰</p>
                    <p class="text-xs font-semibold text-fg-subtle">Wallet</p>
                    <p class="text-3xs text-fg-faint mt-0.5">Balances & transfers</p>
                </button>
                <button onclick={() => browserStore.createOrFocusTab("bucks://settings")}
                    class="p-4 rounded-2xl bg-surface-1 border border-line hover:bg-surface-3 transition-all text-left">
                    <p class="text-xl mb-2">⚙️</p>
                    <p class="text-xs font-semibold text-fg-subtle">Settings</p>
                    <p class="text-3xs text-fg-faint mt-0.5">Preferences & data</p>
                </button>
            </div>

            <button onclick={reset}
                class="text-2xs text-danger-fg/40 hover:text-danger-fg/70 transition-colors">
                Remove identity
            </button>
        </div>
    {/if}
</div>
