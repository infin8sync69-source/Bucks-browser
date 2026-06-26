/**
 * Client-side intent matcher — runs synchronously before any backend call.
 * Returns a widget type + seed data so the UI can appear instantly.
 */

export type IntentType =
    | 'taxi_booking'
    | 'food_order'
    | 'payment_send'
    | 'weather_check'
    | 'product_search'
    | 'nearby_search'
    | 'ipfs_action'
    | 'news_search'
    | null;

export interface IntentMatch {
    type: IntentType;
    confidence: number;
    data: Record<string, any>;
}

// [pattern, intent, seed-data]
const RULES: [RegExp, IntentType, Record<string, any>][] = [
    // Taxi / ride
    [/\b(book|get|call|order|need|want|hire)\s+(a\s+)?(taxi|cab|ride|auto|rickshaw|ola|uber|rapido|driver)\b/i, 'taxi_booking', {}],
    [/\b(taxi|cab|auto\s*rickshaw|book.?ride|need.?ride|take.?me)\b/i, 'taxi_booking', {}],

    // Food / delivery
    [/\b(order|hungry|eat|want food|food delivery|swiggy|zomato|lunch|dinner|breakfast|biryani|pizza|burger|snack)\b/i, 'food_order', {}],

    // Payment / wallet
    [/\b(send|pay|transfer|upi|payment|money|wallet|pay.?me|splitting|settle)\b/i, 'payment_send', {}],

    // Weather
    [/\b(weather|temperature|forecast|rain|sunny|hot|cold|humidity|climate)\b/i, 'weather_check', {}],

    // IPFS / decentralised storage
    [/\b(ipfs|upload|pin|cid|decentralized.?storage|distribute.?file)\b/i, 'ipfs_action', {}],

    // Shopping / products
    [/\b(buy|shop|purchase|price|deal|discount|product|item|compare|cheapest)\b/i, 'product_search', {}],

    // News / research
    [/\b(news|latest|headline|article|research|summarize|what.?happened)\b/i, 'news_search', {}],

    // Generic nearby / local
    [/\b(nearby|near me|close to|around me|local|find\s+\w+\s+near)\b/i, 'nearby_search', {}],
];

export function matchIntent(query: string): IntentMatch {
    for (const [pattern, type, data] of RULES) {
        if (pattern.test(query)) {
            return { type, confidence: 0.9, data };
        }
    }
    return { type: null, confidence: 0, data: {} };
}

export const INTENT_LABELS: Record<NonNullable<IntentType>, { emoji: string; label: string; description: string }> = {
    taxi_booking:   { emoji: '🚕', label: 'Book a Ride',       description: "I'll find nearby drivers for you." },
    food_order:     { emoji: '🍽️', label: 'Order Food',        description: "Find restaurants delivering near you." },
    payment_send:   { emoji: '💸', label: 'Send Money',        description: "Transfer via your Bucks wallet." },
    weather_check:  { emoji: '🌤️', label: 'Weather',           description: "Current conditions for your location." },
    product_search: { emoji: '🛍️', label: 'Shop',              description: "Find the best prices near you." },
    nearby_search:  { emoji: '📍', label: 'Nearby',            description: "Discover what's around you." },
    ipfs_action:    { emoji: '🌐', label: 'IPFS',              description: "Upload or browse decentralised files." },
    news_search:    { emoji: '📰', label: 'News & Research',   description: "Latest updates from the swarm." },
};
