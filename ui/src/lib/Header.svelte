<script lang="ts">
    import { onMount, tick } from "svelte";
    import { browserStore, activeTab } from "$lib/stores";
    import {
        LayoutGrid,
        X,
        Settings,
        ArrowLeft,
        ArrowRight,
        RotateCw,
        Search,
        Bookmark,
        Clock,
        Wallet,
        Download,
        Globe,
        Sparkles,
        Minus,
        Square,
        Copy,
    } from "lucide-svelte";
    import AppStore from "./AppStore.svelte";
    import { scale } from "svelte/transition";
    import { cubicOut } from "svelte/easing";
    import { bucks, hasBridge, isMac } from "./bridge";
    import { settingsStore } from "./settingsStore";
    import { focusOmniboxRequest, pushOverlay, popOverlay } from "./uiState";

    let isSettingsOpen = $state(false);
    let menuWrapEl = $state<HTMLDivElement | null>(null);
    let storeOpen = $state(false);
    let urlInput = $state("");
    let urlInputEl = $state<HTMLInputElement | null>(null);
    let omniboxFocused = $state(false);
    let showSuggestions = $state(false);
    let suggestions = $state<string[]>([]);
    let isMaximized = $state(false);
    /** favicon URLs that failed to load, so the fallback glyph is shown instead */
    let brokenFavicons = $state<Record<string, boolean>>({});

    const showWindowControls = !isMac;

    // ── window controls (win32 / linux) ───────────────────────────────────────
    onMount(() => {
        bucks.window.isMaximized().then((v) => (isMaximized = v)).catch(() => {});
        return bucks.window.onMaximized((v) => (isMaximized = v));
    });

    // ── overlays: the native web view is hidden while a dropdown covers it ─────
    $effect(() => {
        if (!isSettingsOpen) return;
        pushOverlay();
        return popOverlay;
    });
    $effect(() => {
        if (!(showSuggestions && suggestions.length > 0)) return;
        pushOverlay();
        return popOverlay;
    });

    // ── keyboard ──────────────────────────────────────────────────────────────
    // Inside Bucks Browser the native menu owns the accelerators and forwards them as
    // shortcut events (handled in the store). This handler only serves the plain-browser mock.
    function handleGlobalKey(e: KeyboardEvent) {
        if (e.key === "Escape" && isSettingsOpen) {
            isSettingsOpen = false;
            return;
        }
        if (hasBridge) return;
        const mod = e.metaKey || e.ctrlKey;
        if (!mod) return;
        if (e.key === "t") {
            e.preventDefault();
            browserStore.createTab();
        } else if (e.key === "w") {
            e.preventDefault();
            const id = $browserStore.activeTabId;
            if (id) browserStore.closeTab(id);
        } else if (e.key === "l") {
            e.preventDefault();
            focusOmnibox();
        } else if (e.key === "r") {
            e.preventDefault();
            browserStore.refresh();
        }
    }

    /** Close the menu on any click outside it (a backdrop element cannot be used: the island's
     *  backdrop-filter makes it the containing block of fixed descendants). */
    function handleWindowClick(e: MouseEvent) {
        // composedPath(): the clicked icon may already have been swapped out of the DOM by now.
        if (isSettingsOpen && menuWrapEl && !e.composedPath().includes(menuWrapEl)) isSettingsOpen = false;
    }

    function focusOmnibox() {
        urlInputEl?.focus();
        urlInputEl?.select();
    }

    // The 'focus-omnibox' shortcut (and 'new-tab') bump a counter in the UI state store.
    let lastFocusRequest = $focusOmniboxRequest;
    $effect(() => {
        const n = $focusOmniboxRequest;
        if (n === lastFocusRequest) return;
        lastFocusRequest = n;
        void tick().then(focusOmnibox);
    });

    // ── omnibox text follows the active tab ───────────────────────────────────
    // A page that updates while the user is typing must not clobber their input.
    let syncedTabId = "";
    let appliedUrl = "";
    $effect(() => {
        const tab = $activeTab;
        if (!tab) return;
        const idChanged = tab.id !== syncedTabId;
        if (idChanged || (tab.url !== appliedUrl && !omniboxFocused)) {
            urlInput = tab.url === "bucks://newtab" ? "" : tab.url;
            appliedUrl = tab.url;
            if (idChanged) showSuggestions = false;
        }
        syncedTabId = tab.id;
    });

    const canGoBack = $derived(
        !!$activeTab &&
            (($activeTab.type === "external" && !!$activeTab.canGoBack) ||
                $activeTab.historyBack.length > 0),
    );
    const canGoForward = $derived(
        !!$activeTab &&
            (($activeTab.type === "external" && !!$activeTab.canGoForward) ||
                $activeTab.historyForward.length > 0),
    );

    // Common search suggestions
    const commonSuggestions = [
        "google.com",
        "github.com",
        "youtube.com",
        "stackoverflow.com",
        "wikipedia.org",
        "reddit.com"
    ];

    function updateSuggestions() {
        const input = urlInput.trim().toLowerCase();
        if (!input) {
            suggestions = [];
            showSuggestions = false;
            return;
        }

        // Filter suggestions based on input
        const filtered = commonSuggestions.filter(s =>
            s.toLowerCase().includes(input)
        );

        // Add dynamic suggestions
        if (!input.includes(".") && !input.includes(" ")) {
            // A single word: offer the usual TLDs, then search
            filtered.push(`${input}.com`, `${input}.org`, `${input}.net`);
            if (filtered.length < 3) {
                filtered.push(`Search for "${input}"`);
            }
        }

        suggestions = filtered.slice(0, 5);
        showSuggestions = suggestions.length > 0;
    }

    function selectSuggestion(suggestion: string) {
        if (suggestion.startsWith("Search for")) {
            urlInput = suggestion.replace('Search for "', '').replace('"', '');
        } else {
            urlInput = suggestion;
        }
        showSuggestions = false;
    }

    /**
     * Turn omnibox text into a URL: bucks://, http(s)/file/ipfs/ipns URLs pass through unchanged
     * (the main process normalises CIDs and reports the canonical URL back), bare hosts get
     * http(s)://, absolute paths become file:// URLs and anything else is a search.
     */
    function resolveInput(input: string): string {
        if (/^(bucks:\/\/|https?:\/\/|file:\/\/|ipfs:\/\/|ipns:\/\/)/i.test(input)) return input;
        if (/^localhost(:\d+)?($|[/?#])/i.test(input)) return `http://${input}`;
        if (/^\d+\.\d+\.\d+\.\d+(:\d+)?($|[/?#])/.test(input)) return `http://${input}`;
        // Bare CID (v0 "Qm…" or v1 base32 "b…"), optionally followed by a path
        if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})(\/\S*)?$/.test(input)) return `ipfs://${input}`;
        // Domain names (has TLD and no spaces)
        if (/^[\w-]+(\.[\w-]+)+([/:?#].*)?$/.test(input) && !input.includes(" ")) return `https://${input}`;
        // Absolute file paths only; "~/x" and "./x" cannot be resolved without a home directory
        if (/^\/[^\s]*$/.test(input)) return `file://${input}`;
        if (/^[a-zA-Z]:[\\/][^\s]*$/.test(input)) return `file:///${input.replace(/\\/g, "/")}`;
        return settingsStore.searchUrl(input);
    }

    function handleUrlSubmit(e: Event) {
        e.preventDefault();
        const input = urlInput.trim();
        if (!input) return;
        showSuggestions = false;
        const targetUrl = resolveInput(input);

        if ($browserStore.activeTabId) {
            browserStore.navigateActiveTab(targetUrl);
        } else {
            browserStore.createTab(targetUrl);
        }
        urlInputEl?.blur();
    }

    function onOmniboxKeydown(e: KeyboardEvent) {
        if (e.key === "Escape") {
            showSuggestions = false;
            const tab = $activeTab;
            urlInput = !tab || tab.url === "bucks://newtab" ? "" : tab.url;
            urlInputEl?.blur();
        }
    }

    function goTo(url: string) {
        isSettingsOpen = false;
        browserStore.navigateActiveTab(url);
    }
</script>

<svelte:window onkeydown={handleGlobalKey} onclick={handleWindowClick} />

<header
    class="fixed top-6 inset-x-0 z-[110] pointer-events-none px-6"
>
    <!-- The island is the window's drag handle; every interactive child opts out with .no-drag -->
    <div
        style="-webkit-app-region: drag"
        class="max-w-5xl mx-auto flex items-center h-16 px-3 bg-[#0a0a0c]/80 backdrop-blur-2xl rounded-3xl shadow-[0_20px_50px_-15px_rgba(0,0,0,0.8)] border border-white/5 pointer-events-auto relative group/header"
    >
        <!-- Animated edge glow for the whole island -->
        <div class="absolute inset-0 rounded-3xl overflow-hidden pointer-events-none">
            <div
                class="absolute inset-0 bg-gradient-to-r from-blue-500/0 via-white/5 to-blue-500/0 translate-x-[-100%] group-hover/header:translate-x-[100%] transition-transform duration-[2000ms]"
            ></div>
        </div>

        <!-- Left: App Store icon + Nav -->
        <div class="flex items-center space-x-1 relative z-10 {isMac ? 'pl-[70px]' : 'pl-2'}">
            <!-- App Store launcher (replaces hamburger) -->
            <button
                onclick={() => storeOpen = !storeOpen}
                title="App Store"
                aria-label="App Store"
                class="no-drag w-10 h-10 flex items-center justify-center rounded-2xl transition-all active:scale-95 group/btn relative overflow-hidden
                       {storeOpen ? 'bg-violet-500/20 text-violet-300' : 'hover:bg-white/5 text-white/60 hover:text-white'}"
            >
                <div class="absolute inset-0 bg-gradient-to-br from-violet-500/10 to-blue-500/10 opacity-0 group-hover/btn:opacity-100 transition-opacity rounded-2xl"></div>
                {#if storeOpen}
                    <X size={18} class="text-violet-300" />
                {:else}
                    <LayoutGrid size={18} />
                {/if}
                <!-- Subtle glow when open -->
                {#if storeOpen}
                    <div class="absolute inset-0 rounded-2xl ring-1 ring-violet-500/30"></div>
                {/if}
            </button>

            <div
                class="no-drag flex items-center space-x-0.5 bg-white/5 rounded-xl p-1 ml-2"
            >
                <button
                    onclick={browserStore.goBack}
                    disabled={!canGoBack}
                    title="Back"
                    aria-label="Back"
                    class="w-8 h-8 flex items-center justify-center rounded-lg transition-all active:scale-90 disabled:cursor-default
                           {canGoBack ? 'text-white/70 hover:text-white hover:bg-white/10' : 'text-white/25'}"
                >
                    <ArrowLeft size={16} />
                </button>
                <button
                    onclick={browserStore.goForward}
                    disabled={!canGoForward}
                    title="Forward"
                    aria-label="Forward"
                    class="w-8 h-8 flex items-center justify-center rounded-lg transition-all active:scale-90 disabled:cursor-default
                           {canGoForward ? 'text-white/70 hover:text-white hover:bg-white/10' : 'text-white/25'}"
                >
                    <ArrowRight size={16} />
                </button>
                <button
                    onclick={browserStore.refresh}
                    title="Reload"
                    aria-label="Reload"
                    class="w-8 h-8 flex items-center justify-center rounded-lg text-white/30 hover:text-white hover:bg-white/10 transition-all active:scale-90"
                >
                    <RotateCw
                        size={14}
                        class={$activeTab?.isLoading
                            ? "animate-spin text-blue-400"
                            : ""}
                    />
                </button>
            </div>
        </div>

        <!-- Middle: Edge-Lit Omnibox -->
        <div class="no-drag flex-1 mx-6 relative z-10">
            <form onsubmit={handleUrlSubmit} class="relative group/form">
                <!-- Edge-lit animated border pulsing -->
                <div
                    class="absolute -inset-[1.5px] bg-gradient-to-r from-blue-600/0 via-blue-400/50 to-blue-600/0 rounded-[18px] opacity-0 group-focus-within/form:opacity-100 transition-opacity duration-700 blur-[2px] animate-pulse"
                ></div>

                <div
                    class="relative bg-black/40 border border-white/[0.03] rounded-[16px] flex items-center px-4 h-10 transition-all group-focus-within/form:bg-black/80 group-focus-within/form:border-blue-500/20 shadow-inner"
                >
                    <Search
                        size={14}
                        class="text-white/20 mr-3 group-focus-within/form:text-blue-400/70 transition-colors"
                    />
                    <input
                        type="text"
                        bind:this={urlInputEl}
                        bind:value={urlInput}
                        oninput={updateSuggestions}
                        onfocus={() => { omniboxFocused = true; urlInputEl?.select(); }}
                        onblur={() => { omniboxFocused = false; setTimeout(() => showSuggestions = false, 200); }}
                        onkeydown={onOmniboxKeydown}
                        placeholder="Explore the swarm... (type URL or search)"
                        aria-label="Address or search"
                        spellcheck="false"
                        autocomplete="off"
                        class="flex-1 bg-transparent border-none text-[13px] text-white/80 placeholder-white/20 outline-none w-full font-medium tracking-wide"
                    />

                    {#if $activeTab?.isLoading}
                        <div class="flex items-center space-x-1.5 pr-1">
                            <div
                                class="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce"
                            ></div>
                            <div
                                class="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce"
                                style="animation-delay: 0.2s"
                            ></div>
                        </div>
                    {/if}
                </div>

                <!-- Suggestions Dropdown -->
                {#if showSuggestions && suggestions.length > 0}
                    <div
                        class="no-drag absolute top-full left-0 right-0 mt-2 bg-[#0a0a0c]/95 backdrop-blur-2xl border border-white/10 rounded-lg shadow-lg overflow-hidden z-50"
                    >
                        {#each suggestions as suggestion (suggestion)}
                            <button
                                type="button"
                                onmousedown={(e) => e.preventDefault()}
                                onclick={() => {
                                    selectSuggestion(suggestion);
                                    handleUrlSubmit(new SubmitEvent('submit'));
                                }}
                                class="w-full px-4 py-2.5 text-left text-[12px] text-white/70 hover:text-white hover:bg-white/10 transition-all border-b border-white/5 last:border-b-0"
                            >
                                <span class="text-blue-400/70 mr-2">→</span>
                                {suggestion}
                            </button>
                        {/each}
                    </div>
                {/if}
            </form>
        </div>

        <!-- Right: Tab Cluster & Power Tools -->
        <div
            class="flex items-center space-x-2 relative z-10 flex-1 min-w-0 justify-end h-full pr-2"
        >
            <!-- Settings Icon (Static) -->
            <div bind:this={menuWrapEl} class="no-drag relative flex-shrink-0">
                <button
                    onclick={() => (isSettingsOpen = !isSettingsOpen)}
                    title="Menu"
                    aria-label="Menu"
                    aria-expanded={isSettingsOpen}
                    class="w-10 h-10 flex items-center justify-center rounded-xl text-white/40 hover:text-white hover:bg-white/10 transition-all active:scale-90 relative overflow-hidden"
                >
                    {#if isSettingsOpen}
                        <X size={18} />
                    {:else}
                        <Settings
                            size={18}
                            class="transition-transform duration-700 ease-out"
                        />
                    {/if}
                </button>

                {#if isSettingsOpen}
                    <div
                        transition:scale={{
                            duration: 300,
                            easing: cubicOut,
                            start: 0.95,
                        }}
                        class="no-drag absolute top-14 right-0 w-56 bg-[#0a0a0c]/98 backdrop-blur-3xl rounded-[1.5rem] p-2 shadow-[0_25px_50px_-12px_rgba(0,0,0,0.9)] border border-white/10 z-50"
                    >
                        <div class="flex flex-col space-y-1">
                            <button
                                onclick={() => goTo("bucks://downloads")}
                                class="flex items-center space-x-3 p-3 rounded-xl hover:bg-white/5 transition-all text-left group w-full"
                            >
                                <div
                                    class="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center"
                                >
                                    <Download
                                        size={16}
                                        class="text-blue-400/80 group-hover:text-blue-400"
                                    />
                                </div>
                                <span
                                    class="text-[11px] font-bold uppercase tracking-widest text-white/60 group-hover:text-white"
                                    >Downloads</span
                                >
                            </button>
                            <button
                                onclick={() => goTo("bucks://history")}
                                class="flex items-center space-x-3 p-3 rounded-xl hover:bg-white/5 transition-all text-left group w-full"
                            >
                                <div
                                    class="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center"
                                >
                                    <Clock
                                        size={16}
                                        class="text-purple-400/80 group-hover:text-purple-400"
                                    />
                                </div>
                                <span
                                    class="text-[11px] font-bold uppercase tracking-widest text-white/60 group-hover:text-white"
                                    >History</span
                                >
                            </button>
                            <button
                                onclick={() => goTo("bucks://bookmarks")}
                                class="flex items-center space-x-3 p-3 rounded-xl hover:bg-white/5 transition-all text-left group w-full"
                            >
                                <div
                                    class="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center"
                                >
                                    <Bookmark
                                        size={16}
                                        class="text-emerald-400/80 group-hover:text-emerald-400"
                                    />
                                </div>
                                <span
                                    class="text-[11px] font-bold uppercase tracking-widest text-white/60 group-hover:text-white"
                                    >Bookmarks</span
                                >
                            </button>
                            <div class="h-[1px] bg-white/5 my-2 mx-3"></div>
                            <button
                                onclick={() => goTo("bucks://settings")}
                                class="flex items-center space-x-3 p-3 rounded-xl hover:bg-white/5 transition-all text-left group w-full"
                            >
                                <div
                                    class="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center"
                                >
                                    <Settings
                                        size={16}
                                        class="text-white/20 group-hover:text-white"
                                    />
                                </div>
                                <span
                                    class="text-[11px] font-bold uppercase tracking-widest text-white/40 group-hover:text-white"
                                    >All Settings</span
                                >
                            </button>
                        </div>
                    </div>
                {/if}
            </div>

            <div class="h-8 w-[1px] bg-white/10 mx-1 flex-shrink-0"></div>

            <!-- Scrollable Tab Container (Dynamic) -->
            <div
                class="relative group/tabs flex items-center h-full flex-1 min-w-0 overflow-hidden"
            >
                <div
                    class="no-drag flex items-center space-x-1 h-12 overflow-x-auto custom-scrollbar scroll-smooth px-2 pb-1 flex-1"
                    style="mask-image: linear-gradient(to right, transparent, black 40px, black calc(100% - 40px), transparent);"
                >
                    {#each $browserStore.tabs as tab (tab.id)}
                        <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
                        <div
                            role="button"
                            tabindex="0"
                            aria-label={tab.title}
                            aria-current={tab.id === $browserStore.activeTabId ? "page" : undefined}
                            onclick={() => browserStore.setActiveTab(tab.id)}
                            onkeydown={(e) =>
                                (e.key === "Enter" || e.key === " ") &&
                                browserStore.setActiveTab(tab.id)}
                            transition:scale={{
                                duration: 300,
                                easing: cubicOut,
                                start: 0.9,
                            }}
                            class="group/tab relative h-8 px-4 rounded-xl flex items-center space-x-2 transition-all duration-300 cursor-pointer select-none whitespace-nowrap border border-white/5 flex-shrink-0 {tab.id ===
                            $browserStore.activeTabId
                                ? 'bg-white/10 text-white border-white/20'
                                : 'bg-white/[0.02] text-white/30 hover:text-white/60 hover:bg-white/5'}"
                        >
                            <!-- Favicon, or a small glyph when the page has none -->
                            {#if tab.type === "external" && tab.isLoading && !tab.favicon}
                                <RotateCw size={11} class="animate-spin text-blue-400/80 flex-shrink-0" />
                            {:else if tab.favicon && !brokenFavicons[tab.favicon]}
                                <img
                                    src={tab.favicon}
                                    alt=""
                                    width="14"
                                    height="14"
                                    class="w-3.5 h-3.5 rounded-sm flex-shrink-0 object-contain"
                                    onerror={() => tab.favicon && (brokenFavicons[tab.favicon] = true)}
                                />
                            {:else if tab.type === "external"}
                                <Globe size={12} class="flex-shrink-0 opacity-60" />
                            {:else}
                                <Sparkles size={12} class="flex-shrink-0 opacity-60" />
                            {/if}
                            <span
                                class="text-[10px] font-bold tracking-tight truncate max-w-[100px]"
                                >{tab.title}</span
                            >
                            {#if tab.id === $browserStore.activeTabId || $browserStore.tabs.length > 1}
                                <button
                                    onclick={(e) => {
                                        e.stopPropagation();
                                        browserStore.closeTab(tab.id);
                                    }}
                                    title="Close tab"
                                    aria-label="Close tab"
                                    class="opacity-0 group-hover/tab:opacity-100 focus:opacity-100 p-0.5 hover:bg-white/10 rounded-md transition-all"
                                >
                                    <X size={10} />
                                </button>
                            {/if}
                            {#if tab.id === $browserStore.activeTabId}
                                <div
                                    class="absolute bottom-1 left-1/2 -translate-x-1/2 w-3 h-[1.5px] bg-blue-500 rounded-full"
                                ></div>
                            {/if}
                        </div>
                    {/each}
                </div>
            </div>

            <!-- New Tab Button (Static) -->
            <button
                onclick={() => { browserStore.createTab(); focusOmnibox(); }}
                title="New tab"
                aria-label="New tab"
                class="no-drag ml-2 w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-xl bg-white/[0.03] border border-dashed border-white/10 text-white/20 hover:text-white hover:bg-white/10 hover:border-white/20 transition-all active:scale-90"
            >
                <span class="text-lg font-light">+</span>
            </button>

            <div class="h-8 w-[1px] bg-white/10 mx-1 flex-shrink-0"></div>

            <button
                onclick={() => browserStore.createOrFocusTab("bucks://wallet")}
                title="Wallet"
                aria-label="Wallet"
                class="no-drag w-10 h-10 flex-shrink-0 flex items-center justify-center rounded-xl transition-all active:scale-90 group text-white/40 hover:text-blue-400 hover:bg-blue-400/5 relative overflow-hidden"
            >
                <div
                    class="absolute inset-0 bg-blue-500/0 group-hover:bg-blue-500/5 transition-colors"
                ></div>
                <Wallet size={18} />
            </button>

            {#if showWindowControls}
                <div class="h-8 w-[1px] bg-white/10 mx-1 flex-shrink-0"></div>
                <div class="no-drag flex items-center flex-shrink-0 -mr-1">
                    <button
                        onclick={() => bucks.window.minimize()}
                        title="Minimize"
                        aria-label="Minimize"
                        class="w-8 h-8 flex items-center justify-center rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-all"
                    >
                        <Minus size={14} />
                    </button>
                    <button
                        onclick={() => bucks.window.maximize()}
                        title={isMaximized ? "Restore" : "Maximize"}
                        aria-label={isMaximized ? "Restore" : "Maximize"}
                        class="w-8 h-8 flex items-center justify-center rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-all"
                    >
                        {#if isMaximized}
                            <Copy size={12} />
                        {:else}
                            <Square size={12} />
                        {/if}
                    </button>
                    <button
                        onclick={() => bucks.window.close()}
                        title="Close"
                        aria-label="Close window"
                        class="w-8 h-8 flex items-center justify-center rounded-lg text-white/40 hover:text-white hover:bg-red-500/70 transition-all"
                    >
                        <X size={14} />
                    </button>
                </div>
            {/if}
        </div>

    </div>
</header>

{#if storeOpen}
    <AppStore onclose={() => storeOpen = false} />
{/if}
