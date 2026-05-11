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

<main class="min-h-screen overflow-auto bg-[#050507] text-white pt-28 pb-16">
    <div class="mx-auto w-full max-w-6xl px-6">
        <section class="rounded-[32px] border border-white/10 bg-white/[0.035] p-6 backdrop-blur-2xl">
            <div class="flex items-start justify-between gap-8">
                <div class="max-w-2xl">
                    <div class="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-[10px] uppercase tracking-[0.28em] text-white/45">
                        <RadioTower size={13} class="text-emerald-200" />
                        Bucks Super App Desktop
                    </div>
                    <h1 class="mt-6 text-5xl font-semibold tracking-[-0.04em] text-white/92">
                        Search, connect, book, and transact through signed local-first profiles.
                    </h1>
                    <p class="mt-5 text-sm leading-7 text-white/45">
                        This desktop surface is the control room for the P2P super app: universal profiles,
                        vehicle drivers, professional skillsets, business storefronts, feeds, gallery, messages,
                        IPFS storage, and decentralized locality discovery.
                    </p>
                </div>

                <div class="w-[320px] shrink-0 rounded-[26px] border border-white/10 bg-black/20 p-4">
                    <div class="flex items-center gap-3">
                        <Search size={18} class="text-sky-200" />
                        <div class="text-sm font-semibold text-white/78">Discovery Examples</div>
                    </div>
                    <div class="mt-4 space-y-2">
                        {#each searches as search}
                            <div class="flex items-center justify-between rounded-2xl bg-white/[0.04] px-3 py-2">
                                <span class="text-[12px] text-white/55">{search}</span>
                                <MapPin size={13} class="text-white/25" />
                            </div>
                        {/each}
                    </div>
                </div>
            </div>
        </section>

        <section class="mt-5 grid grid-cols-3 gap-4">
            {#each modules as item}
                {@const Icon = item.icon}
                <article class="group rounded-[26px] border border-white/10 bg-white/[0.035] p-5 backdrop-blur-xl transition-all hover:-translate-y-0.5 hover:bg-white/[0.055]">
                    <div class="flex items-start justify-between">
                        <div class="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-black/20">
                            <Icon size={19} class="text-white/75" />
                        </div>
                        <span class="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-white/30">
                            {item.status}
                        </span>
                    </div>
                    <h2 class="mt-5 text-lg font-semibold tracking-[-0.02em] text-white/88">{item.title}</h2>
                    <p class="mt-2 min-h-[72px] text-[13px] leading-6 text-white/45">{item.body}</p>
                    <div class="mt-4 flex items-center gap-2 text-[12px] font-medium text-white/38 transition-colors group-hover:text-white/65">
                        Signed event first
                        <ArrowRight size={14} class="transition-transform group-hover:translate-x-1" />
                    </div>
                </article>
            {/each}
        </section>

        <section class="mt-5 grid grid-cols-[1fr_1fr] gap-4">
            <div class="rounded-[26px] border border-white/10 bg-white/[0.035] p-5 backdrop-blur-xl">
                <div class="text-[10px] uppercase tracking-[0.28em] text-white/28">Dispatch Rule</div>
                <h2 class="mt-2 text-xl font-semibold text-white/85">First valid accept wins.</h2>
                <p class="mt-3 text-[13px] leading-6 text-white/45">
                    Ride requests are signed, broadcast to locality topics, accepted by online vehicle providers,
                    and resolved with atomic assignment so two drivers cannot win the same booking.
                </p>
            </div>

            <div class="rounded-[26px] border border-white/10 bg-white/[0.035] p-5 backdrop-blur-xl">
                <div class="text-[10px] uppercase tracking-[0.28em] text-white/28">Search Rule</div>
                <h2 class="mt-2 text-xl font-semibold text-white/85">Index nodes verify, they do not own truth.</h2>
                <p class="mt-3 text-[13px] leading-6 text-white/45">
                    Search results come from signed provider and storefront events. Relays and indexers can speed up
                    discovery, but any client can verify the author, payload hash, and CID.
                </p>
            </div>
        </section>

        <section class="mt-5 rounded-[26px] border border-white/10 bg-white/[0.035] p-5 backdrop-blur-xl">
            <div class="flex items-center gap-3">
                <BriefcaseBusiness size={18} class="text-violet-200" />
                <p class="text-[13px] leading-6 text-white/48">
                    Next UI pass: turn these cards into live forms for vehicle registration, skill profile setup,
                    storefront creation, locality search, ride request, and node staking.
                </p>
            </div>
        </section>
    </div>
</main>
