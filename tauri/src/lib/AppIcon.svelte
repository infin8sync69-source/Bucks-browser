<script lang="ts">
    import {
        Wallet, SendHorizontal, TrendingUp,
        Car, UtensilsCrossed, Package,
        Globe, Fingerprint, Image, Vote,
        CircleUser, MessageCircle, Rss,
        Settings2, History, Bookmark,
        Network, Bot, Search, Code2,
        type Icon,
    } from 'lucide-svelte';

    const ICON_MAP: Record<string, typeof Icon> = {
        Wallet,
        SendHorizontal,
        TrendingUp,
        Car,
        UtensilsCrossed,
        Package,
        Globe,
        Fingerprint,
        Image,
        Vote,
        CircleUser,
        MessageCircle,
        Rss,
        Settings2,
        History,
        Bookmark,
        Network,
        Bot,
        Search,
        Code2,
    };

    let {
        name,
        size = 24,
        color = 'white',
        strokeWidth = 1.75,
        class: cls = '',
    }: {
        name: string;
        size?: number;
        color?: string;
        strokeWidth?: number;
        class?: string;
    } = $props();

    let IconComponent = $derived(ICON_MAP[name]);
</script>

{#if IconComponent}
    <IconComponent
        {size}
        {color}
        strokeWidth={strokeWidth}
        class={cls}
    />
{:else}
    <!-- Fallback: render name initial if icon not found -->
    <span style="font-size:{size * 0.55}px; color:{color}; font-weight:700; line-height:1;">
        {name.charAt(0)}
    </span>
{/if}
