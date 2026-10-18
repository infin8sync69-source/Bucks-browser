/**
 * Chrome-wide UI state shared between the layout, the header and the content area:
 * whether the chat drawer is open, how many overlays cover the page (the web content view
 * must be hidden while any of them is up) and the "focus the omnibox" request.
 */
import { writable } from 'svelte/store';

/** The agent chat drawer (right side, 448px). ContentArea shrinks while it is open. */
export const chatOpen = writable(false);

/** Number of chrome overlays currently covering the content area (app store, modal widgets, dropdowns). */
export const overlayCount = writable(0);

/** Register an overlay. Call popOverlay() when it closes. */
export function pushOverlay() {
    overlayCount.update((n) => n + 1);
}

/** Unregister an overlay previously registered with pushOverlay(). */
export function popOverlay() {
    overlayCount.update((n) => Math.max(0, n - 1));
}

/**
 * Monotonic counter bumped by the 'focus-omnibox' shortcut. The Header reacts to every change
 * (a counter instead of a boolean so repeated requests are not lost).
 */
export const focusOmniboxRequest = writable(0);

/** Ask the header to focus and select the omnibox. */
export function requestFocusOmnibox() {
    focusOmniboxRequest.update((n) => n + 1);
}

/** Toggle the chat drawer. */
export function toggleChat() {
    chatOpen.update((v) => !v);
}

/** The find-in-page bar (Ctrl/Cmd+F). ContentArea moves the page down while it is open. */
export const findBarOpen = writable(false);

export function openFindBar() {
    findBarOpen.set(true);
    findBarFocus.update((n) => n + 1);
}

/** Bumped on every open request so a second Ctrl+F refocuses the field. */
export const findBarFocus = writable(0);
