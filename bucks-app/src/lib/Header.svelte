<script lang="ts">
    import { browserStore, activeTab } from "$lib/stores";
    import {
        Menu,
        X,
        Settings,
        Home,
        Globe,
        MessageSquare,
        Bell,
        ArrowLeft,
        ArrowRight,
        RotateCw,
        Search,
        Bookmark,
        Clock,
        Moon,
        Wallet,
        LayoutGrid,
        User,
        Server,
    } from "lucide-svelte";
    import { fade, scale, fly } from "svelte/transition";
    import { cubicOut } from "svelte/easing";
    import { Window } from "@tauri-apps/api/window";

    const appWindow = new Window("main");

    let isMenuOpen = $state(false);
    let isSettingsOpen = $state(false);
    let urlInput = $state("");
    let urlInputEl = $state<HTMLInputElement | null>(null);

    // Search engine URLs — read from settings (live, so switching mid-session works)
    const SEARCH_ENGINES: Record<string, string> = {
        duckduckgo: "https://duckduckgo.com/?q=",
        google:     "https://google.com/search?q=",
        brave:      "https://search.brave.com/search?q=",
        bing:       "https://bing.com/search?q=",
    };
    function getSearchUrl(q: string): string {
        const engine = (typeof localStorage !== "undefined"
            ? localStorage.getItem("bucks_search_engine") : null) ?? "duckduckgo";
        const base = SEARCH_ENGINES[engine] ?? SEARCH_ENGINES.duckduckgo;
        return base + encodeURIComponent(q);
    }

    function handleGlobalKey(e: KeyboardEvent) {
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
            urlInputEl?.focus();
            urlInputEl?.select();
        } else if (e.key === "r") {
            e.preventDefault();
            browserStore.refresh();
        }
    }
    let showSuggestions = $state(false);
    let suggestions = $state<string[]>([]);

    // Common search suggestions
    const commonSuggestions = [
        "google.com",
        "github.com",
        "youtube.com",
        "stackoverflow.com",
        "wikipedia.org",
        "reddit.com"
    ];

    const menuItems = [
        {
            label: "Profile",
            icon: User,
            href: "/login",
            color: "text-zinc-400",
        },
        { label: "Home", icon: Home, href: "/", color: "text-blue-400" },
        {
            label: "Global Feed",
            icon: Globe,
            href: "/feed",
            color: "text-purple-400",
        },
        {
            label: "Services",
            icon: LayoutGrid,
            href: "/superapp",
            color: "text-emerald-400",
        },
        {
            label: "Implementation",
            icon: Server,
            href: "/implementation",
            color: "text-amber-400",
        },
        {
            label: "Messages",
            icon: MessageSquare,
            href: "/messages",
            color: "text-blue-400",
        },
        {
            label: "Notifications",
            icon: Bell,
            href: "/notifications",
            color: "text-yellow-400",
        },
    ];

    $effect(() => {
        if ($activeTab) {
            urlInput =
                $activeTab.url === "bucks://newtab" ? "" : $activeTab.url;
        }
    });

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
        if (input.includes(".")) {
            // Looks like domain pattern, suggest common TLDs
            const parts = input.split(".");
            if (parts.length === 1) {
                filtered.push(`${input}.com`);
                filtered.push(`${input}.org`);
                filtered.push(`${input}.net`);
            }
        } else if (!input.includes(" ")) {
            // Suggest as search keywords too
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

    function handleUrlSubmit(e: Event) {
        e.preventDefault();
        const input = urlInput.trim();
        if (!input) return;

        let targetUrl = "";

        // Check for protocol schemes first
        if (/^(https?:\/\/|file:\/\/|ipfs:\/\/|ipns:\/\/)/i.test(input)) {
            targetUrl = input;
        }
        // Check for localhost and port numbers
        else if (/^localhost(:\d+)?($|\/)/i.test(input)) {
            targetUrl = `http://${input}`;
        }
        // Check for IP addresses
        else if (/^\d+\.\d+\.\d+\.\d+/.test(input)) {
            targetUrl = /^\d+\.\d+\.\d+\.\d+:\d+/.test(input)
                ? `http://${input}`
                : `http://${input}`;
        }
        // Check for domain names (has TLD and no spaces)
        else if (/^[\w-]+(\.[\w-]+)+([/:?#].*)?$/.test(input) && !input.includes(" ")) {
            targetUrl = input.startsWith("http") ? input : `https://${input}`;
        }
        // Check if it looks like a file path
        else if (/^(\/|~|\.\.?\/)/.test(input)) {
            targetUrl = `file://${input.startsWith("/") ? input : process.env.HOME + "/" + input}`;
        }
        // Otherwise, treat as a search query using the selected search engine
        else {
            targetUrl = getSearchUrl(input);
        }

        if ($browserStore.activeTabId) {
            browserStore.navigateActiveTab(targetUrl);
        } else {
            browserStore.createTab(targetUrl);
        }
    }
</script>

<svelte:window onkeydown={handleGlobalKey} />

<header
    class="fixed top-6 inset-x-0 z-[110] transition-all duration-700 pointer-events-none px-6"
>
    <div
        data-tauri-drag-region
        class="max-w-5xl mx-auto flex items-center h-16 px-3 bg-[#0a0a0c]/80 backdrop-blur-2xl rounded-3xl shadow-[0_20px_50px_-15px_rgba(0,0,0,0.8)] border border-white/5 pointer-events-auto relative group/header overflow-hidden"
    >
        <!-- Animated edge glow for the whole island -->
        <div
            class="absolute inset-0 bg-gradient-to-r from-blue-500/0 via-white/5 to-blue-500/0 translate-x-[-100%] group-hover/header:translate-x-[100%] transition-transform duration-[2000ms] pointer-events-none"
        ></div>

        <!-- Left: Branding & Nav -->
        <div class="flex items-center space-x-1 relative z-10 pl-2">
            <button
                onclick={() => (isMenuOpen = !isMenuOpen)}
                class="w-10 h-10 flex items-center justify-center rounded-2xl hover:bg-white/5 transition-all active:scale-95 group/btn relative overflow-hidden"
            >
                <div
                    class="absolute inset-0 bg-gradient-to-br from-blue-500/10 to-purple-500/10 opacity-0 group-hover/btn:opacity-100 transition-opacity"
                ></div>
                {#if isMenuOpen}
                    <X size={20} class="text-white" />
                {:else}
                    <Menu
                        size={20}
                        class="text-white/60 group-hover/btn:text-white transition-colors"
                    />
                {/if}
            </button>

            <div
                class="flex items-center space-x-0.5 bg-white/5 rounded-xl p-1 ml-2"
            >
                <button
                    onclick={browserStore.goBack}
                    class="w-8 h-8 flex items-center justify-center rounded-lg text-white/30 hover:text-white hover:bg-white/10 transition-all active:scale-90"
                >
                    <ArrowLeft size={16} />
                </button>
                <button
                    onclick={browserStore.goForward}
                    class="w-8 h-8 flex items-center justify-center rounded-lg text-white/30 hover:text-white hover:bg-white/10 transition-all active:scale-90"
                >
                    <ArrowRight size={16} />
                </button>
                <button
                    onclick={browserStore.refresh}
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
        <div class="flex-1 mx-6 relative z-10">
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
                        onfocus={() => updateSuggestions()}
                        onblur={() => setTimeout(() => showSuggestions = false, 200)}
                        placeholder="Explore the swarm... (type URL or search)"
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
                        class="absolute top-full left-0 right-0 mt-2 bg-[#0a0a0c]/95 backdrop-blur-2xl border border-white/10 rounded-lg shadow-lg overflow-hidden z-50"
                    >
                        {#each suggestions as suggestion (suggestion)}
                            <button
                                type="button"
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
            <div class="relative flex-shrink-0">
                <button
                    onclick={() => (isSettingsOpen = !isSettingsOpen)}
                    class="w-10 h-10 flex items-center justify-center rounded-xl text-white/40 hover:text-white hover:bg-white/10 transition-all active:scale-90 relative overflow-hidden"
                >
                    <div
                        class="absolute inset-0 bg-white/0 group-hover:bg-white/5 transition-colors"
                    ></div>
                    {#if isSettingsOpen}
                        <X size={18} />
                    {:else}
                        <Settings
                            size={18}
                            class="{isSettingsOpen
                                ? 'rotate-90'
                                : ''} transition-transform duration-700 ease-out"
                        />
                    {/if}
                </button>

                {#if isSettingsOpen}
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <div
                        role="button"
                        tabindex="0"
                        class="fixed inset-0 z-[-1]"
                        onclick={() => (isSettingsOpen = false)}
                        onkeydown={(e) =>
                            (e.key === "Enter" || e.key === " ") &&
                            (isSettingsOpen = false)}
                    ></div>
                    <div
                        transition:scale={{
                            duration: 300,
                            easing: cubicOut,
                            start: 0.95,
                        }}
                        class="absolute top-14 right-0 w-56 bg-[#0a0a0c]/98 backdrop-blur-3xl rounded-[1.5rem] p-2 shadow-[0_25px_50px_-12px_rgba(0,0,0,0.9)] border border-white/10 z-50"
                    >
                        <div class="flex flex-col space-y-1">
                            <button
                                class="flex items-center space-x-3 p-3 rounded-xl hover:bg-white/5 transition-all text-left group w-full"
                            >
                                <div
                                    class="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center"
                                >
                                    <Moon
                                        size={16}
                                        class="text-blue-400/80 group-hover:text-blue-400"
                                    />
                                </div>
                                <span
                                    class="text-[11px] font-bold uppercase tracking-widest text-white/60 group-hover:text-white"
                                    >Appearance</span
                                >
                            </button>
                            <button
                                onclick={() => {
                                    isSettingsOpen = false;
                                    browserStore.navigateActiveTab(
                                        "bucks://history",
                                    );
                                }}
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
                                onclick={() => {
                                    isSettingsOpen = false;
                                    browserStore.navigateActiveTab(
                                        "bucks://bookmarks",
                                    );
                                }}
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
                                onclick={() => {
                                    isSettingsOpen = false;
                                    browserStore.navigateActiveTab(
                                        "bucks://settings",
                                    );
                                }}
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
                    class="flex items-center space-x-1 h-12 overflow-x-auto custom-scrollbar scroll-smooth px-2 pb-1 flex-1"
                    style="mask-image: linear-gradient(to right, transparent, black 40px, black calc(100% - 40px), transparent);"
                >
                    {#each $browserStore.tabs as tab, i (tab.id)}
                        <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
                        <div
                            role="button"
                            tabindex="0"
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
                                    class="opacity-0 group-hover/tab:opacity-100 p-0.5 hover:bg-white/10 rounded-md transition-all"
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
                onclick={() => browserStore.createTab()}
                class="ml-2 w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-xl bg-white/[0.03] border border-dashed border-white/10 text-white/20 hover:text-white hover:bg-white/10 hover:border-white/20 transition-all active:scale-90"
            >
                <span class="text-lg font-light">+</span>
            </button>

            <div class="h-8 w-[1px] bg-white/10 mx-1 flex-shrink-0"></div>

            <button
                onclick={() => browserStore.createOrFocusTab("bucks://wallet")}
                class="w-10 h-10 flex-shrink-0 flex items-center justify-center rounded-xl transition-all active:scale-90 group text-white/40 hover:text-blue-400 hover:bg-blue-400/5 relative overflow-hidden"
            >
                <div
                    class="absolute inset-0 bg-blue-500/0 group-hover:bg-blue-500/5 transition-colors"
                ></div>
                <Wallet size={18} />
            </button>
        </div>

        <!-- Side Drawer Menu -->
        {#if isMenuOpen}
            <div
                role="button"
                tabindex="0"
                class="fixed inset-0 bg-black/60 backdrop-blur-sm z-[120] pointer-events-auto"
                onclick={() => (isMenuOpen = false)}
                onkeydown={(e) => (e.key === "Escape") && (isMenuOpen = false)}
                transition:fade={{ duration: 300 }}
            >
                <!-- Drawer panel -->
                <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                <aside
                    onclick={(e) => e.stopPropagation()}
                    onkeydown={(e) => e.stopPropagation()}
                    transition:fly={{ x: -20, duration: 350, easing: cubicOut }}
                    class="absolute top-0 left-0 bottom-0 w-80 bg-[#08080b]/98 backdrop-blur-3xl border-r border-white/[0.06] flex flex-col overflow-hidden"
                >
                    <!-- User identity header -->
                    <div class="px-5 pt-6 pb-4 border-b border-white/[0.06] flex items-center gap-3">
                        <div class="w-10 h-10 rounded-2xl bg-gradient-to-br from-blue-500 via-purple-500 to-pink-500 p-[1.5px] shrink-0">
                            <div class="w-full h-full rounded-[13px] bg-[#08080b] flex items-center justify-center">
                                <User size={18} class="text-white/80" />
                            </div>
                        </div>
                        <div class="min-w-0">
                            <p class="text-[12px] font-semibold text-white/80 truncate">Master Identity</p>
                            <div class="flex items-center gap-1.5 mt-0.5">
                                <span class="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse"></span>
                                <p class="text-[9px] text-white/30 uppercase tracking-[0.25em]">Synchronized</p>
                            </div>
                        </div>
                        <button onclick={() => (isMenuOpen = false)} class="ml-auto text-white/20 hover:text-white/50 transition-colors p-1">
                            <X size={16} />
                        </button>
                    </div>

                    <!-- Scrollable content -->
                    <div class="flex-1 overflow-y-auto no-scrollbar py-3 px-3 space-y-5">

                        <!-- Navigate -->
                        <div>
                            <p class="text-[8px] uppercase tracking-[0.3em] text-white/25 font-bold px-2 mb-2">Navigate</p>
                            <div class="space-y-0.5">
                                {#each menuItems as item}
                                    {@const Icon = item.icon}
                                    <button
                                        onclick={() => { isMenuOpen = false; browserStore.navigateActiveTab(item.href === "/" ? "bucks://newtab" : `bucks:/${item.href}`); }}
                                        class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/[0.05] transition-all group text-left active:scale-[0.98]"
                                    >
                                        <div class="w-7 h-7 rounded-lg bg-white/[0.04] border border-white/[0.06] flex items-center justify-center shrink-0">
                                            <Icon size={14} class={item.color} />
                                        </div>
                                        <span class="text-[12px] text-white/50 group-hover:text-white/80 transition-colors font-medium">{item.label}</span>
                                    </button>
                                {/each}
                            </div>
                        </div>

                        <!-- Services -->
                        <div>
                            <p class="text-[8px] uppercase tracking-[0.3em] text-white/25 font-bold px-2 mb-2">Services</p>
                            <div class="grid grid-cols-2 gap-1.5">
                                {#each [
                                    { emoji: "🔍", label: "Local Discovery",  desc: "Find nearby peers",      href: "bucks://superapp" },
                                    { emoji: "🚕", label: "Taxi Dispatch",    desc: "Book a ride",           href: "bucks://superapp" },
                                    { emoji: "🏪", label: "Provider Modes",   desc: "Set up your store",     href: "bucks://superapp" },
                                    { emoji: "🌐", label: "IPFS Storage",     desc: "Decentralised files",   href: "bucks://ipfs"     },
                                    { emoji: "💰", label: "Wallet",           desc: "Manage funds",          href: "bucks://wallet"   },
                                    { emoji: "🗂️", label: "Node Network",     desc: "Implementation status", href: "bucks://implementation" },
                                ] as svc}
                                    <button
                                        onclick={() => { isMenuOpen = false; browserStore.navigateActiveTab(svc.href); }}
                                        class="flex flex-col gap-1.5 p-3 rounded-2xl bg-white/[0.03] border border-white/[0.05] hover:bg-white/[0.07] hover:border-white/[0.1] transition-all text-left active:scale-[0.97] group"
                                    >
                                        <span class="text-xl">{svc.emoji}</span>
                                        <div>
                                            <p class="text-[11px] font-semibold text-white/65 group-hover:text-white/85 transition-colors leading-tight">{svc.label}</p>
                                            <p class="text-[9px] text-white/25 mt-0.5 leading-tight">{svc.desc}</p>
                                        </div>
                                    </button>
                                {/each}
                            </div>
                        </div>

                        <!-- Network status -->
                        <div>
                            <p class="text-[8px] uppercase tracking-[0.3em] text-white/25 font-bold px-2 mb-2">Network Stack</p>
                            <div class="rounded-2xl border border-white/[0.05] bg-white/[0.02] divide-y divide-white/[0.04] overflow-hidden">
                                {#each [
                                    { label: "DID Identity",  status: "active",  dot: "bg-emerald-400" },
                                    { label: "Signed Events", status: "active",  dot: "bg-emerald-400" },
                                    { label: "IPFS Node",     status: "active",  dot: "bg-emerald-400" },
                                    { label: "Locality Index",status: "planned", dot: "bg-white/20"    },
                                    { label: "P2P Relay",     status: "phase 2", dot: "bg-amber-400"   },
                                    { label: "Mock Staking",  status: "phase 3", dot: "bg-blue-400"    },
                                ] as row}
                                    <div class="flex items-center justify-between px-3 py-2">
                                        <div class="flex items-center gap-2">
                                            <span class="w-1.5 h-1.5 rounded-full {row.dot}"></span>
                                            <span class="text-[11px] text-white/50">{row.label}</span>
                                        </div>
                                        <span class="text-[9px] text-white/25 uppercase tracking-wide">{row.status}</span>
                                    </div>
                                {/each}
                            </div>
                        </div>
                    </div>

                    <!-- Footer -->
                    <div class="px-4 py-3 border-t border-white/[0.06] flex items-center justify-between">
                        <span class="text-[9px] text-white/20 uppercase tracking-[0.2em]">Bucks Browser v0.1</span>
                        <button
                            onclick={() => { isMenuOpen = false; browserStore.navigateActiveTab("bucks://settings"); }}
                            class="text-white/25 hover:text-white/60 transition-colors"
                        >
                            <Settings size={14} />
                        </button>
                    </div>
                </aside>
            </div>
        {/if}
    </div>
</header>
