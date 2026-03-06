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
    } from "lucide-svelte";
    import { fade, scale } from "svelte/transition";
    import { cubicOut } from "svelte/easing";
    import { Window } from "@tauri-apps/api/window";

    const appWindow = new Window("main");

    let isMenuOpen = $state(false);
    let isSettingsOpen = $state(false);
    let urlInput = $state("");

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
            href: "/services",
            color: "text-emerald-400",
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

    function handleUrlSubmit(e: SubmitEvent) {
        e.preventDefault();
        const input = urlInput.trim();
        if (!input) return;

        const isURL = (str: string) => {
            if (/^(https?:\/\/|file:\/\/|ipfs:\/\/|ipns:\/\/)/i.test(str))
                return true;
            if (/^[\w-]+(\.[\w-]+)+/.test(str) && !str.includes(" "))
                return true;
            return false;
        };

        const targetUrl = isURL(input)
            ? /^(https?:\/\/|file:\/\/|ipfs:\/\/|ipns:\/\/)/i.test(input)
                ? input
                : `https://${input}`
            : `https://duckduckgo.com/?q=${encodeURIComponent(input)}`;

        if ($browserStore.activeTabId) {
            browserStore.navigateActiveTab(targetUrl);
        } else {
            browserStore.createTab(targetUrl);
        }
    }
</script>

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
                        bind:value={urlInput}
                        placeholder="Explore the swarm..."
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
                                    browserStore.createOrFocusTab(
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
                                    browserStore.createOrFocusTab(
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
                                    browserStore.createOrFocusTab(
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

        <!-- Enhanced Menu: Truly Centered High-Fidelity Overlay -->
        {#if isMenuOpen}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                role="button"
                tabindex="0"
                class="fixed inset-0 bg-black/80 backdrop-blur-md z-[120] pointer-events-auto"
                onclick={() => (isMenuOpen = false)}
                onkeydown={(e) =>
                    (e.key === "Enter" || e.key === " ") &&
                    (isMenuOpen = false)}
                transition:fade={{ duration: 500 }}
            >
                <section
                    onclick={(e) => e.stopPropagation()}
                    onkeydown={(e) => e.stopPropagation()}
                    transition:scale={{
                        duration: 600,
                        easing: cubicOut,
                        start: 0.95,
                        opacity: 0,
                    }}
                    class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[640px] bg-[#0a0a0c]/90 backdrop-blur-3xl rounded-[3rem] p-10 shadow-[0_0_120px_-20px_rgba(0,0,0,1)] border border-white/5 flex flex-col items-center"
                >
                    <div
                        class="flex flex-col space-y-3 w-full max-h-[60vh] overflow-y-auto no-scrollbar pr-2"
                    >
                        {#each menuItems as item}
                            {@const Icon = item.icon}
                            <button
                                onclick={(e) => {
                                    e.preventDefault();
                                    isMenuOpen = false;
                                    browserStore.createOrFocusTab(
                                        item.href === "/"
                                            ? "bucks://newtab"
                                            : `bucks:/${item.href}`,
                                    );
                                }}
                                class="flex items-center space-x-6 p-5 rounded-[2rem] bg-white/[0.02] border border-white/[0.04] hover:bg-white/[0.07] hover:border-white/[0.1] hover:shadow-xl transition-all duration-500 group relative overflow-hidden active:scale-[0.98]"
                            >
                                <div
                                    class="absolute -right-12 -top-12 w-32 h-32 bg-gradient-to-br {item.color.replace(
                                        'text-',
                                        'from-',
                                    )}/10 blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-1000"
                                ></div>

                                <div
                                    class="w-14 h-14 rounded-2xl bg-white/[0.03] flex items-center justify-center group-hover:scale-110 transition-transform duration-500 border border-white/5"
                                >
                                    <Icon
                                        size={24}
                                        class="{item.color} group-hover:rotate-6 transition-all duration-500"
                                    />
                                </div>

                                <div class="flex-1 text-left relative z-10">
                                    <span
                                        class="block text-[14px] font-black uppercase tracking-[0.3em] text-white/50 group-hover:text-white transition-colors"
                                        >{item.label}</span
                                    >
                                    <span
                                        class="block text-[9px] text-white/20 uppercase tracking-[0.2em] mt-1.5 font-bold group-hover:text-white/40 transition-colors"
                                        >Digital Swarm Access Node</span
                                    >
                                </div>

                                <div
                                    class="opacity-0 group-hover:opacity-100 transition-opacity pr-4"
                                >
                                    <div
                                        class="w-2 h-2 rounded-full {item.color.replace(
                                            'text-',
                                            'bg-',
                                        )} shadow-[0_0_10px_currentColor]"
                                    ></div>
                                </div>
                            </button>
                        {/each}
                    </div>

                    <div
                        class="mt-8 w-full pt-8 border-t border-white/5 flex items-center justify-between px-6"
                    >
                        <div class="flex items-center space-x-4">
                            <div
                                class="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 via-purple-500 to-pink-500 p-[1.5px] shadow-lg shadow-blue-500/10"
                            >
                                <div
                                    class="w-full h-full rounded-[14px] bg-black flex items-center justify-center"
                                >
                                    <User size={20} class="text-white" />
                                </div>
                            </div>
                            <div>
                                <p
                                    class="text-[12px] font-black text-white uppercase tracking-[0.2em]"
                                >
                                    Master Identity
                                </p>
                                <div class="flex items-center space-x-2 mt-1">
                                    <span
                                        class="w-2 h-2 bg-blue-500 rounded-full animate-pulse shadow-[0_0_8px_blue]"
                                    ></span>
                                    <p
                                        class="text-[9px] text-white/30 uppercase tracking-[0.3em] font-bold"
                                    >
                                        Synchronized
                                    </p>
                                </div>
                            </div>
                        </div>
                        <button
                            class="px-6 py-3 rounded-2xl bg-white/5 hover:bg-white/10 text-[10px] font-black uppercase tracking-[0.3em] text-white/50 hover:text-white transition-all border border-white/5 active:scale-95"
                        >
                            Switch Node
                        </button>
                    </div>

                    <button
                        onclick={() => (isMenuOpen = false)}
                        class="mt-6 text-white/20 hover:text-white/40 transition-colors uppercase text-[9px] tracking-[0.6em] font-black"
                    >
                        Close Overlay
                    </button>
                </section>
            </div>
        {/if}
    </div>
</header>
