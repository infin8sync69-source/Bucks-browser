<script lang="ts">
    import {
        ArrowRight,
        BriefcaseBusiness,
        Car,
        MapPin,
        MessageSquare,
        Network,
        RadioTower,
        Search,
        Store,
        UserRound,
        Wrench,
    } from "lucide-svelte";

    const modules = [
        {
            title: "Universal Profile",
            body: "One user identity for customer, driver, professional, business owner, and social graph.",
            icon: UserRound,
            status: "identity",
        },
        {
            title: "Vehicle Mode",
            body: "Add vehicle, go online, receive locality ride alerts, and accept first.",
            icon: Car,
            status: "provider",
        },
        {
            title: "Skill Mode",
            body: "Publish plumber, developer, designer, or other professional availability.",
            icon: Wrench,
            status: "provider",
        },
        {
            title: "Storefront Mode",
            body: "Create restaurants, shops, services, menus, products, and gallery listings.",
            icon: Store,
            status: "commerce",
        },
        {
            title: "P2P Messaging",
            body: "Direct encrypted messages with relay fallback when peers are offline.",
            icon: MessageSquare,
            status: "social",
        },
        {
            title: "Node Network",
            body: "Anyone can run relay, index, dispatch, bootstrap, or pinning nodes with stake.",
            icon: Network,
            status: "infra",
        },
    ];

    const searches = ["taxi near me", "plumber in Jayanagar", "biryani nearby", "full-stack developer"];
</script>

<svelte:head>
    <title>Bucks Super App</title>
</svelte:head>

<main class="min-h-screen overflow-auto bg-canvas text-fg pt-28 pb-16">
    <div class="mx-auto w-full max-w-6xl px-6">
        <section class="rounded-4xl border border-line-strong bg-surface-1 p-6 backdrop-blur-2xl">
            <div class="flex items-start justify-between gap-8">
                <div class="max-w-2xl">
                    <div class="inline-flex items-center gap-2 rounded-full border border-line-strong bg-scrim/20 px-3 py-1.5 text-3xs uppercase tracking-caps-wide text-fg-faint">
                        <RadioTower size={13} class="text-success-fg-strong" />
                        Bucks Super App Desktop
                    </div>
                    <h1 class="mt-6 text-5xl font-semibold tracking-display text-fg">
                        Search, connect, book, and transact through signed local-first profiles.
                    </h1>
                    <p class="mt-5 text-md leading-7 text-fg-faint">
                        This desktop surface is the control room for the P2P super app: universal profiles,
                        vehicle drivers, professional skillsets, business storefronts, feeds, gallery, messages,
                        IPFS storage, and decentralized locality discovery.
                    </p>
                </div>

                <div class="w-[320px] shrink-0 rounded-3xl border border-line-strong bg-scrim/20 p-4">
                    <div class="flex items-center gap-3">
                        <Search size={18} class="text-info-fg-strong" />
                        <div class="text-md font-semibold text-fg-muted">Discovery Examples</div>
                    </div>
                    <div class="mt-4 space-y-2">
                        {#each searches as search}
                            <div class="flex items-center justify-between rounded-2xl bg-surface-2 px-3 py-2">
                                <span class="text-xs text-fg-subtle">{search}</span>
                                <MapPin size={13} class="text-fg-faint" />
                            </div>
                        {/each}
                    </div>
                </div>
            </div>
        </section>

        <section class="mt-5 grid grid-cols-3 gap-4">
            {#each modules as item}
                {@const Icon = item.icon}
                <article class="group rounded-3xl border border-line-strong bg-surface-1 p-5 backdrop-blur-xl transition-all hover:-translate-y-0.5 hover:bg-surface-2">
                    <div class="flex items-start justify-between">
                        <div class="flex h-11 w-11 items-center justify-center rounded-2xl border border-line-strong bg-scrim/20">
                            <Icon size={19} class="text-fg-muted" />
                        </div>
                        <span class="rounded-full border border-line-strong bg-surface-2 px-2.5 py-1 text-3xs uppercase tracking-caps text-fg-faint">
                            {item.status}
                        </span>
                    </div>
                    <h2 class="mt-5 text-lg font-semibold tracking-tight text-fg">{item.title}</h2>
                    <p class="mt-2 min-h-[72px] text-sm leading-6 text-fg-faint">{item.body}</p>
                    <div class="mt-4 flex items-center gap-2 text-xs font-medium text-fg-faint transition-colors group-hover:text-fg-subtle">
                        Signed event first
                        <ArrowRight size={14} class="transition-transform group-hover:translate-x-1" />
                    </div>
                </article>
            {/each}
        </section>

        <section class="mt-5 grid grid-cols-[1fr_1fr] gap-4">
            <div class="rounded-3xl border border-line-strong bg-surface-1 p-5 backdrop-blur-xl">
                <div class="text-3xs uppercase tracking-caps-wide text-fg-faint">Dispatch Rule</div>
                <h2 class="mt-2 text-xl font-semibold text-fg-muted">First valid accept wins.</h2>
                <p class="mt-3 text-sm leading-6 text-fg-faint">
                    Ride requests are signed, broadcast to locality topics, accepted by online vehicle providers,
                    and resolved with atomic assignment so two drivers cannot win the same booking.
                </p>
            </div>

            <div class="rounded-3xl border border-line-strong bg-surface-1 p-5 backdrop-blur-xl">
                <div class="text-3xs uppercase tracking-caps-wide text-fg-faint">Search Rule</div>
                <h2 class="mt-2 text-xl font-semibold text-fg-muted">Index nodes verify, they do not own truth.</h2>
                <p class="mt-3 text-sm leading-6 text-fg-faint">
                    Search results come from signed provider and storefront events. Relays and indexers can speed up
                    discovery, but any client can verify the author, payload hash, and CID.
                </p>
            </div>
        </section>

        <section class="mt-5 rounded-3xl border border-line-strong bg-surface-1 p-5 backdrop-blur-xl">
            <div class="flex items-center gap-3">
                <BriefcaseBusiness size={18} class="text-agent-fg-strong" />
                <p class="text-sm leading-6 text-fg-faint">
                    Next UI pass: turn these cards into live forms for vehicle registration, skill profile setup,
                    storefront creation, locality search, ride request, and node staking.
                </p>
            </div>
        </section>
    </div>
</main>
