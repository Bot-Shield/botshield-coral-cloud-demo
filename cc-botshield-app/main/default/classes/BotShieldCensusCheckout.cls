/**
 * BotShieldCensusCheckout — the Census-gated cart checkout for the Coral
 * Cloud site.
 *
 * Rail choice: a human present at their own browser is the CENSUS question
 * ("Is a human here?") — verified inline at checkout via the hosted challenge,
 * mirrored after demo.botshield.ai. The Agents Ask / Q rail stays with the
 * agent chat on this site, where the actor is software.
 *
 * The Personhood Firewall rule from the strategy doc applies verbatim: the
 * client's word is never the gate. The browser hands us an attestation token;
 * THIS class verifies it against BotShield (sdk/verify-token — no API key,
 * the token is the proof) before a single booking row is created. An invalid
 * or missing token creates nothing.
 *
 * Bookings are created ACTIVE here (unlike the Q-rail controller's pending
 * flip) because the human just verified, present-tense, at this checkout —
 * there is no later approval to wait for.
 */
public without sharing class BotShieldCensusCheckout {

    private static final Integer CALLOUT_TIMEOUT_MS = 30000;

    public class CheckoutItem {
        public String sessionId;
        public Integer guests;
    }

    public class CheckoutResult {
        @AuraEnabled public Boolean success = false;
        @AuraEnabled public List<String> bookingNames = new List<String>();
        @AuraEnabled public String errorMessage;
    }

    @AuraEnabled
    public static CheckoutResult checkout(String itemsJson, String email, String token) {
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

            // ── The gate: verify the Census token server-side ─────────────
            // Callout BEFORE any DML (Apex rule), which also means an invalid
            // token exits before anything exists to roll back.
            if (String.isBlank(token) || !verifyToken(token)) {
                out.errorMessage = 'Human verification failed. Please verify and try again.';
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
            out.success = true;
            return out;
        } catch (Exception e) {
            out.errorMessage = 'Something went wrong completing the checkout.';
            return out;
        }
    }

    /**
     * POST sdk/verify-token. WG single-wraps success as { data: { valid } }
     * and reports failures as HTTP 200 with an error body — parse the
     * envelope, never trust the HTTP status (the standing WG lesson).
     */
    @TestVisible
    private static Boolean verifyToken(String token) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:' + BotShieldConfig.NAMED_CREDENTIAL
            + BotShieldConfig.OPERATIONS_BASE + '/sdk/verify-token');
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setTimeout(CALLOUT_TIMEOUT_MS);
        req.setBody(JSON.serialize(new Map<String, Object>{ 'token' => token }));

        try {
            HttpResponse res = new Http().send(req);
            Object parsed = JSON.deserializeUntyped(res.getBody());
            if (!(parsed instanceof Map<String, Object>)) { return false; }
            Map<String, Object> body = (Map<String, Object>) parsed;

            Object dataObj = body.get('data');
            Map<String, Object> payload = (dataObj instanceof Map<String, Object>)
                ? (Map<String, Object>) dataObj
                : body;
            // Peel one nested data, defensively.
            Object nested = payload.get('data');
            if (nested instanceof Map<String, Object>) {
                payload = (Map<String, Object>) nested;
            }

            Object valid = payload.get('valid');
            return valid instanceof Boolean && (Boolean) valid;
        } catch (Exception e) {
            // Unreachable verifier = closed gate. Never fail open.
            return false;
        }
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
