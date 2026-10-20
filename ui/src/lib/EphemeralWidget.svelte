<script lang="ts">
    import { duration as motion } from '$design/dist/tokens.js';
    import { fly, fade, scale } from "svelte/transition";
    import { cubicOut, elasticOut } from "svelte/easing";
    import { swarmStore } from "./swarmStore";
    import { browserStore } from "./stores";
    import { settingsStore } from "./settingsStore";
    import { onMount } from "svelte";
    import { pushOverlay, popOverlay } from "./uiState";
    import { INTENT_LABELS } from "./intentMatcher";
    import type { IntentType } from "./intentMatcher";
    import { X, Navigation, Search, Zap, Globe, Package, MapPin, Newspaper, Code2, Cloud } from "lucide-svelte";

    let {
        type = "text",
        content = "",
        description = "",
        selector = "",
        text = "",
        url = "",
        language = "javascript",
        taskId = null as string | null,
        cid = null as string | null,
        data = null as any,
        onclose = () => {},
    } = $props();

    // ── local state ──────────────────────────────────────────────────────────
    let visible = $state(true);
    let feedbackScore = $state<number | null>(null);
    let showCorrection = $state(false);
    let correctionText = $state("");

    // taxi
    let taxiPickup    = $state("");
    let taxiDrop      = $state("");
    let taxiRideType  = $state<"economy"|"comfort"|"premium">("economy");
    let taxiSearching = $state(false);
    let taxiDrivers   = $state<{ name: string; rating: number; eta: number; price: number }[]>([]);

    // food
    let foodCuisine   = $state("");
    let foodLocation  = $state("Current Location");
    let foodLoading   = $state(false);

    // payment
    let payTo         = $state("");
    let payAmount     = $state("");
    let payNote       = $state("");
    let paySending    = $state(false);
    let payDone       = $state(false);

    // weather
    let weatherLoc    = $state("Current Location");

    let nearbyQuery  = $state("");
    let productQuery = $state("");
    $effect(() => { nearbyQuery  = data?.query ?? ""; });
    $effect(() => { productQuery = data?.query ?? ""; });

    // The widget is a full-screen modal: hide the native web view while it is mounted.
    onMount(() => {
        pushOverlay();
        return popOverlay;
    });

    // ── helpers ──────────────────────────────────────────────────────────────
    const intentMeta = $derived(INTENT_LABELS[type as NonNullable<IntentType>] ?? null);

    function close() {
        visible = false;
        setTimeout(() => onclose(), 350);
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === "Escape") close();
    }

    function handleFeedback(score: number) {
        if (!taskId) return;
        feedbackScore = score;
        if (score === 1) swarmStore.sendFeedback(taskId, 1);
        else showCorrection = true;
    }

    function submitCorrection() {
        if (!taskId) return;
        swarmStore.sendFeedback(taskId, -1, correctionText);
        showCorrection = false;
        correctionText = "";
    }

    // ── taxi ─────────────────────────────────────────────────────────────────
    const RIDE_PRICES = { economy: 89, comfort: 149, premium: 249 };
    const MOCK_DRIVERS = [
        { name: "Rajesh K.",  rating: 4.8, eta: 3,  price: 0 },
        { name: "Mohan S.",   rating: 4.6, eta: 5,  price: 0 },
        { name: "Anil V.",    rating: 4.9, eta: 7,  price: 0 },
    ];

    async function findDrivers() {
        if (!taxiPickup.trim() || !taxiDrop.trim()) return;
        taxiSearching = true;
        taxiDrivers   = [];
        await new Promise(r => setTimeout(r, 1400));
        taxiDrivers = MOCK_DRIVERS.map(d => ({
            ...d,
            price: RIDE_PRICES[taxiRideType] + Math.floor(Math.random() * 30),
        }));
        taxiSearching = false;
    }

    function bookDriver(_driver: typeof MOCK_DRIVERS[0]) {
        browserStore.createOrFocusTab("bucks://superapp");
        close();
    }

    // ── food ─────────────────────────────────────────────────────────────────
    const CUISINES = ["🍕 Pizza","🍜 Noodles","🍛 Curry","🥗 Salads","🍣 Sushi","🧆 Veg","🍔 Burger","🥙 Wraps"];

    async function searchRestaurants() {
        foodLoading = true;
        await new Promise(r => setTimeout(r, 800));
        foodLoading = false;
        browserStore.createOrFocusTab("bucks://superapp");
        close();
    }

    // ── payment ───────────────────────────────────────────────────────────────
    async function sendPayment() {
        if (!payTo || !payAmount) return;
        paySending = true;
        try {
            sessionStorage.setItem("bucks_pay_prefill", JSON.stringify({ to: payTo, amount: payAmount, note: payNote }));
        } catch {}
        await new Promise(r => setTimeout(r, 200));
        paySending = false;
        payDone = true;
        browserStore.createOrFocusTab("bucks://wallet");
        setTimeout(close, 900);
    }

    // ── weather ───────────────────────────────────────────────────────────────
    // The chrome may only talk to local services (CSP), so the forecast is a web search.
    function checkWeather() {
        const loc = weatherLoc.trim();
        const q = !loc || loc === "Current Location" ? "weather" : `weather in ${loc}`;
        browserStore.createTab(settingsStore.searchUrl(q));
        close();
    }

    function openIpfs() { browserStore.createOrFocusTab("bucks://ipfs"); close(); }
    function searchProduct() { browserStore.createTab(settingsStore.searchUrl(productQuery + " buy")); close(); }
    function searchNearby() { browserStore.createTab(settingsStore.searchUrl(nearbyQuery + " near me")); close(); }
    function searchNews() { browserStore.createTab(settingsStore.searchUrl((data?.query ?? text ?? "news") + " latest news")); close(); }

    // accent colour per widget type
    const ACCENT: Record<string, string> = {
        taxi_booking:   "violet",
        food_order:     "orange",
        payment_send:   "emerald",
        weather_check:  "sky",
        ipfs_action:    "cyan",
        product_search: "amber",
        nearby_search:  "emerald",
        news_search:    "zinc",
        navigate:       "blue",
        search:         "blue",
        code:           "emerald",
    };
    const accent = $derived(ACCENT[type] ?? "violet");
</script>

<svelte:window onkeydown={handleKeydown} />

{#if visible}
    <!-- Backdrop -->
    <div
        class="fixed inset-0 z-modal-backdrop bg-scrim/50 backdrop-blur-sm"
        transition:fade={{ duration: motion.base }}
        onclick={close}
        role="presentation"
    ></div>

    <!-- Modal wrapper — centers vertically, avoids Header and AgenticBar -->
    <div
        class="fixed inset-0 z-modal flex items-center justify-center px-4 pointer-events-none"
        style="padding-top: 5.5rem; padding-bottom: 6rem;"
    >
        <div
            class="pointer-events-auto w-full max-w-[500px] bg-surface-raised/98 backdrop-blur-3xl border border-line-strong rounded-2xl overflow-hidden shadow-dialog"
            in:fly={{ y: 24, duration: motion.moderate, easing: cubicOut }}
            out:fly={{ y: 12, duration: motion.base, easing: cubicOut }}
            role="dialog"
            aria-modal="true"
        >
            <!-- ── Header ──────────────────────────────────────────────────── -->
            <div class="flex items-center gap-3 px-5 py-4 border-b border-line">
                <!-- Icon badge -->
                <div class="w-9 h-9 rounded-xl flex items-center justify-center shrink-0
                            bg-{accent}-500/10 border border-{accent}-500/20">
                    {#if type === "taxi_booking"}         <span class="text-lg">🚕</span>
                    {:else if type === "food_order"}      <span class="text-lg">🍕</span>
                    {:else if type === "payment_send"}    <span class="text-lg">💸</span>
                    {:else if type === "weather_check"}   <Cloud size={16} class="text-info-fg" />
                    {:else if type === "ipfs_action"}     <Globe size={16} class="text-cat-cyan-fg" />
                    {:else if type === "product_search"}  <Package size={16} class="text-warning-fg" />
                    {:else if type === "nearby_search"}   <MapPin size={16} class="text-success-fg" />
                    {:else if type === "news_search"}     <Newspaper size={16} class="text-fg-subtle" />
                    {:else if type === "navigate"}        <Navigation size={16} class="text-accent-fg" />
                    {:else if type === "search"}          <Search size={16} class="text-accent-fg" />
                    {:else if type === "code"}            <Code2 size={16} class="text-success-fg" />
                    {:else}                               <Zap size={16} class="text-agent-fg" />
                    {/if}
                </div>

                <div class="flex-1 min-w-0">
                    {#if intentMeta}
                        <p class="text-sm font-semibold text-fg leading-none">{intentMeta.label}</p>
                        <p class="text-3xs text-fg-faint mt-1 leading-none">{intentMeta.description}</p>
                    {:else}
                        <p class="text-sm font-semibold text-fg leading-none">Bucks Agent</p>
                        <p class="text-3xs text-fg-faint mt-1 leading-none">Action ready</p>
                    {/if}
                </div>

                <button
                    onclick={close}
                    aria-label="Close"
                    class="w-7 h-7 rounded-lg flex items-center justify-center text-fg-faint hover:text-fg-muted hover:bg-surface-3 transition-all"
                >
                    <X size={14} />
                </button>
            </div>

            <!-- ── Body ───────────────────────────────────────────────────── -->
            <div class="p-5 space-y-3 max-h-[60vh] overflow-y-auto" style="scrollbar-width:thin;scrollbar-color:var(--bucks-color-surface-3) transparent;">

                {#if description}
                    <p class="text-sm text-fg-subtle leading-relaxed">{description}</p>
                {/if}

                <!-- TAXI -->
                {#if type === "taxi_booking"}
                    <div class="space-y-2.5">
                        <div class="relative">
                            <div class="absolute left-3 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-accent ring-2 ring-accent/20"></div>
                            <input bind:value={taxiPickup} placeholder="Pickup location"
                                class="w-full bg-surface-2 border border-line rounded-xl pl-8 pr-3 py-2.5 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-accent/50 transition-colors" />
                        </div>
                        <div class="pl-3.5"><div class="w-[1px] h-4 bg-surface-4 rounded-full ml-0.75"></div></div>
                        <div class="relative">
                            <div class="absolute left-3 top-1/2 -translate-y-1/2 w-2 h-2 rounded-md bg-success ring-2 ring-success/20"></div>
                            <input bind:value={taxiDrop} placeholder="Drop location"
                                class="w-full bg-surface-2 border border-line rounded-xl pl-8 pr-3 py-2.5 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-success/50 transition-colors" />
                        </div>
                        <div class="flex gap-2 pt-1">
                            {#each (["economy","comfort","premium"] as const) as rt}
                                <button onclick={() => taxiRideType = rt}
                                    class="flex-1 py-2 rounded-xl text-2xs font-semibold transition-all
                                           {taxiRideType === rt ? 'bg-agent/15 border border-agent/30 text-agent-fg-strong' : 'bg-surface-1 border border-line text-fg-faint hover:text-fg-subtle'}">
                                    {rt === 'economy' ? '🏎 Economy' : rt === 'comfort' ? '🚗 Comfort' : '✨ Premium'}
                                </button>
                            {/each}
                        </div>
                        <button onclick={findDrivers} disabled={!taxiPickup || !taxiDrop || taxiSearching}
                            class="w-full bg-agent/12 hover:bg-agent/20 border border-agent/25 text-agent-fg-strong rounded-xl py-2.5 text-sm font-semibold transition-all disabled:opacity-40 flex items-center justify-center gap-2">
                            {#if taxiSearching}
                                <div class="w-3.5 h-3.5 border border-agent/40 border-t-agent rounded-full animate-spin"></div>
                                Searching drivers…
                            {:else}
                                Find Drivers
                            {/if}
                        </button>
                        {#if taxiDrivers.length > 0}
                            <div class="space-y-1.5" in:scale={{ duration: motion.moderate, start: 0.97, easing: cubicOut }}>
                                {#each taxiDrivers as driver}
                                    <button onclick={() => bookDriver(driver)}
                                        class="w-full flex items-center gap-3 p-3 bg-surface-1 hover:bg-surface-3 border border-line rounded-xl transition-all">
                                        <div class="w-9 h-9 rounded-full bg-gradient-to-br from-agent/20 to-cat-indigo/20 flex items-center justify-center text-md font-semibold text-fg-subtle shrink-0">{driver.name[0]}</div>
                                        <div class="flex-1 text-left">
                                            <p class="text-xs font-semibold text-fg-muted">{driver.name}</p>
                                            <p class="text-3xs text-fg-faint mt-0.5">⭐ {driver.rating} · {driver.eta} min away</p>
                                        </div>
                                        <div class="text-right">
                                            <p class="text-sm font-bold text-fg-muted">₹{driver.price}</p>
                                            <p class="text-3xs text-success-fg/70 mt-0.5">Book →</p>
                                        </div>
                                    </button>
                                {/each}
                            </div>
                        {/if}
                    </div>

                <!-- FOOD -->
                {:else if type === "food_order"}
                    <div class="space-y-3">
                        <div class="flex flex-wrap gap-1.5">
                            {#each CUISINES as c}
                                <button onclick={() => foodCuisine = (foodCuisine === c ? "" : c)}
                                    class="px-2.5 py-1 rounded-full text-2xs font-medium transition-all border
                                           {foodCuisine === c ? 'bg-cat-orange/15 border-cat-orange/30 text-cat-orange-fg' : 'bg-surface-1 border-line text-fg-faint hover:text-fg-muted'}">
                                    {c}
                                </button>
                            {/each}
                        </div>
                        <div class="relative">
                            <span class="absolute left-3 top-1/2 -translate-y-1/2 text-xs">📍</span>
                            <input bind:value={foodLocation} placeholder="Delivery location"
                                class="w-full bg-surface-2 border border-line rounded-xl pl-8 pr-3 py-2.5 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-cat-orange/40 transition-colors" />
                        </div>
                        <button onclick={searchRestaurants} disabled={foodLoading}
                            class="w-full bg-cat-orange/12 hover:bg-cat-orange/20 border border-cat-orange/25 text-cat-orange-fg rounded-xl py-2.5 text-sm font-semibold transition-all flex items-center justify-center gap-2">
                            {#if foodLoading}
                                <div class="w-3.5 h-3.5 border border-cat-orange/40 border-t-cat-orange rounded-full animate-spin"></div>
                                Finding restaurants…
                            {:else}
                                🍽️ Search Restaurants
                            {/if}
                        </button>
                    </div>

                <!-- PAYMENT -->
                {:else if type === "payment_send"}
                    <div class="space-y-2.5">
                        {#if payDone}
                            <div class="text-center py-6" in:scale={{ duration: motion.moderate, easing: elasticOut, start: 0.7 }}>
                                <div class="text-5xl mb-3">✅</div>
                                <p class="text-base font-semibold text-success-fg">Sent ₹{payAmount}</p>
                                <p class="text-xs text-fg-faint mt-1.5">Opening wallet for {payTo}</p>
                            </div>
                        {:else}
                            <input bind:value={payTo} placeholder="UPI / Phone / Wallet Address"
                                class="w-full bg-surface-2 border border-line rounded-xl px-3 py-2.5 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-agent/40 transition-colors" />
                            <div class="relative">
                                <span class="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-fg-faint font-bold">₹</span>
                                <input bind:value={payAmount} type="number" placeholder="Amount"
                                    class="w-full bg-surface-2 border border-line rounded-xl pl-7 pr-3 py-2.5 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-agent/40 transition-colors" />
                            </div>
                            <input bind:value={payNote} placeholder="Note (optional)"
                                class="w-full bg-surface-2 border border-line rounded-xl px-3 py-2.5 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-agent/40 transition-colors" />
                            <button onclick={sendPayment} disabled={!payTo || !payAmount || paySending}
                                class="w-full bg-agent/12 hover:bg-agent/20 border border-agent/25 text-agent-fg-strong rounded-xl py-2.5 text-sm font-semibold transition-all disabled:opacity-40 flex items-center justify-center gap-2">
                                {#if paySending}
                                    <div class="w-3.5 h-3.5 border border-agent/40 border-t-agent rounded-full animate-spin"></div>
                                    Sending…
                                {:else}
                                    💸 Send via Wallet
                                {/if}
                            </button>
                        {/if}
                    </div>

                <!-- WEATHER -->
                {:else if type === "weather_check"}
                    <div class="space-y-3">
                            <div class="relative">
                                <span class="absolute left-3 top-1/2 -translate-y-1/2 text-xs">📍</span>
                                <input bind:value={weatherLoc} placeholder="City or location"
                                    class="w-full bg-surface-2 border border-line rounded-xl pl-8 pr-3 py-2.5 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-info/40 transition-colors" />
                            </div>
                            <button onclick={checkWeather}
                                class="w-full bg-info/12 hover:bg-info/20 border border-info/25 text-info-fg-strong rounded-xl py-2.5 text-sm font-semibold transition-all flex items-center justify-center gap-2">
                                🌤️ Search Weather
                            </button>
                    </div>

                <!-- IPFS -->
                {:else if type === "ipfs_action"}
                    <button onclick={openIpfs}
                        class="w-full bg-cat-cyan/12 hover:bg-cat-cyan/20 border border-cat-cyan/25 text-cat-cyan-fg rounded-xl py-2.5 text-sm font-semibold transition-all">
                        🌐 Open IPFS Dashboard
                    </button>

                <!-- PRODUCT -->
                {:else if type === "product_search"}
                    <div class="space-y-2.5">
                        <input bind:value={productQuery} placeholder="What are you looking for?"
                            class="w-full bg-surface-2 border border-line rounded-xl px-3 py-2.5 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-warning/40 transition-colors" />
                        <button onclick={searchProduct}
                            class="w-full bg-warning/12 hover:bg-warning/20 border border-warning/25 text-warning-fg-strong rounded-xl py-2.5 text-sm font-semibold transition-all">
                            🛍️ Find Best Prices
                        </button>
                    </div>

                <!-- NEARBY -->
                {:else if type === "nearby_search"}
                    <div class="space-y-2.5">
                        <input bind:value={nearbyQuery} placeholder="What are you looking for nearby?"
                            class="w-full bg-surface-2 border border-line rounded-xl px-3 py-2.5 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-success/40 transition-colors" />
                        <button onclick={searchNearby}
                            class="w-full bg-success/12 hover:bg-success/20 border border-success/25 text-success-fg-strong rounded-xl py-2.5 text-sm font-semibold transition-all">
                            📍 Search Nearby
                        </button>
                    </div>

                <!-- NEWS -->
                {:else if type === "news_search"}
                    <button onclick={searchNews}
                        class="w-full bg-surface-3 hover:bg-surface-3 border border-line-emphasis/25 text-fg-muted rounded-xl py-2.5 text-sm font-semibold transition-all">
                        📰 Search Latest News
                    </button>

                <!-- NAVIGATE / SEARCH -->
                {:else if type === "navigate" || type === "search"}
                    <a href={url || "#"} target="_blank" rel="noopener noreferrer"
                        class="flex items-center gap-3 p-3.5 bg-accent/5 rounded-xl border border-accent/15 hover:border-accent/30 transition-all no-underline">
                        <div class="w-9 h-9 rounded-xl bg-accent/10 flex items-center justify-center shrink-0">
                            {#if type === "navigate"}
                                <Navigation size={16} class="text-accent-fg" />
                            {:else}
                                <Search size={16} class="text-accent-fg" />
                            {/if}
                        </div>
                        <div class="flex-1 min-w-0">
                            <p class="text-3xs text-fg-faint uppercase tracking-wide">{type === "navigate" ? "Navigate to" : "Search"}</p>
                            <p class="text-sm text-accent-fg-strong font-medium truncate mt-0.5">{url || text || "Link"}</p>
                        </div>
                    </a>

                <!-- CODE -->
                {:else if type === "code"}
                    <pre class="text-2xs font-mono text-success-fg-strong/80 bg-scrim/50 rounded-xl p-4 overflow-x-auto whitespace-pre-wrap border border-line-subtle max-h-64">{text || content}</pre>

                {/if}
            </div>

            <!-- ── IPFS verified footer ──────────────────────────────────── -->
            {#if cid}
                <div class="px-5 py-2.5 border-t border-line-subtle bg-cat-cyan/2 flex items-center justify-between">
                    <span class="text-3xs text-cat-cyan-fg/40 uppercase font-bold tracking-caps">Verified Fragment</span>
                    <a href="https://ipfs.io/ipfs/{cid}" target="_blank"
                        class="text-2xs font-mono text-cat-cyan-fg/50 hover:text-cat-cyan-fg flex items-center gap-1">
                        {cid.slice(0,6)}…{cid.slice(-4)} ↗
                    </a>
                </div>
            {/if}

            <!-- ── Feedback ─────────────────────────────────────────────── -->
            {#if taskId && !showCorrection}
                <div class="px-5 py-3 flex items-center gap-2 border-t border-line-subtle">
                    <span class="text-3xs text-fg-disabled uppercase tracking-widest flex-1">Was this helpful?</span>
                    <button onclick={() => handleFeedback(1)} aria-label="Good"
                        class="px-3 py-1.5 rounded-lg text-2xs font-medium transition-all {feedbackScore===1 ? 'bg-success/15 text-success-fg-strong border border-success/25' : 'text-fg-faint hover:text-fg-subtle hover:bg-surface-2'}">
                        👍 Yes
                    </button>
                    <button onclick={() => handleFeedback(-1)} aria-label="No"
                        class="px-3 py-1.5 rounded-lg text-2xs font-medium transition-all {feedbackScore===-1 ? 'bg-cat-rose/15 text-cat-rose-fg border border-cat-rose/25' : 'text-fg-faint hover:text-fg-subtle hover:bg-surface-2'}">
                        👎 No
                    </button>
                </div>
            {:else if showCorrection}
                <div class="p-4 border-t border-line-subtle" in:scale={{ duration: motion.base, start: 0.95 }}>
                    <textarea bind:value={correctionText} placeholder="What should it have done?"
                        class="w-full bg-scrim/40 border border-line rounded-xl p-3 text-xs text-fg-muted placeholder:text-fg-faint focus:outline-none focus:border-cat-rose/40 resize-none h-20"></textarea>
                    <div class="flex justify-end gap-2 mt-2.5">
                        <button onclick={() => showCorrection = false} class="px-3 py-1.5 text-2xs text-fg-faint hover:text-fg-subtle">Cancel</button>
                        <button onclick={submitCorrection} class="px-4 py-1.5 bg-cat-rose/15 hover:bg-cat-rose/25 text-cat-rose-fg text-2xs rounded-lg transition-colors border border-cat-rose/20">Submit</button>
                    </div>
                </div>
            {/if}

        </div>
    </div>
{/if}
