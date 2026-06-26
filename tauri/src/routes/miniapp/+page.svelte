<script lang="ts">
    import { browserStore } from '$lib/stores';
    import { swarmStore } from '$lib/swarmStore';

    function openWallet() {
        browserStore.createOrFocusTab('bucks://wallet');
    }

    async function askAgent() {
        await swarmStore.sendQuery('Open the Mini App Lab.');
    }
</script>

<div class="min-h-[calc(100vh-5.5rem)] p-8 text-white">
    <div class="max-w-4xl mx-auto rounded-3xl border border-white/10 bg-white/5 backdrop-blur-xl p-8 shadow-2xl">
        <h1 class="text-4xl font-bold tracking-tight text-violet-200">Mini App Lab</h1>
        <p class="mt-4 text-lg text-slate-300">
            This is an internal Bucks mini-application shell. Use it to prototype AI-driven workflows, show agent actions, and test internal Bucks routes.
        </p>

        <div class="mt-8 grid gap-4 sm:grid-cols-2">
            <div class="rounded-3xl border border-white/10 bg-slate-950/60 p-6">
                <h2 class="text-xl font-semibold text-white">How to use it</h2>
                <ul class="mt-4 space-y-3 text-slate-300 list-disc list-inside">
                    <li>Keep the agent bar open and ask Bucks to open the Mini App Lab.</li>
                    <li>The AI can return <code>a2ui</code> JSON pointing at <code>bucks://miniapp</code>.</li>
                    <li>This page is implemented inside the browser shell, not in an external web app.</li>
                </ul>
            </div>

            <div class="rounded-3xl border border-white/10 bg-slate-950/60 p-6">
                <h2 class="text-xl font-semibold text-white">Quick actions</h2>
                <button
                    class="mt-4 w-full rounded-2xl bg-violet-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-violet-400"
                    on:click={askAgent}
                >
                    Ask Bucks to open Mini App Lab
                </button>
                <button
                    class="mt-3 w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
                    on:click={openWallet}
                >
                    Open Bucks Wallet
                </button>
            </div>
        </div>

        <div class="mt-10 rounded-3xl border border-white/10 bg-slate-950/70 p-6">
            <h2 class="text-xl font-semibold text-white">Prompt sample</h2>
            <p class="mt-3 text-slate-300">
                Try typing the following in the agent bar:
            </p>
            <pre class="mt-4 rounded-2xl bg-slate-900/90 p-4 text-sm text-emerald-200">
Open the Bucks Mini App Lab and show me the page content.
            </pre>
        </div>
    </div>
</div>
