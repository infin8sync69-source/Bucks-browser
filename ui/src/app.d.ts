// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { BucksApi } from '$lib/bridge';

declare global {
    namespace App {
        // interface Error {}
        // interface Locals {}
        // interface PageData {}
        // interface PageState {}
        // interface Platform {}
    }

    interface Window {
        /** Bridge to the main process, exposed by src/preload/preload.cjs (absent in a plain browser). */
        bucks?: BucksApi;
    }
}

export {};
