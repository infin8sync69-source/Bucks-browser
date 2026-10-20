<script lang="ts">
    import { duration as motion } from '$design/dist/tokens.js';
    // The agent's chat drawer: threads, the model picker, a composer with attachments (files and
    // IPFS CIDs), slash commands and "act in this tab", live progress with approvals and Stop,
    // and per-answer copy / save as document or PDF.
    import { fade, fly } from "svelte/transition";
    import { cubicOut } from "svelte/easing";
    import { onMount, tick } from "svelte";
    import { swarmStore, type ComposerAttachment, type Message } from "./swarmStore";
    import { isSwarmThinking, browserStore, activeTab } from "./stores";
    import { settingsStore } from "./settingsStore";
    import { bucks } from "./bridge";
    import { errorMessage } from "./format";
    import GenUiCards from "./GenUiCards.svelte";
    import ModelPicker from "./newtab/ModelPicker.svelte";
    import ApprovalCard from "./agent/ApprovalCard.svelte";
    import SlashMenu from "./agent/SlashMenu.svelte";
    import ThreadList from "./agent/ThreadList.svelte";
    import { suggestSlash, type SlashCommand } from "./agent/slash";
    import { titleFrom } from "./agent/threads";
    import {
        Send, X, Plus, Zap, User, ChevronDown, Paperclip, Hexagon, MousePointerClick, Square,
        MessagesSquare, SlidersHorizontal, Copy, FileText, FileDown, FolderOpen,
    } from "lucide-svelte";

    let {
        isOnline = null,
        slmReady = false,
        model = null,
        onclose = () => {},
    }: { isOnline?: boolean | null; slmReady?: boolean; model?: string | null; onclose?: () => void } = $props();

    const MAX_FILE_BYTES = 5 * 1024 * 1024;
    const MAX_ATTACHMENTS = 8;

    let query = $state("");
    let textareaEl: HTMLTextAreaElement;
    let fileInput: HTMLInputElement;
    let scrollEl: HTMLDivElement;
    let atBottom = $state(true);
    let attachments = $state<ComposerAttachment[]>([]);
    let cidOpen = $state(false);
    let cidInput = $state("");
    let composerError = $state("");
    let agentic = $state(false);
    let slashIndex = $state(0);
    let threadsOpen = $state(false);
    let pickerOpen = $state(false);
    let dragOver = $state(false);
    /** Per-message feedback for the copy / save buttons, keyed by message ts. */
    let saved = $state<Record<number, { text: string; path?: string }>>({});

    const slashItems = $derived(suggestSlash(query));
    const provider = $derived($settingsStore?.agent.provider ?? $swarmStore.provider);
    const canAct = $derived(provider === "soul" && $activeTab?.type === "external");
    const threadTitle = $derived($swarmStore.threads.find((t) => t.id === $swarmStore.threadId)?.title ?? "New chat");

    $effect(() => {
        void slashItems.length;
        slashIndex = 0;
    });
    $effect(() => {
        if (!canAct) agentic = false;
    });

    // Auto-scroll to bottom when messages, progress or approvals change
    $effect(() => {
        void $swarmStore.messages;
        void $swarmStore.status;
        void $swarmStore.approvals;
        if (atBottom) tick().then(scrollToBottom);
    });

    $effect(() => {
        if (!pickerOpen) return;
        const close = () => (pickerOpen = false);
        window.addEventListener("click", close);
        return () => window.removeEventListener("click", close);
    });

    function scrollToBottom() {
        if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    }

    function onScroll() {
        if (!scrollEl) return;
        atBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 40;
    }

    function autoGrow() {
        if (!textareaEl) return;
        textareaEl.style.height = "auto";
        textareaEl.style.height = Math.min(textareaEl.scrollHeight, 160) + "px";
    }

    function pickSlash(c: SlashCommand) {
        query = `${c.cmd} `;
        if (c.cmd === "/agent" && canAct) agentic = true;
        tick().then(() => textareaEl?.focus());
    }

    function handleKeydown(e: KeyboardEvent) {
        if (slashItems.length) {
            if (e.key === "ArrowDown") { e.preventDefault(); slashIndex = (slashIndex + 1) % slashItems.length; return; }
            if (e.key === "ArrowUp") { e.preventDefault(); slashIndex = (slashIndex - 1 + slashItems.length) % slashItems.length; return; }
            if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && query.trim() !== slashItems[slashIndex]?.cmd)) {
                e.preventDefault();
                pickSlash(slashItems[slashIndex]);
                return;
            }
            if (e.key === "Escape") { query = ""; return; }
        }
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
        }
    }

    function submit() {
        if ((!query.trim() && !attachments.length) || $isSwarmThinking) return;
        void swarmStore.sendQuery(query.trim(), { attachments, agentic });
        query = "";
        attachments = [];
        composerError = "";
        tick().then(() => {
            if (textareaEl) { textareaEl.style.height = "auto"; textareaEl.focus(); }
        });
    }

    // ── attachments ──
    function readAsDataUrl(file: File): Promise<string> {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result as string);
            r.onerror = () => reject(r.error ?? new Error("Could not read the file"));
            r.readAsDataURL(file);
        });
    }

    async function addFiles(list: FileList | File[] | null) {
        composerError = "";
        for (const file of Array.from(list ?? [])) {
            if (attachments.length >= MAX_ATTACHMENTS) { composerError = `At most ${MAX_ATTACHMENTS} attachments.`; break; }
            if (file.size > MAX_FILE_BYTES) { composerError = `${file.name} is larger than 5 MB.`; continue; }
            try {
                const dataBase64 = await readAsDataUrl(file);
                attachments = [...attachments, { kind: "file", name: file.name, mime: file.type || "", dataBase64, label: file.name }];
            } catch (e) {
                composerError = errorMessage(e);
            }
        }
        if (fileInput) fileInput.value = "";
    }

    function addCid() {
        const cid = cidInput.trim().replace(/^ipfs:\/\//i, "");
        if (!/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,100})(\/\S*)?$/.test(cid)) { composerError = "That is not an IPFS CID (bafy… or Qm…)."; return; }
        if (attachments.length >= MAX_ATTACHMENTS) { composerError = `At most ${MAX_ATTACHMENTS} attachments.`; return; }
        attachments = [...attachments, { kind: "cid", cid, label: `ipfs://${cid.length > 24 ? `${cid.slice(0, 12)}…${cid.slice(-6)}` : cid}` }];
        cidInput = "";
        cidOpen = false;
        composerError = "";
    }

    function onDrop(e: DragEvent) {
        e.preventDefault();
        dragOver = false;
        if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files);
    }

    // ── per-answer actions ──
    function questionBefore(msg: Message): string {
        const i = $swarmStore.messages.indexOf(msg);
        for (let j = i - 1; j >= 0; j--) if ($swarmStore.messages[j].role === "user") return $swarmStore.messages[j].content;
        return threadTitle;
    }

    async function copyAnswer(msg: Message) {
        try {
            await navigator.clipboard.writeText(msg.content);
            saved = { ...saved, [msg.ts]: { text: "Copied" } };
        } catch (e) {
            saved = { ...saved, [msg.ts]: { text: `Copy failed: ${errorMessage(e)}` } };
        }
    }

    async function saveAnswer(msg: Message, format: "md" | "pdf") {
        saved = { ...saved, [msg.ts]: { text: format === "pdf" ? "Writing the PDF…" : "Saving…" } };
        try {
            const r = await bucks.docs.create({ title: titleFrom(questionBefore(msg)), content: msg.content, format });
            saved = { ...saved, [msg.ts]: { text: `Saved ${r.path.split(/[\\/]/).pop()}`, path: r.path } };
        } catch (e) {
            saved = { ...saved, [msg.ts]: { text: errorMessage(e) } };
        }
    }

    const showInFolder = (path: string) => bucks.docs.showInFolder(path).catch(() => {});
    const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

    const SUGGESTIONS = [
        "🌤️ Check the weather",
        "📰 Latest crypto news",
        "🔎 /summarize",
        "🧭 /agent find the pricing page",
        "🌐 Upload to IPFS",
        "📄 /report IPFS pinning services",
    ];

    function suggest(s: string) {
        query = s.replace(/^[\p{Emoji}\s]+/u, "").trim();
        if (query.startsWith("/agent")) { textareaEl?.focus(); if (canAct) agentic = true; return; }
        submit();
    }

    function fmtTime(ts: number) {
        return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    // Simple markdown-ish renderer (bold, inline code, links, line breaks); everything else is escaped.
    function renderContent(text: string): string {
        return text
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
            .replace(/`(.*?)`/g, "<code>$1</code>")
            // [label](https://…) → a link that openLink() opens in a new tab. The URL cannot contain
            // quotes or spaces, so it cannot break out of the attribute.
            .replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)"'<>]{1,2048})\)/g, '<a data-href="$2" class="text-agent-fg-strong underline decoration-agent-fg/40 cursor-pointer hover:text-agent-fg-strong">$1</a>')
            .replace(/\n/g, "<br>");
    }

    /** Links in agent answers open in a new tab; the chrome window itself never navigates. */
    function openLink(e: MouseEvent) {
        const a = (e.target as HTMLElement | null)?.closest?.("a[data-href]");
        if (!a) return;
        e.preventDefault();
        browserStore.createTab(a.getAttribute("data-href") ?? "");
    }

    onMount(() => textareaEl?.focus());
</script>

<!-- Panel: sits below the header island; the web content area shrinks to its left (see ContentArea) -->
<div
    class="fixed right-0 top-chrome-top bottom-0 z-drawer-raised w-full max-w-chat-panel flex flex-col bg-surface-raised border-l border-line shadow-2xl"
    transition:fly={{ x: 440, duration: motion.moderate, easing: cubicOut }}
    ondragover={(e) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); dragOver = true; } }}
    ondragleave={(e) => { if (e.currentTarget === e.target) dragOver = false; }}
    ondrop={onDrop}
    role="complementary"
    aria-label="Agent chat"
>
    <!-- ── Header ─────────────────────────────────────────────────────────── -->
    <div class="relative flex items-center gap-3 px-4 py-3.5 border-b border-line flex-shrink-0">
        <div class="w-8 h-8 rounded-full bg-gradient-to-br from-agent-emphasis to-cat-indigo-strong flex items-center justify-center flex-shrink-0">
            <Zap size={14} class="text-on-emphasis" />
        </div>

        <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
                <span class="text-fg text-md font-semibold tracking-wide truncate" title={threadTitle}>{$swarmStore.messages.length ? threadTitle : "Bucks AI"}</span>
                <span class="relative flex h-2 w-2 flex-shrink-0">
                    {#if isOnline}
                        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-40"></span>
                        <span class="relative inline-flex rounded-full h-2 w-2 bg-success"></span>
                    {:else}
                        <span class="relative inline-flex rounded-full h-2 w-2 bg-fg-disabled"></span>
                    {/if}
                </span>
            </div>
            <p class="text-3xs text-fg-faint font-medium tracking-wider uppercase mt-0.5 truncate">
                {slmReady ? `${model ?? "local model"} on-device` : model ? `${provider} · ${model}` : provider === "offline" ? "offline rules" : provider}
            </p>
        </div>

        <div class="flex items-center gap-1">
            <button onclick={() => (threadsOpen = true)} title="Chats" aria-label="Chats"
                class="p-2 rounded-lg text-fg-faint hover:text-fg-muted hover:bg-surface-2 transition-colors"><MessagesSquare size={14} /></button>
            <button onclick={() => swarmStore.newChat()} title="New chat" aria-label="New chat" disabled={$isSwarmThinking}
                class="p-2 rounded-lg text-fg-faint hover:text-fg-muted hover:bg-surface-2 disabled:opacity-30 transition-colors"><Plus size={15} /></button>
            <div class="relative">
                <button onclick={(e) => { e.stopPropagation(); pickerOpen = !pickerOpen; }} title="Choose model" aria-label="Choose model" aria-expanded={pickerOpen}
                    class="p-2 rounded-lg text-fg-faint hover:text-fg-muted hover:bg-surface-2 transition-colors"><SlidersHorizontal size={14} /></button>
                {#if pickerOpen}<ModelPicker onclose={() => (pickerOpen = false)} />{/if}
            </div>
            <button onclick={onclose} title="Close" aria-label="Close chat"
                class="p-2 rounded-lg text-fg-faint hover:text-fg-muted hover:bg-surface-2 transition-colors"><X size={15} /></button>
        </div>
    </div>

    <div class="relative flex-1 min-h-0 flex flex-col">
        {#if threadsOpen}<ThreadList onclose={() => (threadsOpen = false)} />{/if}

        <!-- ── Messages ──────────────────────────────────────────────────── -->
        <div
            bind:this={scrollEl}
            onscroll={onScroll}
            class="flex-1 overflow-y-auto px-4 py-4 space-y-5 scroll-smooth"
            style="scrollbar-width: thin; scrollbar-color: var(--bucks-color-surface-3) transparent;"
        >
            {#if $swarmStore.messages.length === 0}
                <div class="flex flex-col items-center justify-center h-full gap-6 pb-8" transition:fade>
                    <div class="w-16 h-16 rounded-2xl bg-gradient-to-br from-agent/20 to-cat-indigo/20 border border-agent/20 flex items-center justify-center">
                        <Zap size={28} class="text-agent-fg" />
                    </div>
                    <div class="text-center">
                        <p class="text-fg-muted text-base font-medium">How can I help?</p>
                        <p class="text-fg-faint text-xs mt-1">Ask anything, attach files or CIDs, or type / for commands</p>
                    </div>
                    <div class="grid grid-cols-2 gap-2 w-full">
                        {#each SUGGESTIONS as s}
                            <button
                                onclick={() => suggest(s)}
                                class="text-left px-3 py-2.5 rounded-xl bg-surface-1 hover:bg-surface-3 border border-line hover:border-line-strong text-fg-subtle hover:text-fg text-xs transition-all duration-base"
                            >{s}</button>
                        {/each}
                    </div>
                </div>
            {:else}
                {#each $swarmStore.messages as msg (msg.ts)}
                    {#if msg.role === "user"}
                        <div class="flex justify-end gap-2.5" transition:fly={{ y: 10, duration: motion.base }}>
                            <div class="max-w-[82%]">
                                <div class="bg-agent/80 text-fg text-md px-4 py-2.5 rounded-2xl rounded-tr-md leading-relaxed whitespace-pre-wrap break-words">{msg.content}</div>
                                {#if msg.attachments?.length}
                                    <div class="mt-1 flex flex-wrap justify-end gap-1">
                                        {#each msg.attachments as a (a)}
                                            <span class="text-3xs text-agent-fg-strong/70 bg-agent/10 border border-agent/20 rounded-full px-2 py-0.5 max-w-[200px] truncate">📎 {a}</span>
                                        {/each}
                                    </div>
                                {/if}
                                <p class="text-3xs text-fg-faint mt-1 text-right">{fmtTime(msg.ts)}</p>
                            </div>
                            <div class="w-7 h-7 rounded-full bg-surface-4 flex items-center justify-center flex-shrink-0 mt-0.5">
                                <User size={13} class="text-fg-muted" />
                            </div>
                        </div>

                    {:else if msg.role === "agent"}
                        <div class="group flex gap-2.5" transition:fly={{ y: 10, duration: motion.base }}>
                            <div class="w-7 h-7 rounded-full bg-gradient-to-br from-agent-emphasis to-cat-indigo-strong flex items-center justify-center flex-shrink-0 mt-0.5">
                                <Zap size={12} class="text-on-emphasis" />
                            </div>
                            <div class="max-w-[82%] min-w-0">
                                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                                <div onclick={openLink} class="bg-surface-2 border border-line text-fg text-md px-4 py-2.5 rounded-2xl rounded-tl-md leading-relaxed break-words">
                                    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                                    {@html renderContent(msg.content)}

                                    {#if msg.a2ui && msg.a2ui.type !== "text"}
                                        <div class="mt-2.5 pt-2.5 border-t border-line flex flex-wrap gap-1.5">
                                            {#if msg.a2ui.type === "navigate" && msg.a2ui.url}
                                                <span class="inline-flex items-center gap-1 text-3xs text-agent-fg bg-agent/10 border border-agent/20 rounded-full px-2.5 py-0.5">↗ {msg.a2ui.url}</span>
                                            {:else if msg.a2ui.type === "search" && msg.a2ui.content}
                                                <span class="inline-flex items-center gap-1 text-3xs text-info-fg bg-info/10 border border-info/20 rounded-full px-2.5 py-0.5">🔍 {msg.a2ui.content}</span>
                                            {:else if msg.a2ui.type === "action"}
                                                <span class="inline-flex items-center gap-1 text-3xs text-success-fg bg-success/10 border border-success/20 rounded-full px-2.5 py-0.5">⚡ {msg.a2ui.action?.replace(/_/g, " ")}</span>
                                            {/if}
                                        </div>
                                    {/if}
                                </div>
                                {#if msg.components?.length}
                                    <GenUiCards components={msg.components} />
                                {/if}
                                {#if msg.documents?.length}
                                    <div class="mt-2 space-y-1">
                                        {#each msg.documents as d (d)}
                                            <button onclick={() => showInFolder(d)} title={d}
                                                class="w-full flex items-center gap-2 rounded-xl border border-line bg-surface-1 hover:bg-surface-3 px-3 py-2 text-left">
                                                <FileText size={14} class="text-agent-fg-strong flex-shrink-0" />
                                                <span class="text-xs text-fg-muted truncate">{fileName(d)}</span>
                                                <span class="ml-auto flex items-center gap-1 text-3xs text-fg-faint flex-shrink-0"><FolderOpen size={11} /> Show</span>
                                            </button>
                                        {/each}
                                    </div>
                                {/if}
                                {#if msg.followups?.length}
                                    <div class="mt-2 flex flex-wrap gap-1.5">
                                        {#each msg.followups as q (q)}
                                            <button
                                                onclick={() => swarmStore.sendQuery(q)}
                                                disabled={$isSwarmThinking}
                                                class="text-left text-2xs text-agent-fg-strong/90 bg-agent/10 hover:bg-agent/20 border border-agent/20 rounded-xl px-2.5 py-1 disabled:opacity-40 transition-colors"
                                            >{q}</button>
                                        {/each}
                                    </div>
                                {/if}
                                <div class="mt-1 flex items-center gap-1 min-h-[22px]">
                                    <p class="text-3xs text-fg-faint mr-1">{fmtTime(msg.ts)}</p>
                                    {#if msg.content.trim()}
                                        <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                                            <button onclick={() => copyAnswer(msg)} title="Copy" aria-label="Copy answer" class="p-1 rounded-md text-fg-faint hover:text-fg hover:bg-surface-2"><Copy size={11} /></button>
                                            <button onclick={() => saveAnswer(msg, "md")} title="Save as a document (Markdown)" aria-label="Save answer as document" class="p-1 rounded-md text-fg-faint hover:text-fg hover:bg-surface-2"><FileText size={11} /></button>
                                            <button onclick={() => saveAnswer(msg, "pdf")} title="Save as PDF" aria-label="Save answer as PDF" class="p-1 rounded-md text-fg-faint hover:text-fg hover:bg-surface-2"><FileDown size={11} /></button>
                                        </div>
                                    {/if}
                                    {#if saved[msg.ts]}
                                        {@const s = saved[msg.ts]}
                                        <span class="text-3xs text-fg-subtle truncate" role="status">{s.text}</span>
                                        {#if s.path}<button onclick={() => showInFolder(s.path!)} class="text-3xs text-agent-fg-strong hover:text-agent-fg-strong flex-shrink-0">Show</button>{/if}
                                    {/if}
                                </div>
                            </div>
                        </div>

                    {:else if msg.role === "error"}
                        <div class="flex gap-2.5" transition:fly={{ y: 10, duration: motion.base }}>
                            <div class="w-7 h-7 rounded-full bg-danger/20 border border-danger/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                                <span class="text-danger-fg text-xs">!</span>
                            </div>
                            <div class="max-w-[82%] bg-danger/10 border border-danger/20 text-danger-fg-strong text-xs px-4 py-2.5 rounded-2xl rounded-tl-md leading-relaxed">
                                {msg.content}
                            </div>
                        </div>
                    {/if}
                {/each}

                <!-- Live progress, and actions waiting for the user -->
                {#if $isSwarmThinking}
                    <div class="flex gap-2.5" transition:fade={{ duration: motion.fast }}>
                        <div class="w-7 h-7 rounded-full bg-gradient-to-br from-agent-emphasis to-cat-indigo-strong flex items-center justify-center flex-shrink-0">
                            <Zap size={12} class="text-on-emphasis" />
                        </div>
                        <div class="min-w-0 flex-1 space-y-2">
                            <div class="inline-flex max-w-full bg-surface-2 border border-line px-4 py-3 rounded-2xl rounded-tl-md items-center gap-2">
                                <span class="flex items-center gap-1.5 flex-shrink-0">
                                    <span class="w-1.5 h-1.5 rounded-full bg-agent animate-bounce" style="animation-delay:0ms"></span>
                                    <span class="w-1.5 h-1.5 rounded-full bg-agent animate-bounce" style="animation-delay:150ms"></span>
                                    <span class="w-1.5 h-1.5 rounded-full bg-agent animate-bounce" style="animation-delay:300ms"></span>
                                </span>
                                {#if $swarmStore.status}<span class="text-2xs text-fg-subtle truncate" aria-live="polite">{$swarmStore.status}</span>{/if}
                            </div>
                            {#each $swarmStore.approvals as a (a.requestId)}
                                <ApprovalCard approval={a} onanswer={(yes) => swarmStore.approve(a.requestId, yes)} />
                            {/each}
                        </div>
                    </div>
                {/if}
            {/if}
        </div>

        {#if !atBottom && $swarmStore.messages.length > 0}
            <button
                onclick={scrollToBottom}
                transition:fade={{ duration: motion.fast }}
                aria-label="Scroll to the latest message"
                class="absolute bottom-3 right-5 z-raised p-2 rounded-full bg-surface-4 hover:bg-surface-5 border border-line-strong text-fg-muted transition-colors shadow-lg"
            >
                <ChevronDown size={16} />
            </button>
        {/if}

        {#if dragOver}
            <div class="absolute inset-2 z-dropdown rounded-2xl border-2 border-dashed border-agent/50 bg-agent/10 flex items-center justify-center pointer-events-none">
                <p class="text-sm text-agent-fg-strong">Drop files to attach them</p>
            </div>
        {/if}
    </div>

    <!-- ── Composer ────────────────────────────────────────────────────── -->
    <div class="flex-shrink-0 border-t border-line p-3 space-y-2">
        {#if attachments.length}
            <div class="flex flex-wrap gap-1.5">
                {#each attachments as a, i (a.label + i)}
                    <span class="inline-flex items-center gap-1 max-w-[220px] text-2xs text-fg-muted bg-surface-2 border border-line rounded-full pl-2.5 pr-1 py-0.5">
                        {#if a.kind === "cid"}<Hexagon size={10} class="text-cat-cyan-fg flex-shrink-0" />{:else}<Paperclip size={10} class="flex-shrink-0" />{/if}
                        <span class="truncate">{a.label}</span>
                        <button onclick={() => (attachments = attachments.filter((_, j) => j !== i))} aria-label="Remove {a.label}" class="p-0.5 rounded-full hover:bg-surface-4 text-fg-faint hover:text-fg"><X size={10} /></button>
                    </span>
                {/each}
            </div>
        {/if}
        {#if cidOpen}
            <form onsubmit={(e) => { e.preventDefault(); addCid(); }} class="flex gap-1.5">
                <!-- svelte-ignore a11y_autofocus -->
                <input bind:value={cidInput} autofocus placeholder="bafy… or ipfs://bafy…/file.txt" aria-label="IPFS CID to attach" spellcheck="false"
                    class="flex-1 min-w-0 bg-surface-2 border border-line rounded-xl px-3 py-1.5 text-xs text-fg-muted font-mono placeholder-fg-faint outline-none focus:border-line-emphasis" />
                <button type="submit" class="px-3 rounded-xl bg-surface-3 hover:bg-surface-4 text-2xs text-fg-muted">Attach</button>
                <button type="button" onclick={() => (cidOpen = false)} class="px-2 rounded-xl hover:bg-surface-4 text-2xs text-fg-faint">Cancel</button>
            </form>
        {/if}
        {#if composerError}<p class="text-2xs text-warning-fg-strong/80" role="alert">{composerError}</p>{/if}

        <div class="relative">
            {#if slashItems.length}
                <SlashMenu items={slashItems} active={slashIndex} onpick={pickSlash} />
            {/if}
            <div class="flex items-end gap-2 bg-surface-2 border rounded-2xl px-2 py-2 focus-within:bg-surface-3 transition-all duration-base
                        {agentic ? 'border-warning/30 focus-within:border-warning/50' : 'border-line focus-within:border-agent/40'}">
                <div class="flex items-center flex-shrink-0">
                    <button onclick={() => fileInput.click()} title="Attach files" aria-label="Attach files" disabled={$isSwarmThinking}
                        class="p-1.5 rounded-lg text-fg-faint hover:text-fg hover:bg-surface-2 disabled:opacity-30"><Paperclip size={14} /></button>
                    <button onclick={() => (cidOpen = !cidOpen)} title="Attach an IPFS CID" aria-label="Attach an IPFS CID" disabled={$isSwarmThinking}
                        class="p-1.5 rounded-lg text-fg-faint hover:text-fg hover:bg-surface-2 disabled:opacity-30"><Hexagon size={14} /></button>
                    {#if provider === "soul"}
                        <button onclick={() => (agentic = !agentic)} disabled={!canAct || $isSwarmThinking} aria-pressed={agentic}
                            title={canAct ? (agentic ? "The agent may act in this tab (it asks before changing anything)" : "Let the agent act in this tab") : "Open a web page to let the agent act in it"}
                            aria-label="Act in this tab"
                            class="p-1.5 rounded-lg disabled:opacity-30 {agentic ? 'text-warning-fg-strong bg-warning/10' : 'text-fg-faint hover:text-fg hover:bg-surface-2'}"><MousePointerClick size={14} /></button>
                    {/if}
                </div>
                <input bind:this={fileInput} type="file" multiple class="hidden" onchange={(e) => addFiles((e.currentTarget as HTMLInputElement).files)} />
                <textarea
                    bind:this={textareaEl}
                    bind:value={query}
                    oninput={autoGrow}
                    onkeydown={handleKeydown}
                    disabled={$isSwarmThinking}
                    placeholder={$isSwarmThinking ? "Bucks is working…" : agentic ? "What should I do on this page?" : "Message Bucks, or / for commands"}
                    aria-label="Message"
                    rows="1"
                    class="flex-1 bg-transparent resize-none border-none outline-none text-fg text-md leading-relaxed placeholder-fg-faint disabled:opacity-50 min-h-[22px] max-h-[160px] py-0.5"
                ></textarea>

                {#if $isSwarmThinking}
                    <button onclick={() => swarmStore.stop()} title="Stop" aria-label="Stop"
                        class="flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center bg-surface-4 hover:bg-surface-5 text-fg transition-colors">
                        <Square size={12} fill="currentColor" />
                    </button>
                {:else}
                    <button
                        onclick={submit}
                        disabled={!query.trim() && !attachments.length}
                        aria-label="Send"
                        class="flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center transition-all duration-base
                               {query.trim() || attachments.length
                                   ? 'bg-agent-emphasis hover:bg-agent-emphasis-hover text-on-emphasis shadow-lg shadow-agent/20'
                                   : 'bg-surface-2 text-fg-faint cursor-not-allowed'}"
                    >
                        <Send size={14} />
                    </button>
                {/if}
            </div>
        </div>
        <p class="text-center text-3xs text-fg-disabled">
            {#if agentic}<span class="text-warning-fg-strong/60">Acting in this tab · asks before clicking, typing or opening pages</span>{:else}Enter to send · Shift+Enter for a new line · / for commands{/if}
        </p>
    </div>
</div>

<style>
    /* Custom thin scrollbar */
    div::-webkit-scrollbar       { width: 4px; }
    div::-webkit-scrollbar-track { background: transparent; }
    div::-webkit-scrollbar-thumb { background: var(--bucks-color-surface-3); border-radius: var(--bucks-radius-sm); }
    div::-webkit-scrollbar-thumb:hover { background: var(--bucks-color-surface-4); }
</style>
