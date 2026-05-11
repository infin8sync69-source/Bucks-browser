<script lang="ts">
    import { fly, fade, scale } from "svelte/transition";
    import { cubicOut, elasticOut } from "svelte/easing";
    import { swarmStore } from "./swarmStore";
    import { browserStore } from "./stores";
    import { INTENT_LABELS } from "./intentMatcher";
    import type { IntentType } from "./intentMatcher";

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
    let weatherLoading= $state(false);
    let weatherData   = $state<{ temp: number; condition: string; humidity: number; wind: number } | null>(null);

    // nearby / product — use $derived so they update if props change
    let nearbyQuery  = $state("");
    let productQuery = $state("");
    $effect(() => { nearbyQuery  = data?.query ?? ""; });
    $effect(() => { productQuery = data?.query ?? ""; });

    // ── helpers ──────────────────────────────────────────────────────────────
    const intentMeta = $derived(INTENT_LABELS[type as NonNullable<IntentType>] ?? null);

    function close() {
        visible = false;
        setTimeout(() => onclose(), 400);
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

    // ── taxi actions ─────────────────────────────────────────────────────────
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

    function bookDriver(driver: (typeof MOCK_DRIVERS)[0]) {
        browserStore.createOrFocusTab("bucks://superapp");
        close();
    }

    // ── food actions ─────────────────────────────────────────────────────────
    const CUISINES = ["🍕 Pizza","🍜 Noodles","🍛 Curry","🥗 Salads","🍣 Sushi","🧆 Veg","🍔 Burger","🥙 Wraps"];

    async function searchRestaurants() {
        foodLoading = true;
        await new Promise(r => setTimeout(r, 800));
        foodLoading = false;
        browserStore.createOrFocusTab("bucks://superapp");
        close();
    }

    // ── payment actions ───────────────────────────────────────────────────────
    async function sendPayment() {
        if (!payTo || !payAmount) return;
        paySending = true;
        // Pass prefill to wallet page via sessionStorage, then open it
        try {
            sessionStorage.setItem("bucks_pay_prefill", JSON.stringify({
                to: payTo, amount: payAmount, note: payNote
            }));
        } catch {}
        await new Promise(r => setTimeout(r, 200));
        paySending = false;
        payDone = true;
        browserStore.createOrFocusTab("bucks://wallet");
        setTimeout(close, 900);
    }

    // ── weather actions ───────────────────────────────────────────────────────
    const WMO_CODES: Record<number, string> = {
        0: "Clear Sky", 1: "Mainly Clear", 2: "Partly Cloudy", 3: "Overcast",
        45: "Foggy", 48: "Icy Fog", 51: "Light Drizzle", 53: "Drizzle", 55: "Heavy Drizzle",
        61: "Light Rain", 63: "Rain", 65: "Heavy Rain", 71: "Light Snow", 73: "Snow", 75: "Heavy Snow",
        80: "Rain Showers", 81: "Heavy Showers", 95: "Thunderstorm", 96: "Hail Storm",
    };

    async function checkWeather() {
        weatherLoading = true;
        weatherData = null;
        try {
            const loc = weatherLoc.trim() || "London";
            // Geocode via Open-Meteo geocoding API (no key required)
            const geoRes = await fetch(
                `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(loc)}&count=1&language=en&format=json`
            );
            const geoJson = await geoRes.json();
            const place = geoJson.results?.[0];
            if (!place) throw new Error("Location not found");

            const { latitude, longitude } = place;
            const wxRes = await fetch(
                `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
                `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&wind_speed_unit=kmh&timezone=auto`
            );
            const wxJson = await wxRes.json();
            const cur = wxJson.current;
            weatherData = {
                temp: Math.round(cur.temperature_2m),
                condition: WMO_CODES[cur.weather_code] ?? "Unknown",
                humidity: cur.relative_humidity_2m,
                wind: Math.round(cur.wind_speed_10m),
            };
        } catch {
            weatherData = { temp: 0, condition: "Unavailable", humidity: 0, wind: 0 };
        } finally {
            weatherLoading = false;
        }
    }

    // ── ipfs action ───────────────────────────────────────────────────────────
    function openIpfs() {
        browserStore.createOrFocusTab("bucks://ipfs");
        close();
    }

    // ── product / nearby / news ───────────────────────────────────────────────
    function searchProduct() {
        browserStore.createTab(`https://duckduckgo.com/?q=${encodeURIComponent(productQuery + " buy")}`);
        close();
    }

    function searchNearby() {
        browserStore.createTab(`https://duckduckgo.com/?q=${encodeURIComponent(nearbyQuery + " near me")}`);
        close();
    }

    function searchNews() {
        browserStore.createTab(`https://duckduckgo.com/?q=${encodeURIComponent((data?.query ?? text ?? "news") + " latest news")}`);
        close();
    }
</script>

{#if visible}
<div
    class="fixed bottom-28 left-1/2 -translate-x-1/2 w-[22rem] z-[115]"
    in:fly={{ y: 60, duration: 500, easing: cubicOut }}
    out:fly={{ y: 40, duration: 300, easing: cubicOut }}
>
    <div class="bg-[#0d0d10]/95 backdrop-blur-3xl border border-white/10 rounded-3xl overflow-hidden shadow-[0_32px_80px_-12px_rgba(0,0,0,0.8)]">

        <!-- ── Header ─────────────────────────────────────────── -->
        <div class="px-4 py-3 flex items-center gap-2.5 border-b border-white/[0.06]">
            {#if intentMeta}
                <span class="text-lg leading-none">{intentMeta.emoji}</span>
                <div class="flex-1 min-w-0">
                    <p class="text-[11px] font-semibold text-white/80 leading-none">{intentMeta.label}</p>
                    <p class="text-[9px] text-white/30 mt-0.5">{intentMeta.description}</p>
                </div>
            {:else}
                <span class="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse shrink-0"></span>
                <p class="text-[10px] font-bold uppercase tracking-widest text-white/40 flex-1">Swarm Insight</p>
            {/if}
            <button onclick={close} aria-label="Close" class="text-white/20 hover:text-white/60 transition-colors p-1">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                </svg>
            </button>
        </div>

        <!-- ── Body ───────────────────────────────────────────── -->
        <div class="p-4 space-y-3">

            <!-- Short description text (from backend evaluation) -->
            {#if description}
                <p class="text-[12px] text-white/60 leading-relaxed">{description}</p>
            {/if}

            <!-- ━━ TAXI BOOKING ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ -->
            {#if type === "taxi_booking"}
                <div class="space-y-2">
                    <!-- Pickup -->
                    <div class="relative">
                        <div class="absolute left-3 top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-blue-400 ring-2 ring-blue-400/20"></div>
                        <input bind:value={taxiPickup} placeholder="Pickup location"
                            class="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl pl-8 pr-3 py-2.5 text-[12px] text-white placeholder-white/25 focus:outline-none focus:border-blue-500/40 transition-colors" />
                    </div>
                    <!-- Route connector -->
                    <div class="flex items-center gap-2 pl-3.5">
                        <div class="w-[1.5px] h-5 bg-white/10 rounded-full"></div>
                    </div>
                    <!-- Drop -->
                    <div class="relative">
                        <div class="absolute left-3 top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-md bg-emerald-400 ring-2 ring-emerald-400/20"></div>
                        <input bind:value={taxiDrop} placeholder="Drop location"
                            class="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl pl-8 pr-3 py-2.5 text-[12px] text-white placeholder-white/25 focus:outline-none focus:border-emerald-500/40 transition-colors" />
                    </div>

                    <!-- Ride type -->
                    <div class="flex gap-1.5 pt-1">
                        {#each (["economy","comfort","premium"] as const) as rt}
                            <button onclick={() => taxiRideType = rt}
                                class="flex-1 py-1.5 rounded-xl text-[10px] font-semibold uppercase tracking-wide transition-all
                                       {taxiRideType === rt
                                          ? 'bg-blue-500/20 border border-blue-500/40 text-blue-300'
                                          : 'bg-white/[0.03] border border-white/[0.06] text-white/30 hover:text-white/60'}">
                                {rt === 'economy' ? '🏎 Economy' : rt === 'comfort' ? '🚗 Comfort' : '✨ Premium'}
                            </button>
                        {/each}
                    </div>

                    <!-- Find button -->
                    <button onclick={findDrivers} disabled={!taxiPickup || !taxiDrop || taxiSearching}
                        class="w-full bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/25 text-emerald-300
                               rounded-xl py-2.5 text-[12px] font-semibold transition-all disabled:opacity-40 flex items-center justify-center gap-2">
                        {#if taxiSearching}
                            <div class="w-3.5 h-3.5 border border-emerald-400/40 border-t-emerald-400 rounded-full animate-spin"></div>
                            Searching drivers…
                        {:else}
                            🔍 Find Drivers
                        {/if}
                    </button>

                    <!-- Driver results -->
                    {#if taxiDrivers.length > 0}
                        <div class="space-y-1.5 pt-1" in:scale={{ duration: 300, start: 0.96, easing: cubicOut }}>
                            {#each taxiDrivers as driver}
                                <button onclick={() => bookDriver(driver)}
                                    class="w-full flex items-center gap-3 p-2.5 bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] rounded-xl transition-all group">
                                    <div class="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500/20 to-purple-500/20 flex items-center justify-center text-sm shrink-0">
                                        {driver.name[0]}
                                    </div>
                                    <div class="flex-1 text-left">
                                        <p class="text-[11px] font-semibold text-white/80">{driver.name}</p>
                                        <p class="text-[9px] text-white/30">⭐ {driver.rating} · {driver.eta} min away</p>
                                    </div>
                                    <div class="text-right">
                                        <p class="text-[11px] font-bold text-white/70">₹{driver.price}</p>
                                        <p class="text-[9px] text-emerald-400/60 group-hover:text-emerald-400 transition-colors">Book →</p>
                                    </div>
                                </button>
                            {/each}
                        </div>
                    {/if}
                </div>

            <!-- ━━ FOOD ORDER ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ -->
            {:else if type === "food_order"}
                <div class="space-y-3">
                    <div class="flex flex-wrap gap-1.5">
                        {#each CUISINES as c}
                            <button onclick={() => foodCuisine = (foodCuisine === c ? "" : c)}
                                class="px-2.5 py-1 rounded-full text-[10px] font-medium transition-all border
                                       {foodCuisine === c
                                          ? 'bg-orange-500/20 border-orange-500/40 text-orange-300'
                                          : 'bg-white/[0.03] border-white/[0.06] text-white/40 hover:text-white/70'}">
                                {c}
                            </button>
                        {/each}
                    </div>
                    <div class="relative">
                        <span class="absolute left-3 top-1/2 -translate-y-1/2 text-xs">📍</span>
                        <input bind:value={foodLocation} placeholder="Delivery location"
                            class="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl pl-8 pr-3 py-2.5 text-[12px] text-white placeholder-white/25 focus:outline-none focus:border-orange-500/30 transition-colors" />
                    </div>
                    <button onclick={searchRestaurants} disabled={foodLoading}
                        class="w-full bg-orange-500/15 hover:bg-orange-500/25 border border-orange-500/25 text-orange-300 rounded-xl py-2.5 text-[12px] font-semibold transition-all flex items-center justify-center gap-2">
                        {#if foodLoading}
                            <div class="w-3.5 h-3.5 border border-orange-400/40 border-t-orange-400 rounded-full animate-spin"></div>
                            Finding restaurants…
                        {:else}
                            🍽️ Search Restaurants
                        {/if}
                    </button>
                </div>

            <!-- ━━ PAYMENT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ -->
            {:else if type === "payment_send"}
                <div class="space-y-2.5">
                    {#if payDone}
                        <div class="text-center py-4" in:scale={{ duration: 400, easing: elasticOut, start: 0.7 }}>
                            <div class="text-4xl mb-2">✅</div>
                            <p class="text-sm font-semibold text-emerald-400">Sent ₹{payAmount}</p>
                            <p class="text-xs text-white/40 mt-1">to {payTo}</p>
                        </div>
                    {:else}
                        <input bind:value={payTo} placeholder="UPI / Phone / Wallet Address"
                            class="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-[12px] text-white placeholder-white/25 focus:outline-none focus:border-violet-500/40 transition-colors" />
                        <div class="relative">
                            <span class="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-white/30 font-bold">₹</span>
                            <input bind:value={payAmount} type="number" placeholder="Amount"
                                class="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl pl-7 pr-3 py-2.5 text-[12px] text-white placeholder-white/25 focus:outline-none focus:border-violet-500/40 transition-colors" />
                        </div>
                        <input bind:value={payNote} placeholder="Note (optional)"
                            class="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-[12px] text-white placeholder-white/25 focus:outline-none focus:border-violet-500/40 transition-colors" />
                        <button onclick={sendPayment} disabled={!payTo || !payAmount || paySending}
                            class="w-full bg-violet-500/15 hover:bg-violet-500/25 border border-violet-500/25 text-violet-300 rounded-xl py-2.5 text-[12px] font-semibold transition-all disabled:opacity-40 flex items-center justify-center gap-2">
                            {#if paySending}
                                <div class="w-3.5 h-3.5 border border-violet-400/40 border-t-violet-400 rounded-full animate-spin"></div>
                                Sending…
                            {:else}
                                💸 Send via Wallet
                            {/if}
                        </button>
                    {/if}
                </div>

            <!-- ━━ WEATHER ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ -->
            {:else if type === "weather_check"}
                <div class="space-y-3">
                    {#if weatherData}
                        <div class="bg-gradient-to-br from-sky-500/10 to-blue-600/5 border border-sky-500/15 rounded-2xl p-4 text-center" in:scale={{ duration: 400, easing: cubicOut, start: 0.95 }}>
                            <p class="text-5xl mb-2">🌤️</p>
                            <p class="text-3xl font-light text-white">{weatherData.temp}°C</p>
                            <p class="text-[11px] text-sky-300/70 mt-1">{weatherData.condition}</p>
                            <div class="flex justify-center gap-4 mt-3 text-[10px] text-white/30">
                                <span>💧 {weatherData.humidity}%</span>
                                <span>💨 {weatherData.wind} km/h</span>
                            </div>
                        </div>
                    {:else}
                        <div class="relative">
                            <span class="absolute left-3 top-1/2 -translate-y-1/2 text-xs">📍</span>
                            <input bind:value={weatherLoc} placeholder="Location"
                                class="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl pl-8 pr-3 py-2.5 text-[12px] text-white placeholder-white/25 focus:outline-none focus:border-sky-500/30 transition-colors" />
                        </div>
                        <button onclick={checkWeather} disabled={weatherLoading}
                            class="w-full bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/25 text-sky-300 rounded-xl py-2.5 text-[12px] font-semibold transition-all flex items-center justify-center gap-2">
                            {#if weatherLoading}
                                <div class="w-3.5 h-3.5 border border-sky-400/40 border-t-sky-400 rounded-full animate-spin"></div>
                                Checking…
                            {:else}
                                🌤️ Check Weather
                            {/if}
                        </button>
                    {/if}
                </div>

            <!-- ━━ IPFS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ -->
            {:else if type === "ipfs_action"}
                <div class="space-y-2">
                    <div class="flex gap-2">
                        <button onclick={openIpfs}
                            class="flex-1 bg-blue-500/15 hover:bg-blue-500/25 border border-blue-500/25 text-blue-300 rounded-xl py-2.5 text-[11px] font-semibold transition-all">
                            🌐 Open IPFS Dashboard
                        </button>
                    </div>
                </div>

            <!-- ━━ PRODUCT SEARCH ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ -->
            {:else if type === "product_search"}
                <div class="space-y-2.5">
                    <input bind:value={productQuery} placeholder="What are you looking for?"
                        class="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-[12px] text-white placeholder-white/25 focus:outline-none focus:border-amber-500/30 transition-colors" />
                    <button onclick={searchProduct}
                        class="w-full bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/25 text-amber-300 rounded-xl py-2.5 text-[12px] font-semibold transition-all">
                        🛍️ Find Best Prices
                    </button>
                </div>

            <!-- ━━ NEARBY SEARCH ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ -->
            {:else if type === "nearby_search"}
                <div class="space-y-2.5">
                    <input bind:value={nearbyQuery} placeholder="What are you looking for nearby?"
                        class="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-[12px] text-white placeholder-white/25 focus:outline-none focus:border-emerald-500/30 transition-colors" />
                    <button onclick={searchNearby}
                        class="w-full bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/25 text-emerald-300 rounded-xl py-2.5 text-[12px] font-semibold transition-all">
                        📍 Search Nearby
                    </button>
                </div>

            <!-- ━━ NEWS / RESEARCH ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ -->
            {:else if type === "news_search"}
                <div class="space-y-2.5">
                    <button onclick={searchNews}
                        class="w-full bg-zinc-500/15 hover:bg-zinc-500/25 border border-zinc-500/25 text-zinc-300 rounded-xl py-2.5 text-[12px] font-semibold transition-all">
                        📰 Search Latest News
                    </button>
                </div>

            <!-- ━━ NAVIGATE / SEARCH (legacy) ━━━━━━━━━━━━━━━━━━━ -->
            {:else if type === "navigate" || type === "search"}
                <a href={url || "#"} target="_blank" rel="noopener noreferrer"
                    class="flex items-center gap-3 p-2.5 bg-blue-500/5 rounded-xl border border-blue-500/10 hover:border-blue-500/20 transition-all group no-underline">
                    <div class="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-400">
                        {#if type === "navigate"}
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3"/></svg>
                        {:else}
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
                        {/if}
                    </div>
                    <div class="flex-1 min-w-0">
                        <p class="text-[9px] text-white/30 uppercase tracking-tighter">{type === "navigate" ? "Open" : "Search"}</p>
                        <p class="text-xs text-blue-300 font-medium truncate">{url || text || "Link"}</p>
                    </div>
                </a>

            <!-- ━━ CODE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ -->
            {:else if type === "code"}
                <pre class="text-[10px] font-mono text-emerald-300/80 bg-black/40 rounded-xl p-3 overflow-x-auto whitespace-pre-wrap border border-white/5">{text || content}</pre>

            <!-- ━━ PLAIN TEXT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ -->
            {:else if description && !intentMeta}
                <!-- already rendered above -->
            {/if}

        </div>

        <!-- ── IPFS verifiable footer ───────────────────────── -->
        {#if cid}
            <div class="px-4 py-2 border-t border-white/[0.05] bg-cyan-400/[0.02] flex items-center justify-between">
                <span class="text-[8px] text-cyan-400/40 uppercase font-bold tracking-[0.2em]">Verified Fragment</span>
                <a href="https://ipfs.io/ipfs/{cid}" target="_blank"
                    class="text-[10px] font-mono text-cyan-300/50 hover:text-cyan-200 flex items-center gap-1">
                    {cid.slice(0,4)}…{cid.slice(-4)} ↗
                </a>
            </div>
        {/if}

        <!-- ── Feedback ────────────────────────────────────── -->
        {#if taskId && !showCorrection}
            <div class="px-3 py-2 flex items-center justify-end gap-2 border-t border-white/[0.05]">
                <span class="text-[8px] text-white/20 uppercase tracking-widest mr-auto pl-1">Teach Agent</span>
                <button onclick={() => handleFeedback(1)} aria-label="Good response"
                    class="p-1.5 rounded-md hover:bg-emerald-500/10 transition-colors {feedbackScore===1 ? 'text-emerald-400 bg-emerald-500/10' : 'text-white/20'}">
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                </button>
                <button onclick={() => handleFeedback(-1)} aria-label="Bad response"
                    class="p-1.5 rounded-md hover:bg-rose-500/10 transition-colors {feedbackScore===-1 ? 'text-rose-400 bg-rose-500/10' : 'text-white/20'}">
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                </button>
            </div>
        {:else if showCorrection}
            <div class="p-3 border-t border-white/[0.05]" in:scale={{ duration: 200, start: 0.95 }}>
                <textarea bind:value={correctionText} placeholder="What should it have done?"
                    class="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-[10px] text-white/80 placeholder:text-white/20 focus:outline-none focus:border-rose-500/40 resize-none h-16"></textarea>
                <div class="flex justify-end gap-2 mt-2">
                    <button onclick={() => showCorrection = false} class="px-2 py-1 text-[9px] text-white/40 hover:text-white/60">Cancel</button>
                    <button onclick={submitCorrection} class="px-3 py-1 bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 text-[9px] rounded-md transition-colors">Submit</button>
                </div>
            </div>
        {/if}

    </div>
</div>
{/if}
