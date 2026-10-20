<script lang="ts">
    import {
        ArrowRight,
        CheckCircle2,
        Database,
        KeyRound,
        Network,
        RadioTower,
        Route,
        Search,
        Server,
        ShieldCheck,
        WalletCards,
    } from "lucide-svelte";

    const phases = [
        {
            id: "01",
            title: "Desktop Identity Layer",
            status: "Start here",
            icon: KeyRound,
            goal: "Create one universal DID/profile on device and make every user action signable.",
            tasks: [
                "Move DID/keypair creation into the Electron main process or an OS keychain.",
                "Store private keys in OS-secured storage, never in plain localStorage.",
                "Represent profile updates as signed events with payload hash and signature.",
            ],
            acceptance: "A profile can be exported/imported and every profile update verifies offline.",
        },
        {
            id: "02",
            title: "Provider Modes",
            status: "Super app core",
            icon: ShieldCheck,
            goal: "Let the same profile activate vehicle, skill, and business storefront modes.",
            tasks: [
                "Add provider-mode forms and local-first storage.",
                "Publish vehicle, skill, and storefront availability as signed P2P events.",
                "Show mode status in the desktop command center.",
            ],
            acceptance: "One user can go online as driver, plumber, and storefront without separate accounts.",
        },
        {
            id: "03",
            title: "Locality Discovery",
            status: "Index v1",
            icon: Search,
            goal: "Search nearby providers from signed events, not a trusted central database.",
            tasks: [
                "Build a local index from provider.activated and provider.availability events.",
                "Support locality, category, online status, and distance ranking.",
                "Expose index results in the desktop super-app page.",
            ],
            acceptance: "Searches like plumber, biryani, and taxi return relevant local profiles.",
        },
        {
            id: "04",
            title: "Ride Dispatch",
            status: "Realtime v1",
            icon: Route,
            goal: "Broadcast ride requests to nearby online drivers with first-accept-wins assignment.",
            tasks: [
                "Create signed ride.requested and ride.accepted event types.",
                "Use atomic local state for first valid driver acceptance.",
                "Queue events for relay when direct P2P is unavailable.",
            ],
            acceptance: "Two drivers accepting the same ride cannot both win.",
        },
        {
            id: "05",
            title: "P2P Transport",
            status: "Hybrid network",
            icon: Network,
            goal: "Sync profiles, provider state, ride requests, messages, and feed events over libp2p/IPFS.",
            tasks: [
                "Add topic conventions for locality, providers, rides, feed, and messages.",
                "Use relay/store-and-forward for offline delivery.",
                "Persist every outbound event in an outbox before publish.",
            ],
            acceptance: "The app keeps working locally and syncs when peers or relays return.",
        },
        {
            id: "06",
            title: "Mock Wallet + Staking",
            status: "Chain-ready",
            icon: WalletCards,
            goal: "Mock staking, escrow, rewards, and slashing behind interfaces ready for Bucks contracts.",
            tasks: [
                "Create mock wallet balances and payment holds.",
                "Register bootstrap, relay, index, dispatch, and pinning nodes with mock stakes.",
                "Log slashable evidence as signed events.",
            ],
            acceptance: "Business logic does not need to change when real contracts replace mocks.",
        },
    ];

    const stack = [
        { label: "Desktop", value: "Electron + SvelteKit" },
        { label: "Identity", value: "DID + signed events" },
        { label: "Storage", value: "Local DB + IPFS CIDs" },
        { label: "Network", value: "libp2p topics + relays" },
        { label: "Search", value: "Local verified index" },
        { label: "Wallet", value: "Mock now, contracts later" },
    ];
</script>

<svelte:head>
    <title>Bucks Implementation Phases</title>
</svelte:head>

<main class="min-h-screen overflow-auto bg-canvas text-fg pt-28 pb-16">
    <div class="mx-auto w-full max-w-6xl px-6">
        <section class="grid grid-cols-[minmax(0,1fr)_360px] gap-6 items-start">
            <div>
                <div class="inline-flex items-center gap-2 rounded-full border border-line-strong bg-surface-2 px-3 py-1.5 text-3xs uppercase tracking-caps-wide text-fg-faint">
                    <RadioTower size={13} class="text-success-fg-strong" />
                    Desktop P2P Build Plan
                </div>
                <h1 class="mt-6 text-5xl font-semibold tracking-display text-fg">
                    Phase-by-phase setup for the Bucks super app.
                </h1>
                <p class="mt-5 max-w-2xl text-md leading-7 text-fg-faint">
                    This sequence keeps the desktop shell usable while moving trust from central services
                    into signed local events, IPFS content, peer discovery, relay/index nodes, and future
                    Bucks-chain contracts.
                </p>
            </div>

            <aside class="rounded-3xl border border-line-strong bg-surface-2 p-5 backdrop-blur-2xl">
                <div class="flex items-center gap-3">
                    <div class="flex h-10 w-10 items-center justify-center rounded-2xl border border-line-strong bg-scrim/20">
                        <Database size={18} class="text-agent-fg-strong" />
                    </div>
                    <div>
                        <div class="text-3xs uppercase tracking-caps text-fg-faint">Architecture Bias</div>
                        <div class="text-md font-semibold text-fg-muted">Local-first, verifiable sync</div>
                    </div>
                </div>

                <div class="mt-5 space-y-2">
                    {#each stack as item}
                        <div class="flex items-center justify-between gap-3 rounded-2xl bg-scrim/18 px-3 py-2.5">
                            <span class="text-2xs text-fg-faint">{item.label}</span>
                            <span class="text-2xs font-medium text-fg-muted">{item.value}</span>
                        </div>
                    {/each}
                </div>
            </aside>
        </section>

        <section class="mt-10 grid grid-cols-2 gap-4">
            {#each phases as phase}
                {@const Icon = phase.icon}
                <article class="rounded-3xl border border-line-strong bg-surface-1 p-5 backdrop-blur-xl">
                    <div class="flex items-start justify-between gap-4">
                        <div class="flex items-center gap-3">
                            <div class="flex h-11 w-11 items-center justify-center rounded-2xl border border-line-strong bg-scrim/20">
                                <Icon size={19} class="text-fg-muted" />
                            </div>
                            <div>
                                <div class="text-3xs uppercase tracking-caps text-fg-faint">Phase {phase.id}</div>
                                <h2 class="mt-1 text-lg font-semibold tracking-tight text-fg">{phase.title}</h2>
                            </div>
                        </div>
                        <span class="rounded-full border border-line-strong bg-surface-2 px-2.5 py-1 text-3xs text-fg-faint">
                            {phase.status}
                        </span>
                    </div>

                    <p class="mt-4 text-sm leading-6 text-fg-faint">{phase.goal}</p>

                    <div class="mt-4 space-y-2">
                        {#each phase.tasks as task}
                            <div class="flex gap-2 rounded-2xl bg-scrim/16 px-3 py-2">
                                <CheckCircle2 size={14} class="mt-0.5 shrink-0 text-success-fg-strong/70" />
                                <span class="text-xs leading-5 text-fg-subtle">{task}</span>
                            </div>
                        {/each}
                    </div>

                    <div class="mt-4 flex items-start gap-2 rounded-2xl border border-line bg-surface-1 px-3 py-2.5">
                        <ArrowRight size={14} class="mt-0.5 shrink-0 text-info-fg-strong/70" />
                        <span class="text-2xs leading-5 text-fg-faint">{phase.acceptance}</span>
                    </div>
                </article>
            {/each}
        </section>

        <section class="mt-5 rounded-3xl border border-line-strong bg-surface-1 p-5 backdrop-blur-xl">
            <div class="flex items-center gap-3">
                <div class="flex h-10 w-10 items-center justify-center rounded-2xl border border-line-strong bg-scrim/20">
                    <Server size={18} class="text-warning-fg-strong" />
                </div>
                <div>
                    <h2 class="text-base font-semibold text-fg-muted">Implementation rule</h2>
                    <p class="mt-1 text-xs text-fg-faint">
                        Every feature should work locally first, write a signed event second, publish to P2P third,
                        and only then depend on relays, indexers, staking, or chain settlement.
                    </p>
                </div>
            </div>
        </section>
    </div>
</main>
