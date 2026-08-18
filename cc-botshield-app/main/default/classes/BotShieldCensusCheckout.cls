/**
 * BotShieldCensusCheckout — the Census-gated cart checkout for the Coral
 * Cloud site.
 *
 * Rail choice: a human present at their own browser is the CENSUS question
 * ("Is a human here?") — verified at checkout via the BotShield QR/app
 * ceremony (the same <botshield-verify> flow demo.botshield.ai runs). The
 * Agents Ask / Q rail stays with the agent chat on this site, where the actor
 * is software.
 *
 * ── The Salesforce-native gate ────────────────────────────────────────────
 * The browser never tells us it is verified. The verification happens in the
 * BotShield app; BotShield's Console then writes the outcome INTO THIS ORG as
 * a BotShield_Census__c row (upsert on Request_ID__c, via the External Client
 * App's client-credentials session — the only writer that can). Change Data
 * Capture is enabled on the object so in-org subscribers react to the row
 * landing. The browser only ever knows the request_id it minted:
 *
 *   getVerificationStatus(requestId)  → reads the row (the LWC watches this)
 *   checkout(items, email, requestId) → gates on the row being Completed
 *
 * The client's word is never the gate; the org's own audit row is. Bookings
 * are created ACTIVE because the human just verified, present-tense.
 */
public without sharing class BotShieldCensusCheckout {

    /** A verification older than this is not "present-tense" any more. */
    private static final Integer MAX_VERIFICATION_AGE_MINUTES = 30;

    public class CheckoutItem {
        public String sessionId;
        public Integer guests;
    }

    public class CheckoutResult {
        @AuraEnabled public Boolean success = false;
        @AuraEnabled public List<String> bookingNames = new List<String>();
        @AuraEnabled public String errorMessage;
    }

    /** What the LWC polls. `found` false = the push hasn't landed yet. */
    public class VerificationStatus {
        @AuraEnabled public Boolean found = false;
        @AuraEnabled public String status;       // Completed | Failed | Blocked | Expired
        @AuraEnabled public String resultState;  // Human Verified | MultiPass Active | Unavailable
        @AuraEnabled public Boolean verified = false;
        @AuraEnabled public Datetime verifiedAt;
        @AuraEnabled public String token;        // attestation token, if pushed
    }

    /**
     * Read the BotShield_Census__c row for a request_id. Cheap SOQL, no
     * callout — the row exists only if BotShield pushed it. Called on a short
     * interval by botshieldVerify (transport="salesforce") until terminal.
     */
    @AuraEnabled
    public static VerificationStatus getVerificationStatus(String requestId) {
        VerificationStatus vs = new VerificationStatus();
        if (String.isBlank(requestId)) { return vs; }
        List<BotShield_Census__c> rows = [
            SELECT Status__c, Result_State__c, Verified__c, Verified_At__c, Attestation_Token__c
            FROM BotShield_Census__c
            WHERE Request_ID__c = :requestId
            LIMIT 1
        ];
        if (rows.isEmpty()) { return vs; }
        BotShield_Census__c r = rows[0];
        vs.found = true;
        vs.status = r.Status__c;
        vs.resultState = r.Result_State__c;
        vs.verified = r.Verified__c == true || r.Status__c == 'Completed';
        vs.verifiedAt = r.Verified_At__c;
        vs.token = r.Attestation_Token__c;
        return vs;
    }

    @AuraEnabled
    public static CheckoutResult checkout(String itemsJson, String email, String requestId) {
        CheckoutResult out = new CheckoutResult();
        try {
            // ── Parse + validate input ────────────────────────────────────
            if (String.isBlank(email) || !Pattern.matches('^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$', email.trim())) {
                out.errorMessage = 'Enter a valid email address.';
                return out;
            }
            List<CheckoutItem> items;
            try {
                items = (List<CheckoutItem>) JSON.deserialize(itemsJson, List<CheckoutItem>.class);
            } catch (Exception e) {
                out.errorMessage = 'Cart could not be read.';
                return out;
            }
            if (items == null || items.isEmpty()) {
                out.errorMessage = 'The cart is empty.';
                return out;
            }

            // ── The gate: the org's own Census row must say Completed ─────
            BotShield_Census__c census = gateRow(requestId);
            if (census == null) {
                out.errorMessage = 'Human verification not confirmed. Please verify and try again.';
                return out;
            }
            // ── Load sessions + capacity check ────────────────────────────
            Set<Id> sessionIds = new Set<Id>();
            for (CheckoutItem it : items) {
                if (String.isBlank(it.sessionId) || it.guests == null || it.guests < 1 || it.guests > 8) {
                    out.errorMessage = 'Invalid cart line.';
                    return out;
                }
                sessionIds.add(it.sessionId);
            }
            Map<Id, Session__c> sessions = new Map<Id, Session__c>([
                SELECT Id, Capacity__c, Booked_Slots__c, Is_Canceled__c, Experience__r.Name
                FROM Session__c
                WHERE Id IN :sessionIds
            ]);
            for (CheckoutItem it : items) {
                Session__c s = sessions.get(it.sessionId);
                if (s == null || s.Is_Canceled__c) {
                    out.errorMessage = 'A session in the cart is no longer available.';
                    return out;
                }
                Decimal booked = s.Booked_Slots__c == null ? 0 : s.Booked_Slots__c;
                if (s.Capacity__c != null && booked + it.guests > s.Capacity__c) {
                    out.errorMessage = 'Not enough slots left for ' + s.Experience__r.Name + '.';
                    return out;
                }
            }

            // ── Create the bookings, ACTIVE ───────────────────────────────
            Id contactId = findOrCreateContact(email.trim());
            List<Booking__c> bookings = new List<Booking__c>();
            for (CheckoutItem it : items) {
                bookings.add(new Booking__c(
                    Session__c = it.sessionId,
                    Contact__c = contactId,
                    Number_of_Guests__c = it.guests,
                    Is_Canceled__c = false
                ));
            }
            insert bookings;

            for (Booking__c b : [SELECT Name FROM Booking__c WHERE Id IN :bookings]) {
                out.bookingNames.add(b.Name);
            }
            // Tie the audit row to what it gated (in-org only field).
            census.Source_Record_ID__c = String.join(out.bookingNames, ',').abbreviate(255);
            update census;
            out.success = true;
            return out;
        } catch (Exception e) {
            out.errorMessage = 'Something went wrong completing the checkout.';
            return out;
        }
    }

    /**
     * The gate row: Completed, and recent enough to count as present-tense.
     * Returns null when the gate is closed. Reads only — the row was written
     * by BotShield's authenticated push; nothing here trusts the browser.
     */
    private static BotShield_Census__c gateRow(String requestId) {
        if (String.isBlank(requestId)) { return null; }
        List<BotShield_Census__c> rows = [
            SELECT Id, Status__c, Verified__c, Verified_At__c, Source_Record_ID__c
            FROM BotShield_Census__c
            WHERE Request_ID__c = :requestId
            LIMIT 1
        ];
        if (rows.isEmpty()) { return null; }
        BotShield_Census__c r = rows[0];
        if (r.Status__c != 'Completed') { return null; }
        if (r.Verified_At__c != null
            && r.Verified_At__c < Datetime.now().addMinutes(-MAX_VERIFICATION_AGE_MINUTES)) {
            return null;
        }
        return r;
    }

    // ── Cancel with refund (Agents Ask / Q rail hand-off) ────────────────

    public class CancelResult {
        @AuraEnabled public String status;      // pending | canceled | error
        @AuraEnabled public String requestId;   // BotShield request id when pending
        @AuraEnabled public String message;
    }

    public class CancelStatus {
        @AuraEnabled public Boolean found = false;
        @AuraEnabled public Boolean canceled = false;
        @AuraEnabled public String verdict;     // Approved | Denied | Expired | Cancelled | null (still waiting)
        @AuraEnabled public String requestId;
    }

    /**
     * The customer asks to cancel a booking they just made. Money moves, so
     * above the threshold a Coral Cloud employee must co-sign: this starts
     * BotShield_Cancel_Booking_With_Refund, which proposes to the linked
     * refund approver's opaque ID and PAUSES until the Console-pushed
     * BotShield_Resolution__c row fires the resume event. Under the threshold
     * the flow cancels directly. Runs in system mode (autolaunched, guest OK).
     */
    @AuraEnabled
    public static CancelResult requestCancellation(String bookingName) {
        CancelResult out = new CancelResult();
        try {
            if (String.isBlank(bookingName)) { out.status = 'error'; out.message = 'Booking number is required.'; return out; }
            List<Booking__c> bs = [
                SELECT Id, Is_Canceled__c, BotShield_Request_Id__c FROM Booking__c WHERE Name = :bookingName LIMIT 1
            ];
            if (bs.isEmpty()) { out.status = 'error'; out.message = 'Booking not found.'; return out; }
            if (bs[0].Is_Canceled__c) { out.status = 'canceled'; out.message = 'Already cancelled.'; return out; }

            Map<String, Object> inputs = new Map<String, Object>{ 'bookingId' => (String) bs[0].Id };
            Flow.Interview iv = Flow.Interview.createInterview('BotShield_Cancel_Booking_With_Refund', inputs);
            iv.start();
            String requestId = (String) iv.getVariableValue('requestId');
            String proposeStatus = (String) iv.getVariableValue('proposeStatus');

            // Under threshold the flow cancels synchronously (no proposal).
            Booking__c after = [SELECT Is_Canceled__c FROM Booking__c WHERE Id = :bs[0].Id];
            if (after.Is_Canceled__c) { out.status = 'canceled'; out.message = 'Cancelled — refund on its way.'; return out; }

            if (proposeStatus == 'pending' && String.isNotBlank(requestId)) {
                // Remember the request on the booking so the drawer (and anyone
                // else) can follow the resolution without a session.
                update new Booking__c(Id = bs[0].Id, BotShield_Request_Id__c = requestId);
                out.status = 'pending';
                out.requestId = requestId;
                out.message = 'A Coral Cloud manager is being asked to approve the refund.';
                return out;
            }
            out.status = 'error';
            out.message = 'The refund could not be sent for approval.';
            return out;
        } catch (Exception e) {
            out.status = 'error';
            out.message = 'Something went wrong requesting the cancellation.';
            return out;
        }
    }

    /** What the drawer polls: the org's own view — booking flag + resolution verdict. */
    @AuraEnabled
    public static CancelStatus getCancellationStatus(String bookingName) {
        CancelStatus st = new CancelStatus();
        if (String.isBlank(bookingName)) { return st; }
        List<Booking__c> bs = [
            SELECT Id, Is_Canceled__c, BotShield_Request_Id__c FROM Booking__c WHERE Name = :bookingName LIMIT 1
        ];
        if (bs.isEmpty()) { return st; }
        st.found = true;
        st.canceled = bs[0].Is_Canceled__c;
        st.requestId = bs[0].BotShield_Request_Id__c;
        if (String.isNotBlank(st.requestId)) {
            List<BotShield_Resolution__c> rs = [
                SELECT Verdict__c FROM BotShield_Resolution__c WHERE Request_ID__c = :st.requestId LIMIT 1
            ];
            if (!rs.isEmpty()) { st.verdict = rs[0].Verdict__c; }
        }
        return st;
    }

    private static Id findOrCreateContact(String email) {
        List<Contact> cs = [SELECT Id FROM Contact WHERE Email = :email LIMIT 1];
        if (!cs.isEmpty()) {
            return cs[0].Id;
        }
        Contact c = new Contact(LastName = email.substringBefore('@'), Email = email);
        insert c;
        return c.Id;
    }
}
