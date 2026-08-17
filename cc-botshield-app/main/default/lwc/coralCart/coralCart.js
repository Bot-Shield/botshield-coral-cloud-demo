import { LightningElement } from 'lwc';
import checkout from '@salesforce/apex/BotShieldCensusCheckout.checkout';

/**
 * Coral Cloud cart — Shopify-style slide-out checkout drawer, gated by the
 * BotShield Census rail.
 *
 * Rail choice (deliberate): a human at their own browser clicking "checkout"
 * is Census — "Is a human here?" — verified via the BotShield QR/app ceremony,
 * exactly like demo.botshield.ai. The Agents Ask / Q rail (propose → approve
 * in the BotShield app) belongs to the AGENT chat on this site, where the
 * actor is software and the human is elsewhere. One site, both rails, each on
 * the surface it was designed for.
 *
 * The gate is <c-botshield-verify> (the SDK's <botshield-verify>, ported):
 * it renders the verify pill, the QR modal, and the component-owned
 * "Complete Booking" button, and it learns the outcome from THE ORG — BotShield
 * pushes the verification into BotShield_Census__c (CDC-enabled), the LWC
 * watches that row, and Apex re-reads the same row before creating bookings.
 * The client's word is never the gate.
 *
 * Sessions are added from experienceSchedule via a window CustomEvent —
 * sibling LWCs on an Experience page have no shared ancestor to relay
 * through, and LMS is heavier than this demo needs.
 */

const CART_EVENT = 'coralcloud:addtocart';
const STORAGE_KEY = 'coralcloud_cart_v1';
// Opaque partner_user_ref for the MultiPass instant path (mirrors the Ticketz
// demo). A real partner sends its own logged-in user id; this guest site mints
// a random stand-in once and keeps it in localStorage: the FIRST verification
// links it to the BotShield identity (link_on_verify), so later evaluates with
// the same ref return the instant pass — no QR. Zero PII: random hex only.
const USER_REF_KEY = 'coralcloud_bs_user_ref';

// Staging Census stack. The Console deployment
// botshield_sfdc_coral_travel_checkout_demo is checked under Integrations →
// Salesforce → Configure, so its terminal events are pushed into this org.
// pk_test = publishable; the scope IS the deployment name.
const CDN_BASE = 'https://cdn-staging.botshield.ai';
const SITE_KEY = 'pk_test_cd43f116e06877beb94b550a997ad4fb';
const SCOPE = 'botshield_sfdc_coral_travel_checkout_demo';

export default class CoralCart extends LightningElement {
    items = [];
    drawerOpen = false;
    phase = 'cart'; // cart | verify | placing | done | error
    email = '';
    emailTouched = false;
    // What the org will be asked about: the request_id botshield-verify minted.
    // Never a token, never "verified=true" from the browser.
    censusRequestId = null;
    bookingNames = [];
    errorMessage = '';

    cdnBase = CDN_BASE;
    siteKey = SITE_KEY;
    scope = SCOPE;
    userRef = '';

    _onAdd = null;

    connectedCallback() {
        try {
            this.items = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]');
        } catch (e) {
            this.items = [];
        }
        this._onAdd = (evt) => this.addItem(evt.detail);
        window.addEventListener(CART_EVENT, this._onAdd);
        this.userRef = this.loadOrMintUserRef();
    }

    loadOrMintUserRef() {
        try {
            const existing = window.localStorage.getItem(USER_REF_KEY);
            if (existing) return existing;
            const bytes = new Uint8Array(6);
            window.crypto.getRandomValues(bytes);
            const ref = 'cc_' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
            window.localStorage.setItem(USER_REF_KEY, ref);
            return ref;
        } catch (e) {
            return '';
        }
    }

    disconnectedCallback() {
        window.removeEventListener(CART_EVENT, this._onAdd);
    }

    // ── cart state ────────────────────────────────────────────────────────

    persist() {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.items));
        } catch (e) {
            /* storage denied — cart still works for the session */
        }
    }

    addItem(detail) {
        if (!detail?.sessionId) return;
        const existing = this.items.find((i) => i.sessionId === detail.sessionId);
        if (existing) {
            existing.guests = Math.min(8, existing.guests + 1);
            this.items = [...this.items];
        } else {
            this.items = [...this.items, { ...detail, guests: 1 }];
        }
        this.persist();
        this.drawerOpen = true;
        this.phase = 'cart';
    }

    handleRemove(event) {
        const id = event.currentTarget.dataset.id;
        this.items = this.items.filter((i) => i.sessionId !== id);
        this.persist();
    }

    handleGuestsChange(event) {
        const id = event.currentTarget.dataset.id;
        const guests = Math.max(1, Math.min(8, parseInt(event.target.value, 10) || 1));
        this.items = this.items.map((i) => (i.sessionId === id ? { ...i, guests } : i));
        this.persist();
    }

    handleEmailChange(event) {
        this.email = event.target.value;
    }

    // ── drawer ────────────────────────────────────────────────────────────

    handleToggleDrawer() {
        this.drawerOpen = !this.drawerOpen;
        if (this.drawerOpen && this.phase === 'done') {
            // Re-opening after a completed checkout starts a fresh cart view.
            this.phase = 'cart';
        }
    }

    handleCloseDrawer() {
        this.drawerOpen = false;
    }

    handleBackToCart() {
        this.phase = 'cart';
        this.censusRequestId = null;
    }

    // ── checkout: Census gate (delegated to <c-botshield-verify>) ─────────

    handleBeginCheckout() {
        if (!this.items.length) return;
        this.phase = 'verify';
        this.censusRequestId = null;
        this.emailTouched = false;
    }

    handleVerifySuccess(evt) {
        // Informational only — the request_id is what rides to Apex, which
        // re-reads the org's Census row before creating anything.
        this.censusRequestId = (evt.detail && evt.detail.requestId) || null;
    }

    handleVerifyFailure() {
        this.censusRequestId = null;
    }

    handleVerifyReset() {
        this.censusRequestId = null;
    }

    // ── checkout: place bookings ──────────────────────────────────────────

    /** Fired by botshield-verify's own "Complete Booking" button, only when
     *  its state is resolved. We add the one thing it can't know: the email. */
    async handleVerifyCheckout(evt) {
        this.emailTouched = true;
        if (!this.emailValid) {
            const input = this.template.querySelector('.email');
            if (input) input.focus();
            return;
        }
        const requestId = (evt.detail && evt.detail.requestId) || this.censusRequestId;
        if (!requestId) return;
        this.phase = 'placing';
        this.errorMessage = '';
        try {
            const res = await checkout({
                itemsJson: JSON.stringify(
                    this.items.map((i) => ({ sessionId: i.sessionId, guests: i.guests }))
                ),
                email: this.email.trim(),
                requestId
            });
            if (res && res.success) {
                this.bookingNames = res.bookingNames || [];
                this.items = [];
                this.persist();
                this.phase = 'done';
            } else {
                this.errorMessage = (res && res.errorMessage) || 'Checkout failed.';
                this.phase = 'error';
            }
        } catch (e) {
            this.errorMessage = 'Could not reach the booking service.';
            this.phase = 'error';
        }
    }

    handleTryAgain() {
        this.phase = 'cart';
        this.censusRequestId = null;
    }

    // ── display ───────────────────────────────────────────────────────────

    get count() {
        return this.items.reduce((n, i) => n + i.guests, 0);
    }
    get hasItems() {
        return this.items.length > 0;
    }
    get isEmpty() {
        return this.items.length === 0;
    }
    get total() {
        return this.items.reduce((n, i) => n + (i.price || 0) * i.guests, 0);
    }
    get totalLabel() {
        return `$${this.total}`;
    }
    get displayItems() {
        return this.items.map((i) => ({
            ...i,
            lineTotal: `$${(i.price || 0) * i.guests}`,
            timeLabel: `${this.fmt(i.startMs)} – ${this.fmt(i.endMs)}`,
            dateLabel: i.dateIso
                ? new Date(i.dateIso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                : ''
        }));
    }
    fmt(ms) {
        if (ms == null) return '';
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    get emailValid() {
        return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(this.email.trim());
    }
    get isCartPhase() {
        return this.phase === 'cart';
    }
    get isVerifyPhase() {
        return this.phase === 'verify';
    }
    get isPlacing() {
        return this.phase === 'placing';
    }
    get isDone() {
        return this.phase === 'done';
    }
    get isError() {
        return this.phase === 'error';
    }
    get emailInvalid() {
        return this.emailTouched && !this.emailValid;
    }
    get emailClass() {
        return this.emailInvalid ? 'email invalid' : 'email';
    }
    get drawerClass() {
        return this.drawerOpen ? 'drawer open' : 'drawer';
    }
    get bookingNamesLabel() {
        return this.bookingNames.join(', ');
    }
}
