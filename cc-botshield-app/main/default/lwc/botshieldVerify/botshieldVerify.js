import { LightningElement, api } from 'lwc';
import getVerificationStatus from '@salesforce/apex/BotShieldCensusCheckout.getVerificationStatus';
import { ROBOT_ICON_SVG, SHIELD_CHECK_SVG, SHIELD_X_SVG, SPINNER_SVG, MULTIPASS_CARD_SVG, CENSUS_LOGO_SVG } from './assets';

/**
 * <c-botshield-verify> — the Salesforce port of BotShield's <botshield-verify>
 * web component (botshield-sdk-embed/src/botshield-verify.ts, v3).
 *
 * WHY A PORT AND NOT THE CDN BUNDLE: third-party web components are Beta in
 * LWC and explicitly unsupported in Experience Builder sites (the surface this
 * runs on), and AppExchange review disallows runtime-loaded remote JS in a
 * managed package. So the visual contract is copied VERBATIM from the SDK —
 * same SVGs (Figma OsQQtkzL52OOOGVnWNwDFX), same state tokens, same labels,
 * same QR modal — while the result-delivery transport is swapped:
 *
 *   SDK   : browser ⇐ SSE ⇐ cdn worker ⇐ WG verification/status
 *   here  : app verifies ⇒ BotShield Console ⇒ ECA client-credentials PATCH ⇒
 *           BotShield_Census__c row (CDC fires) ⇒ this LWC sees the row
 *
 * transport attribute:
 *   "salesforce" (default) — watch the org's BotShield_Census__c row via Apex.
 *       Experience Cloud (esp. guest) has no streaming channel to the browser,
 *       so the watch is a short-interval Apex read; the CDC event is what the
 *       rest of the org reacts to. In Lightning Experience the same row can be
 *       observed with lightning/empApi on /data/BotShield_Census__ChangeEvent.
 *   "cdn" — poll the CDN worker's /api/check-verification like the SDK's own
 *       fallback path (no org round-trip; useful for demos without the push).
 *
 * States: idle → verifying → verified | multipass_active | failed
 * Events (bubbling, composed): verifysuccess {requestId, token, state, via},
 *   verifyfailure {reason}, verifycheckout {requestId, token, state}, verifyreset.
 */

const STATE_LABEL = {
    idle: 'Verify human with BotShield',
    verifying: 'Verifying…',
    verified: 'Human Verified',
    multipass_active: 'MultiPass Active',
    failed: 'Presence Unavailable'
};

const ICONS = {
    idle: ROBOT_ICON_SVG,
    verifying: SPINNER_SVG,
    verified: SHIELD_CHECK_SVG,
    multipass_active: MULTIPASS_CARD_SVG,
    failed: SHIELD_X_SVG
};

// Wall-clock cap for a pending verification — mirrors the SDK (WG expires the
// verification at 5 min; 5.5 min is the client safety net).
const MAX_PENDING_MS = 330000;
const SF_POLL_MS = 2500;
const CDN_POLL_MS = 5000;

export default class BotshieldVerify extends LightningElement {
    @api siteKey;
    @api scope;
    @api mode = 'private';
    @api theme = 'light'; // light | dark | auto
    @api cdnBase = 'https://cdn-staging.botshield.ai';
    @api transport = 'salesforce'; // salesforce | cdn
    @api checkoutLabel = 'Checkout';
    @api platformUserRef;
    @api partnerName; // shown in the modal consent line; defaults to hostname
    /** Set to opt OUT of writing a partner_user_linkages row on success (SDK link-on-verify="false"). */
    @api noLinkOnVerify = false;
    /** Hide the component-owned checkout button (host renders its own). */
    @api hideCheckout = false;

    state = 'idle';
    requestId = null;
    token = null;
    modalOpen = false;
    qrUrl = '';
    pushedToDevices = 0;
    // transport="salesforce": the org row is the gate, so a resolved pill only
    // unlocks checkout once the row is confirmed. Ceremony path: the pill flips
    // BECAUSE the row exists (confirmed by construction). MultiPass instant
    // path (evaluate verdict=pass): the pill goes green at once (SDK parity)
    // while the Console push lands the row a beat later — confirm it first.
    orgConfirmed = false;
    confirming = false;

    _pollTimer = null;
    _capTimer = null;
    _startedAt = 0;
    _parentRequestId = null;
    _iconsDirty = true;

    // ── Public API (mirrors the SDK) ─────────────────────────────────────
    @api getToken() { return this.token; }
    @api getRequestId() { return this.requestId; }
    @api reset() {
        this.stopWatching();
        this.modalOpen = false;
        this.state = 'idle';
        this.token = null;
        this.requestId = null;
        this.orgConfirmed = false;
        this.confirming = false;
        this._iconsDirty = true;
        this.dispatchEvent(new CustomEvent('verifyreset', { bubbles: true, composed: true }));
    }

    // ── Rendering ────────────────────────────────────────────────────────
    get rootClass() {
        return `bs-root theme-${this.theme || 'light'} state-${this.state}`;
    }
    get label() { return STATE_LABEL[this.state]; }
    get isResolved() { return this.state === 'verified' || this.state === 'multipass_active'; }
    get buttonDisabled() { return this.state === 'verifying'; }
    get checkoutDisabled() {
        if (!this.isResolved) return true;
        return this.transport === 'salesforce' && !this.orgConfirmed;
    }
    get showConfirming() { return this.confirming; }
    get showCheckout() { return !this.hideCheckout; }
    get svTop() { return this.isResolved ? 'Add to BotShield' : 'Stay Verified with BotShield'; }
    get modalTitle() { return this.pushedToDevices > 0 ? 'Check your phone' : 'Add this site to your MultiPass'; }
    get showPushHint() { return this.pushedToDevices > 0; }
    get partnerDisplay() {
        if (this.partnerName) return this.partnerName;
        const host = (typeof window !== 'undefined' && window.location && window.location.hostname) || 'this site';
        return host.replace(/^www\./, '');
    }
    get logoUrl() { return `${this.cdnBase}/assets/botshield-logo.svg`; }

    renderedCallback() {
        // Icons carry <defs>/gradients with ids that LWC's template compiler
        // would mangle (url(#id) refs break), so they're injected as markup.
        const icon = this.template.querySelector('.bs-icon');
        if (icon && icon.dataset.state !== this.state) {
            icon.innerHTML = ICONS[this.state];
            icon.dataset.state = this.state;
        }
        const logo = this.template.querySelector('.bs-census-logo');
        if (logo && !logo.dataset.done) { logo.innerHTML = CENSUS_LOGO_SVG; logo.dataset.done = '1'; }
        const sv = this.template.querySelector('.bs-sv-icon');
        if (sv && !sv.dataset.done) { sv.innerHTML = MULTIPASS_CARD_SVG; sv.dataset.done = '1'; }
    }

    disconnectedCallback() { this.stopWatching(); }

    // ── Click → precheck → challenge ─────────────────────────────────────
    async handleVerifyClick() {
        if (this.state === 'failed') { this.reset(); return; }
        if (this.state !== 'idle') return;
        if (!this.siteKey) { console.error('[BotShield] Missing site-key'); return; }
        const outcome = await this.runMultiPassPrecheck();
        if (outcome === 'done') return;
        this.openChallenge();
    }

    handleCheckoutClick() {
        if (!this.isResolved) return; // state is the source of truth, not the DOM
        this.dispatchEvent(new CustomEvent('verifycheckout', {
            bubbles: true, composed: true,
            detail: { requestId: this.requestId, token: this.token, state: this.state }
        }));
    }

    /** Ported from the SDK: /api/evaluate → pass | require_presence | blocked. */
    async runMultiPassPrecheck() {
        if (!this.scope) return 'continue';
        const body = { site_key: this.siteKey, scope: this.scope, link_on_verify: !this.noLinkOnVerify };
        if (this.platformUserRef) body.partner_user_ref = this.platformUserRef;
        let result;
        try {
            const res = await fetch(`${this.cdnBase}/api/evaluate`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
            });
            if (!res.ok) return 'continue';
            result = await res.json();
        } catch (e) {
            return 'continue'; // pre-check is an optimization; never block the path
        }
        const verdict = result && result.verdict;
        if (!verdict) return 'continue';
        if (verdict === 'pass') {
            const rs = result.result_state;
            this.state = rs === 'multipass_active' || result.reason === 'multipass_active' ? 'multipass_active' : 'verified';
            this.requestId = result.request_id || result.event_id || null;
            this.emitSuccess({ via: 'multipass', reason: result.reason });
            if (this.transport === 'salesforce') {
                // BotShield pushes a Census row for evaluate-pass outcomes keyed
                // by this request_id; watch for it before unlocking checkout.
                this.orgConfirmed = false;
                this.confirming = true;
                this.startWatching();
            } else {
                this.orgConfirmed = true;
            }
            return 'done';
        }
        if (verdict === 'blocked') {
            this.state = 'failed';
            this.emitFailure(result.reason || 'blocked');
            return 'done';
        }
        this._parentRequestId = result.event_id || result.request_id || null;
        return 'continue';
    }

    async openChallenge() {
        this.state = 'verifying';
        try {
            const res = await fetch(`${this.cdnBase}/api/create-verification`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    site_key: this.siteKey,
                    scope: this.scope || undefined,
                    mode: this.mode || undefined,
                    parent_request_id: this._parentRequestId || undefined,
                    link_on_verify: !this.noLinkOnVerify,
                    partner_user_ref: this.platformUserRef || undefined
                })
            });
            if (!res.ok) throw new Error('API error');
            const link = await res.json();
            const requestId = link.request_id;
            const webUrl = link.web_url;
            const deepLink = link.deep_link;
            if (!requestId || !webUrl) throw new Error('Missing verification data');
            this.requestId = requestId;
            this.pushedToDevices = Number(link.pushed_to_devices || 0);

            const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
            if (isMobile) {
                // Same device: hand off to the app, watch for the result on return.
                this.startWatching();
                window.location.href = deepLink || webUrl;
                return;
            }
            // Desktop: QR modal — same generator + colours as the SDK.
            this.qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=232x232&data=${encodeURIComponent(webUrl)}&bgcolor=101010&color=ffffff&format=png`;
            this.modalOpen = true;
            this.startWatching();
        } catch (e) {
            console.error('[BotShield] create-verification failed:', e);
            this.state = 'failed';
            this.emitFailure('modal_create_failed');
        }
    }

    // ── Watching for the terminal result ─────────────────────────────────
    startWatching() {
        this.stopWatching();
        this._startedAt = Date.now();
        this._capTimer = setTimeout(() => this.finish('failed', 'expired'), MAX_PENDING_MS);
        const useCdn = this.transport === 'cdn';
        const tick = useCdn ? () => this.pollCdn() : () => this.pollOrg();
        this._pollTimer = setInterval(tick, useCdn ? CDN_POLL_MS : SF_POLL_MS);
    }

    stopWatching() {
        if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
        if (this._capTimer) { clearTimeout(this._capTimer); this._capTimer = null; }
    }

    /** transport="salesforce": has BotShield's push landed the row yet? */
    async pollOrg() {
        if (!this.requestId) return;
        if (this.state !== 'verifying' && !this.confirming) return;
        try {
            const vs = await getVerificationStatus({ requestId: this.requestId });
            if (!vs || !vs.found) return;
            if (vs.status === 'Completed') {
                this.token = vs.token || this.token || null;
                if (this.confirming) {
                    // Instant path: pill already resolved; the row just unlocked checkout.
                    this.stopWatching();
                    this.confirming = false;
                    this.orgConfirmed = true;
                    this.dispatchEvent(new CustomEvent('verifyconfirmed', {
                        bubbles: true, composed: true,
                        detail: { requestId: this.requestId, token: this.token, state: this.state }
                    }));
                } else {
                    this.finish(vs.resultState === 'MultiPass Active' ? 'multipass_active' : 'verified', null, 'salesforce');
                }
            } else if (vs.status === 'Failed' || vs.status === 'Blocked' || vs.status === 'Expired') {
                this.finish('failed', String(vs.status).toLowerCase());
            }
        } catch (e) {
            // transient — keep watching until the cap
        }
    }

    /** transport="cdn": the SDK's own fallback poll. */
    async pollCdn() {
        if (this.state !== 'verifying' || !this.requestId) return;
        try {
            const res = await fetch(`${this.cdnBase}/api/check-verification?request_id=${encodeURIComponent(this.requestId)}`);
            if (!res.ok) return;
            const data = await res.json();
            const status = (data && data.data && data.data.status) || (data && data.status);
            if (status === 'completed') {
                this.token = (data.data && data.data.verification_token) || data.verification_token || this.requestId;
                this.finish('verified', null, 'cdn');
            } else if (status === 'failed' || status === 'expired') {
                this.finish('failed', status);
            }
        } catch (e) { /* keep polling */ }
    }

    finish(state, reason, via) {
        this.stopWatching();
        this.modalOpen = false;
        this.confirming = false;
        this.state = state;
        if (state === 'failed') {
            this.orgConfirmed = false;
            this.emitFailure(reason || 'failed');
        } else {
            // Ceremony path: resolved BECAUSE the org row (or CDN status) says so.
            this.orgConfirmed = true;
            this.emitSuccess({ via: via || 'salesforce', reason: null });
        }
    }

    handleCancel() {
        this.stopWatching();
        this.modalOpen = false;
        if (this.state === 'verifying') this.state = 'idle';
    }
    handleOverlayClick(evt) {
        if (evt.target === evt.currentTarget) this.handleCancel();
    }
    stop(evt) { evt.stopPropagation(); }

    emitSuccess(extra) {
        this.dispatchEvent(new CustomEvent('verifysuccess', {
            bubbles: true, composed: true,
            detail: Object.assign({ requestId: this.requestId, token: this.token, state: this.state }, extra || {})
        }));
    }
    emitFailure(reason) {
        this.dispatchEvent(new CustomEvent('verifyfailure', {
            bubbles: true, composed: true, detail: { reason, requestId: this.requestId }
        }));
    }
}
