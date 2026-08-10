import { LightningElement, api } from 'lwc';
import proposeBooking from '@salesforce/apex/BotShieldBookingController.proposeBooking';
import checkBooking from '@salesforce/apex/BotShieldBookingController.checkBooking';
import cancelBooking from '@salesforce/apex/BotShieldBookingController.cancelBooking';

const POLL_INTERVAL_MS = 3000;
const ONE_HOUR_IN_MS = 3600000;
const ONE_MINUTE_IN_MS = 60000;

/**
 * BotShield booking gate — the modal behind the Coral Cloud "Book session"
 * button.
 *
 * Display-only by design: it never renders a confirm control. Confirmation
 * happens in the guest's BotShield app with Face ID, or it does not happen.
 * This component only proposes, then polls the server for the verdict — the
 * booking is activated server-side off the verdict, never off anything the
 * browser sends.
 */
export default class BotshieldBookingGate extends LightningElement {
    @api session; // record from experienceSchedule (Id, Start/End time ms, Experience__r.Price__c)
    @api sessionDate; // ISO date string of the day being viewed

    phase = 'form'; // form | sending | waiting | approved | denied | expired | cancelled | error
    email = '';
    guests = 1;
    errorMessage = '';
    requestId = null;
    ttlAt = null;
    experienceName = '';
    totalPrice = null;
    bookingName = '';

    _pollTimer = null;

    disconnectedCallback() {
        this.stopPolling();
    }

    // ── form ──────────────────────────────────────────────────────────────

    handleEmailChange(event) {
        this.email = event.target.value;
    }

    handleGuestsChange(event) {
        this.guests = parseInt(event.target.value, 10) || 1;
    }

    async handleSendClick() {
        this.phase = 'sending';
        this.errorMessage = '';
        try {
            const res = await proposeBooking({
                sessionId: this.session.Id,
                email: this.email,
                guests: this.guests
            });
            if (res.status === 'queued') {
                this.requestId = res.requestId;
                this.ttlAt = res.ttlAt ? Date.parse(res.ttlAt) : null;
                this.experienceName = res.experienceName || '';
                this.totalPrice = res.totalPrice;
                this.phase = 'waiting';
                this.startPolling();
            } else {
                this.phase = 'form';
                this.errorMessage = res.errorMessage || 'Could not start the confirmation.';
            }
        } catch (e) {
            this.phase = 'form';
            this.errorMessage = 'Could not reach the booking service.';
        }
    }

    // ── polling ───────────────────────────────────────────────────────────

    startPolling() {
        this.stopPolling();
        this._pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    }

    stopPolling() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    }

    async poll() {
        // Never outlive the card: once ttl_at passes there is nothing left to
        // wait for, whatever the network is doing.
        if (this.ttlAt && Date.now() >= this.ttlAt) {
            this.stopPolling();
            this.phase = 'expired';
            return;
        }
        try {
            const res = await checkBooking({ requestId: this.requestId });
            if (res.status === 'approved') {
                this.stopPolling();
                this.bookingName = res.bookingName || '';
                this.phase = 'approved';
            } else if (['denied', 'cancelled', 'expired'].includes(res.status)) {
                this.stopPolling();
                this.phase = res.status;
            } else if (res.status === 'error') {
                // A failed poll is NOT a verdict — keep waiting until the
                // card's own TTL settles it.
                this.errorMessage = res.errorMessage || '';
            }
        } catch (e) {
            // Transient network failure: same rule, keep polling.
        }
    }

    // ── actions ───────────────────────────────────────────────────────────

    async handleCancelWaiting() {
        this.stopPolling();
        try {
            await cancelBooking({ requestId: this.requestId });
        } finally {
            this.phase = 'cancelled';
        }
    }

    handleClose() {
        this.stopPolling();
        this.dispatchEvent(
            new CustomEvent('close', {
                detail: { refresh: this.phase === 'approved' }
            })
        );
    }

    // ── display helpers ───────────────────────────────────────────────────

    get isForm() {
        return this.phase === 'form' || this.phase === 'sending';
    }
    get isSending() {
        return this.phase === 'sending';
    }
    get isWaiting() {
        return this.phase === 'waiting';
    }
    get isApproved() {
        return this.phase === 'approved';
    }
    get isDenied() {
        return this.phase === 'denied';
    }
    get isExpired() {
        return this.phase === 'expired';
    }
    get isCancelled() {
        return this.phase === 'cancelled';
    }
    get hasError() {
        return !!this.errorMessage;
    }
    get isTerminal() {
        return ['approved', 'denied', 'expired', 'cancelled'].includes(this.phase);
    }

    get sessionTimeLabel() {
        if (!this.session) {
            return '';
        }
        return `${this.formatMs(this.session.Start_Time__c)} – ${this.formatMs(this.session.End_Time__c)}`;
    }

    get priceLabel() {
        const price = this.session?.Experience__r?.Price__c;
        return price == null ? '' : `$${price} per guest`;
    }

    get totalLabel() {
        const price = this.session?.Experience__r?.Price__c;
        if (price == null) {
            return '';
        }
        return `$${price * this.guests}`;
    }

    get dateLabel() {
        if (!this.sessionDate) {
            return '';
        }
        return new Date(this.sessionDate).toLocaleDateString(undefined, {
            month: 'long',
            day: 'numeric',
            year: 'numeric'
        });
    }

    formatMs(ms) {
        if (ms == null) {
            return '';
        }
        const hours = Math.floor(ms / ONE_HOUR_IN_MS);
        const minutes = Math.floor((ms - hours * ONE_HOUR_IN_MS) / ONE_MINUTE_IN_MS);
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }
}
