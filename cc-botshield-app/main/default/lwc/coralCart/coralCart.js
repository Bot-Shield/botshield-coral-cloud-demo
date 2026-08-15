import { LightningElement } from 'lwc';
import checkout from '@salesforce/apex/BotShieldCensusCheckout.checkout';

/**
 * Coral Cloud cart — Shopify-style slide-out checkout drawer, gated by the
 * BotShield Census rail.
 *
 * Rail choice (deliberate): a human at their own browser clicking "checkout"
 * is Census — "Is a human here?" — verified inline via the hosted challenge
 * iframe + postMessage, exactly like demo.botshield.ai. The Agents Ask / Q
 * rail (propose → approve in the BotShield app) belongs to the AGENT chat on
 * this site, where the actor is software and the human is elsewhere. One
 * site, both rails, each on the surface it was designed for.
 *
 * Integration pattern per the strategy doc's Surface-4 gotcha: an IFRAME to
 * the hosted challenge with a postMessage contract — never a third-party
 * script load, which Experience Cloud CSP/LWS blocks. The token that comes
 * back is verified SERVER-SIDE (sdk/verify-token) before any booking is
 * created; the client's word is never the gate.
 *
 * Sessions are added from experienceSchedule via a window CustomEvent —
 * sibling LWCs on an Experience page have no shared ancestor to relay
 * through, and LMS is heavier than this demo needs.
 */

const CART_EVENT = 'coralcloud:addtocart';
const STORAGE_KEY = 'coralcloud_cart_v1';

// Staging Census stack — matches the org's Named Credential (wg-staging), so
// the token the iframe mints verifies against the same environment.
// Deployment: botshield_sfdc_coral_travel_checkout_demo (pk_test = publishable).
const CHALLENGE_BASE = 'https://cdn-staging.botshield.ai';
const SITE_KEY = 'pk_test_cd43f116e06877beb94b550a997ad4fb';

export default class CoralCart extends LightningElement {
    items = [];
    drawerOpen = false;
    phase = 'cart'; // cart | verify | placing | done | error
    email = '';
    verifyState = 'idle'; // idle | running | verified | challenge | failed
    censusToken = null;
    verificationUrl = null;
    bookingNames = [];
    errorMessage = '';
    iframeNonce = 0;

    _onAdd = null;
    _onMessage = null;

    connectedCallback() {
        try {
            this.items = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]');
        } catch (e) {
            this.items = [];
        }
        this._onAdd = (evt) => this.addItem(evt.detail);
        window.addEventListener(CART_EVENT, this._onAdd);

        this._onMessage = (evt) => this.handleChallengeMessage(evt);
        window.addEventListener('message', this._onMessage);
    }

    disconnectedCallback() {
        window.removeEventListener(CART_EVENT, this._onAdd);
        window.removeEventListener('message', this._onMessage);
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
        this.censusToken = null;
        this.verifyState = 'loading';
    }

    // ── checkout: Census gate ─────────────────────────────────────────────

    handleBeginCheckout() {
        if (!this.items.length) return;
        this.phase = 'verify';
        this.censusToken = null;
        // idle until the human CLICKS verify — the ceremony is user-initiated,
        // mirroring the <botshield-verify> component (idle → verifying →
        // verified). Auto-running it on step entry made "verified" appear
        // before any intent, which read as broken.
        this.verifyState = 'idle';
    }

    handleStartVerify() {
        this.verifyState = 'running';
        this.censusToken = null;
        this.iframeNonce += 1; // fresh challenge per attempt
    }

    get challengeUrl() {
        const origin = encodeURIComponent(window.location.origin);
        return (
            `${CHALLENGE_BASE}/challenge?site_key=${SITE_KEY}&mode=session&theme=light` +
            `&render=iframe&origin=${origin}&n=${this.iframeNonce}`
        );
    }

    handleChallengeMessage(evt) {
        if (evt.origin !== CHALLENGE_BASE) return;
        const msg = evt.data || {};
        switch (msg.type) {
            case 'botshield:ready':
                // still 'running' — the widget shows its own progress
                break;
            case 'botshield:success':
                // The token is NOT trusted here — it rides to Apex, which
                // verifies it against BotShield before creating anything.
                this.censusToken = msg.token;
                this.verifyState = 'verified';
                break;
            case 'botshield:challenge':
                this.verifyState = 'challenge';
                this.verificationUrl = msg.verification_url || null;
                break;
            case 'botshield:failure':
                this.verifyState = 'failed';
                break;
            default:
        }
    }

    handleOpenVerification() {
        if (this.verificationUrl) {
            window.open(this.verificationUrl, '_blank', 'noopener');
        }
    }

    handleRetryChallenge() {
        this.verifyState = 'running';
        this.censusToken = null;
        this.iframeNonce += 1;
    }

    // ── checkout: place bookings ──────────────────────────────────────────

    async handleCompleteBooking() {
        if (!this.censusToken || !this.emailValid) return;
        this.phase = 'placing';
        this.errorMessage = '';
        try {
            const res = await checkout({
                itemsJson: JSON.stringify(
                    this.items.map((i) => ({ sessionId: i.sessionId, guests: i.guests }))
                ),
                email: this.email.trim(),
                token: this.censusToken
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
        this.censusToken = null;
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
    get verifyIdle() {
        return this.verifyState === 'idle';
    }
    get verifyRunning() {
        return this.verifyState === 'running';
    }
    get verifyVerified() {
        return this.verifyState === 'verified';
    }
    get verifyChallenge() {
        return this.verifyState === 'challenge';
    }
    get verifyFailed() {
        return this.verifyState === 'failed';
    }
    get completeDisabled() {
        return !(this.censusToken && this.emailValid);
    }
    get drawerClass() {
        return this.drawerOpen ? 'drawer open' : 'drawer';
    }
    get bookingNamesLabel() {
        return this.bookingNames.join(', ');
    }
}
