<script lang="ts">
    import { fly, fade, scale } from "svelte/transition";
    import { cubicOut, elasticOut } from "svelte/easing";
    import { swarmStore } from "./swarmStore";
    import { browserStore } from "./stores";
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
    let weatherLoading= $state(false);
    let weatherData   = $state<{ temp: number; condition: string; humidity: number; wind: number } | null>(null);

    let nearbyQuery  = $state("");
    let productQuery = $state("");
    $effect(() => { nearbyQuery  = data?.query ?? ""; });
    $effect(() => { productQuery = data?.query ?? ""; });

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
            const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(loc)}&count=1&language=en&format=json`);
            const geoJson = await geoRes.json();
            const place = geoJson.results?.[0];
            if (!place) throw new Error("Location not found");
            const { latitude, longitude } = place;
            const wxRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&wind_speed_unit=kmh&timezone=auto`);
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

    function openIpfs() { browserStore.createOrFocusTab("bucks://ipfs"); close(); }
    function searchProduct() { browserStore.createTab(`https://duckduckgo.com/?q=${encodeURIComponent(productQuery + " buy")}`); close(); }
    function searchNearby() { browserStore.createTab(`https://duckduckgo.com/?q=${encodeURIComponent(nearbyQuery + " near me")}`); close(); }
    function searchNews() { browserStore.createTab(`https://duckduckgo.com/?q=${encodeURIComponent((data?.query ?? text ?? "news") + " latest news")}`); close(); }

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
        class="fixed inset-0 z-[498] bg-black/50 backdrop-blur-[6px]"
        transition:fade={{ duration: 200 }}
        onclick={close}
        role="presentation"
    ></div>

    <!-- Modal wrapper — centers vertically, avoids Header and AgenticBar -->
    <div
        class="fixed inset-0 z-[499] flex items-center justify-center px-4 pointer-events-none"
        style="padding-top: 5.5rem; padding-bottom: 6rem;"
    >
        <div
            class="pointer-events-auto w-full max-w-[500px] bg-[#0c0c10]/98 backdrop-blur-3xl border border-white/[0.09] rounded-2xl overflow-hidden shadow-[0_48px_120px_-20px_rgba(0,0,0,0.95),0_0_0_1px_rgba(255,255,255,0.04)]"
            in:fly={{ y: 24, duration: 380, easing: cubicOut }}
            out:fly={{ y: 12, duration: 240, easing: cubicOut }}
            role="dialog"
            aria-modal="true"
        >
            <!-- ── Header ──────────────────────────────────────────────────── -->
            <div class="flex items-center gap-3 px-5 py-4 border-b border-white/[0.06]">
                <!-- Icon badge -->
                <div class="w-9 h-9 rounded-xl flex items-center justify-center shrink-0
                            bg-{accent}-500/10 border border-{accent}-500/20">
                    {#if type === "taxi_booking"}         <span class="text-lg">🚕</span>
                    {:else if type === "food_order"}      <span class="text-lg">🍕</span>
                    {:else if type === "payment_send"}    <span class="text-lg">💸</span>
                    {:else if type === "weather_check"}   <Cloud size={16} class="text-sky-400" />
                    {:else if type === "ipfs_action"}     <Globe size={16} class="text-cyan-400" />
                    {:else if type === "product_search"}  <Package size={16} class="text-amber-400" />
                    {:else if type === "nearby_search"}   <MapPin size={16} class="text-emerald-400" />
                    {:else if type === "news_search"}     <Newspaper size={16} class="text-zinc-400" />
                    {:else if type === "navigate"}        <Navigation size={16} class="text-blue-400" />
                    {:else if type === "search"}          <Search size={16} class="text-blue-400" />
                    {:else if type === "code"}            <Code2 size={16} class="text-emerald-400" />
                    {:else}                               <Zap size={16} class="text-violet-400" />
                    {/if}
                </div>

                <div class="flex-1 min-w-0">
                    {#if intentMeta}
                        <p class="text-[13px] font-semibold text-white/90 leading-none">{intentMeta.label}</p>
                        <p class="text-[10px] text-white/35 mt-1 leading-none">{intentMeta.description}</p>
                    {:else}
                        <p class="text-[13px] font-semibold text-white/90 leading-none">Bucks Agent</p>
                        <p class="text-[10px] text-white/35 mt-1 leading-none">Action ready</p>
                    {/if}
                </div>

                <button
                    onclick={close}
                    aria-label="Close"
                    class="w-7 h-7 rounded-lg flex items-center justify-center text-white/25 hover:text-white/70 hover:bg-white/[0.06] transition-all"
                >
                    <X size={14} />
                </button>
            </div>

            <!-- ── Body ───────────────────────────────────────────────────── -->
            <div class="p-5 space-y-3 max-h-[60vh] overflow-y-auto" style="scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.06) transparent;">

                {#if description}
                    <p class="text-[13px] text-white/55 leading-relaxed">{description}</p>
                {/if}

                <!-- TAXI -->
                {#if type === "taxi_booking"}
                    <div class="space-y-2.5">
                        <div class="relative">
                            <div class="absolute left-3 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-blue-400 ring-2 ring-blue-400/20"></div>
                            <input bind:value={taxiPickup} placeholder="Pickup location"
                                class="w-full bg-white/[0.04] border border-white/[0.07] rounded-xl pl-8 pr-3 py-2.5 text-[13px] text-white placeholder-white/20 focus:outline-none focus:border-blue-500/50 transition-colors" />
                        </div>
                        <div class="pl-3.5"><div class="w-[1px] h-4 bg-white/10 rounded-full ml-[3px]"></div></div>
                        <div class="relative">
                            <div class="absolute left-3 top-1/2 -translate-y-1/2 w-2 h-2 rounded-md bg-emerald-400 ring-2 ring-emerald-400/20"></div>
                            <input bind:value={taxiDrop} placeholder="Drop location"
                                class="w-full bg-white/[0.04] border border-white/[0.07] rounded-xl pl-8 pr-3 py-2.5 text-[13px] text-white placeholder-white/20 focus:outline-none focus:border-emerald-500/50 transition-colors" />
                        </div>
                        <div class="flex gap-2 pt-1">
                            {#each (["economy","comfort","premium"] as const) as rt}
                                <button onclick={() => taxiRideType = rt}
                                    class="flex-1 py-2 rounded-xl text-[11px] font-semibold transition-all
                                           {taxiRideType === rt ? 'bg-violet-500/15 border border-violet-500/30 text-violet-300' : 'bg-white/[0.03] border border-white/[0.06] text-white/30 hover:text-white/60'}">
                                    {rt === 'economy' ? '🏎 Economy' : rt === 'comfort' ? '🚗 Comfort' : '✨ Premium'}
                                </button>
                            {/each}
                        </div>
                        <button onclick={findDrivers} disabled={!taxiPickup || !taxiDrop || taxiSearching}
                            class="w-full bg-violet-500/12 hover:bg-violet-500/20 border border-violet-500/25 text-violet-300 rounded-xl py-2.5 text-[13px] font-semibold transition-all disabled:opacity-40 flex items-center justify-center gap-2">
                            {#if taxiSearching}
                                <div class="w-3.5 h-3.5 border border-violet-400/40 border-t-violet-400 rounded-full animate-spin"></div>
                                Searching drivers…
                            {:else}
                                Find Drivers
                            {/if}
                        </button>
                        {#if taxiDrivers.length > 0}
                            <div class="space-y-1.5" in:scale={{ duration: 280, start: 0.97, easing: cubicOut }}>
                                {#each taxiDrivers as driver}
                                    <button onclick={() => bookDriver(driver)}
                                        class="w-full flex items-center gap-3 p-3 bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] rounded-xl transition-all">
                                        <div class="w-9 h-9 rounded-full bg-gradient-to-br from-violet-500/20 to-indigo-500/20 flex items-center justify-center text-sm font-semibold text-white/60 shrink-0">{driver.name[0]}</div>
                                        <div class="flex-1 text-left">
                                            <p class="text-[12px] font-semibold text-white/80">{driver.name}</p>
                                            <p class="text-[10px] text-white/30 mt-0.5">⭐ {driver.rating} · {driver.eta} min away</p>
                                        </div>
                                        <div class="text-right">
                                            <p class="text-[13px] font-bold text-white/70">₹{driver.price}</p>
                                            <p class="text-[10px] text-emerald-400/70 mt-0.5">Book →</p>
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
                                    class="px-2.5 py-1 rounded-full text-[11px] font-medium transition-all border
                                           {foodCuisine === c ? 'bg-orange-500/15 border-orange-500/30 text-orange-300' : 'bg-white/[0.03] border-white/[0.06] text-white/40 hover:text-white/70'}">
                                    {c}
                                </button>
                            {/each}
                        </div>
                        <div class="relative">
                            <span class="absolute left-3 top-1/2 -translate-y-1/2 text-xs">📍</span>
                            <input bind:value={foodLocation} placeholder="Delivery location"
                                class="w-full bg-white/[0.04] border border-white/[0.07] rounded-xl pl-8 pr-3 py-2.5 text-[13px] text-white placeholder-white/20 focus:outline-none focus:border-orange-500/40 transition-colors" />
                        </div>
                        <button onclick={searchRestaurants} disabled={foodLoading}
                            class="w-full bg-orange-500/12 hover:bg-orange-500/20 border border-orange-500/25 text-orange-300 rounded-xl py-2.5 text-[13px] font-semibold transition-all flex items-center justify-center gap-2">
                            {#if foodLoading}
                                <div class="w-3.5 h-3.5 border border-orange-400/40 border-t-orange-400 rounded-full animate-spin"></div>
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
                            <div class="text-center py-6" in:scale={{ duration: 400, easing: elasticOut, start: 0.7 }}>
                                <div class="text-5xl mb-3">✅</div>
                                <p class="text-base font-semibold text-emerald-400">Sent ₹{payAmount}</p>
                                <p class="text-xs text-white/30 mt-1.5">Opening wallet for {payTo}</p>
                            </div>
                        {:else}
                            <input bind:value={payTo} placeholder="UPI / Phone / Wallet Address"
                                class="w-full bg-white/[0.04] border border-white/[0.07] rounded-xl px-3 py-2.5 text-[13px] text-white placeholder-white/20 focus:outline-none focus:border-violet-500/40 transition-colors" />
                            <div class="relative">
                                <span class="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-white/30 font-bold">₹</span>
                                <input bind:value={payAmount} type="number" placeholder="Amount"
                                    class="w-full bg-white/[0.04] border border-white/[0.07] rounded-xl pl-7 pr-3 py-2.5 text-[13px] text-white placeholder-white/20 focus:outline-none focus:border-violet-500/40 transition-colors" />
                            </div>
                            <input bind:value={payNote} placeholder="Note (optional)"
                                class="w-full bg-white/[0.04] border border-white/[0.07] rounded-xl px-3 py-2.5 text-[13px] text-white placeholder-white/20 focus:outline-none focus:border-violet-500/40 transition-colors" />
                            <button onclick={sendPayment} disabled={!payTo || !payAmount || paySending}
                                class="w-full bg-violet-500/12 hover:bg-violet-500/20 border border-violet-500/25 text-violet-300 rounded-xl py-2.5 text-[13px] font-semibold transition-all disabled:opacity-40 flex items-center justify-center gap-2">
                                {#if paySending}
                                    <div class="w-3.5 h-3.5 border border-violet-400/40 border-t-violet-400 rounded-full animate-spin"></div>
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
                        {#if weatherData}
                            <div class="bg-gradient-to-br from-sky-500/10 to-blue-700/5 border border-sky-500/15 rounded-2xl p-5 text-center" in:scale={{ duration: 380, easing: cubicOut, start: 0.95 }}>
                                <p class="text-6xl mb-3">🌤️</p>
                                <p class="text-4xl font-light text-white tracking-tight">{weatherData.temp}°C</p>
                                <p class="text-[12px] text-sky-300/70 mt-2">{weatherData.condition}</p>
                                <div class="flex justify-center gap-5 mt-4 text-[11px] text-white/30">
                                    <span>💧 {weatherData.humidity}%</span>
                                    <span>💨 {weatherData.wind} km/h</span>
                                </div>
                            </div>
                        {:else}
                            <div class="relative">
                                <span class="absolute left-3 top-1/2 -translate-y-1/2 text-xs">📍</span>
                                <input bind:value={weatherLoc} placeholder="City or location"
                                    class="w-full bg-white/[0.04] border border-white/[0.07] rounded-xl pl-8 pr-3 py-2.5 text-[13px] text-white placeholder-white/20 focus:outline-none focus:border-sky-500/40 transition-colors" />
                            </div>
                            <button onclick={checkWeather} disabled={weatherLoading}
                                class="w-full bg-sky-500/12 hover:bg-sky-500/20 border border-sky-500/25 text-sky-300 rounded-xl py-2.5 text-[13px] font-semibold transition-all flex items-center justify-center gap-2">
                                {#if weatherLoading}
                                    <div class="w-3.5 h-3.5 border border-sky-400/40 border-t-sky-400 rounded-full animate-spin"></div>
                                    Checking…
                                {:else}
                                    🌤️ Check Weather
                                {/if}
                            </button>
                        {/if}
                    </div>

                <!-- IPFS -->
                {:else if type === "ipfs_action"}
                    <button onclick={openIpfs}
                        class="w-full bg-cyan-500/12 hover:bg-cyan-500/20 border border-cyan-500/25 text-cyan-300 rounded-xl py-2.5 text-[13px] font-semibold transition-all">
                        🌐 Open IPFS Dashboard
                    </button>

                <!-- PRODUCT -->
                {:else if type === "product_search"}
                    <div class="space-y-2.5">
                        <input bind:value={productQuery} placeholder="What are you looking for?"
                            class="w-full bg-white/[0.04] border border-white/[0.07] rounded-xl px-3 py-2.5 text-[13px] text-white placeholder-white/20 focus:outline-none focus:border-amber-500/40 transition-colors" />
                        <button onclick={searchProduct}
                            class="w-full bg-amber-500/12 hover:bg-amber-500/20 border border-amber-500/25 text-amber-300 rounded-xl py-2.5 text-[13px] font-semibold transition-all">
                            🛍️ Find Best Prices
                        </button>
                    </div>

                <!-- NEARBY -->
                {:else if type === "nearby_search"}
                    <div class="space-y-2.5">
                        <input bind:value={nearbyQuery} placeholder="What are you looking for nearby?"
                            class="w-full bg-white/[0.04] border border-white/[0.07] rounded-xl px-3 py-2.5 text-[13px] text-white placeholder-white/20 focus:outline-none focus:border-emerald-500/40 transition-colors" />
                        <button onclick={searchNearby}
                            class="w-full bg-emerald-500/12 hover:bg-emerald-500/20 border border-emerald-500/25 text-emerald-300 rounded-xl py-2.5 text-[13px] font-semibold transition-all">
                            📍 Search Nearby
                        </button>
                    </div>

                <!-- NEWS -->
                {:else if type === "news_search"}
                    <button onclick={searchNews}
                        class="w-full bg-zinc-500/12 hover:bg-zinc-500/20 border border-zinc-500/25 text-zinc-300 rounded-xl py-2.5 text-[13px] font-semibold transition-all">
                        📰 Search Latest News
                    </button>

                <!-- NAVIGATE / SEARCH -->
                {:else if type === "navigate" || type === "search"}
                    <a href={url || "#"} target="_blank" rel="noopener noreferrer"
                        class="flex items-center gap-3 p-3.5 bg-blue-500/5 rounded-xl border border-blue-500/15 hover:border-blue-500/30 transition-all no-underline">
                        <div class="w-9 h-9 rounded-xl bg-blue-500/10 flex items-center justify-center shrink-0">
                            {#if type === "navigate"}
                                <Navigation size={16} class="text-blue-400" />
                            {:else}
                                <Search size={16} class="text-blue-400" />
                            {/if}
                        </div>
                        <div class="flex-1 min-w-0">
                            <p class="text-[10px] text-white/30 uppercase tracking-wide">{type === "navigate" ? "Navigate to" : "Search"}</p>
                            <p class="text-[13px] text-blue-300 font-medium truncate mt-0.5">{url || text || "Link"}</p>
                        </div>
                    </a>

                <!-- CODE -->
                {:else if type === "code"}
                    <pre class="text-[11px] font-mono text-emerald-300/80 bg-black/50 rounded-xl p-4 overflow-x-auto whitespace-pre-wrap border border-white/[0.05] max-h-64">{text || content}</pre>

                {/if}
            </div>

            <!-- ── IPFS verified footer ──────────────────────────────────── -->
            {#if cid}
                <div class="px-5 py-2.5 border-t border-white/[0.05] bg-cyan-400/[0.02] flex items-center justify-between">
                    <span class="text-[9px] text-cyan-400/40 uppercase font-bold tracking-[0.2em]">Verified Fragment</span>
                    <a href="https://ipfs.io/ipfs/{cid}" target="_blank"
                        class="text-[11px] font-mono text-cyan-300/50 hover:text-cyan-200 flex items-center gap-1">
                        {cid.slice(0,6)}…{cid.slice(-4)} ↗
                    </a>
                </div>
            {/if}

            <!-- ── Feedback ─────────────────────────────────────────────── -->
            {#if taskId && !showCorrection}
                <div class="px-5 py-3 flex items-center gap-2 border-t border-white/[0.05]">
                    <span class="text-[9px] text-white/20 uppercase tracking-widest flex-1">Was this helpful?</span>
                    <button onclick={() => handleFeedback(1)} aria-label="Good"
                        class="px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all {feedbackScore===1 ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/25' : 'text-white/25 hover:text-white/60 hover:bg-white/5'}">
                        👍 Yes
                    </button>
                    <button onclick={() => handleFeedback(-1)} aria-label="No"
                        class="px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all {feedbackScore===-1 ? 'bg-rose-500/15 text-rose-300 border border-rose-500/25' : 'text-white/25 hover:text-white/60 hover:bg-white/5'}">
                        👎 No
                    </button>
                </div>
            {:else if showCorrection}
                <div class="p-4 border-t border-white/[0.05]" in:scale={{ duration: 200, start: 0.95 }}>
                    <textarea bind:value={correctionText} placeholder="What should it have done?"
                        class="w-full bg-black/40 border border-white/[0.08] rounded-xl p-3 text-[12px] text-white/80 placeholder:text-white/20 focus:outline-none focus:border-rose-500/40 resize-none h-20"></textarea>
                    <div class="flex justify-end gap-2 mt-2.5">
                        <button onclick={() => showCorrection = false} class="px-3 py-1.5 text-[11px] text-white/40 hover:text-white/60">Cancel</button>
                        <button onclick={submitCorrection} class="px-4 py-1.5 bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 text-[11px] rounded-lg transition-colors border border-rose-500/20">Submit</button>
                    </div>
                </div>
            {/if}

        </div>
    </div>
{/if}
