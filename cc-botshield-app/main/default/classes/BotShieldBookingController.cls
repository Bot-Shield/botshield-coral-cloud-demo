/**
 * BotShieldBookingController — the "Book Now" gate for the Coral Cloud site.
 *
 * Implements the booking flow the sample app leaves stubbed ("Not
 * Implemented"), gated behind a BotShield human confirmation: the guest
 * proposes the booking, a Q Card lands in their BotShield app, they confirm
 * with Face ID, and only then does the booking become active.
 *
 * Pending-booking mechanism: Booking__c.Status__c is a formula over
 * Is_Canceled__c, and Session__c.Booked_Slots__c is a rollup that EXCLUDES
 * canceled bookings. So the proposal inserts the booking with
 * Is_Canceled__c = true — it holds the confirmed-at-propose-time parameters
 * (session, guests, price) without consuming capacity — and only an approved
 * verdict flips it active. Denied / expired / cancelled cards simply leave it
 * canceled: the flow fails closed with no compensating cleanup needed.
 *
 * The verdict is read server-side from BotShieldQService.checkStatus — the
 * browser only polls; nothing the client sends can flip a booking active.
 *
 * Depends on the BotShieldQService / BotShieldConfig classes already deployed
 * in this org (botshield-salesforce repo, the parallel-path POC — NOT the
 * managed package). `without sharing` + system-mode DML so the site guest
 * user needs only Apex class access, no object CRUD grants.
 */
public without sharing class BotShieldBookingController {

    private static final String CATEGORY = 'travel.book'; // on the agent key's allowlist
    private static final Integer TTL_SECONDS = 300;

    public class GateException extends Exception {}

    // ── DTOs ──────────────────────────────────────────────────────────────

    public class ProposeResponse {
        @AuraEnabled public String requestId;
        @AuraEnabled public String status;        // 'queued' | 'error'
        @AuraEnabled public String ttlAt;
        @AuraEnabled public String experienceName;
        @AuraEnabled public Decimal totalPrice;
        @AuraEnabled public String errorMessage;
    }

    public class StatusResponse {
        @AuraEnabled public String status;        // queued|approved|denied|cancelled|expired|error
        @AuraEnabled public String bookingName;   // B-00000042, set iff approved
        @AuraEnabled public Id bookingId;
        @AuraEnabled public String errorMessage;
    }

    // ── propose ───────────────────────────────────────────────────────────

    @AuraEnabled
    public static ProposeResponse proposeBooking(
        Id sessionId, String email, Integer guests
    ) {
        ProposeResponse out = new ProposeResponse();
        try {
            if (String.isBlank(email) || !Pattern.matches('^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$', email.trim())) {
                throw new GateException('Enter a valid email address.');
            }
            if (guests == null || guests < 1 || guests > 8) {
                throw new GateException('Number of guests must be between 1 and 8.');
            }

            Session__c s = [
                SELECT Id, Date__c, Start_Time__c, End_Time__c, Capacity__c,
                       Booked_Slots__c, Is_Canceled__c,
                       Experience__r.Name, Experience__r.Price__c
                FROM Session__c
                WHERE Id = :sessionId
                LIMIT 1
            ];
            if (s.Is_Canceled__c) {
                throw new GateException('This session has been canceled.');
            }
            Decimal booked = s.Booked_Slots__c == null ? 0 : s.Booked_Slots__c;
            if (s.Capacity__c != null && booked + guests > s.Capacity__c) {
                throw new GateException('Not enough slots left for ' + guests + ' guest(s).');
            }

            Decimal price = s.Experience__r.Price__c == null ? 0 : s.Experience__r.Price__c;
            Decimal total = price * guests;
            String requestId = UUID.randomUUID().toString();

            // Callout BEFORE any DML — Apex forbids callouts after uncommitted
            // writes in one transaction. Order also fails safe: an error here
            // leaves nothing behind to clean up.
            BotShieldQService.InquireRequest req = new BotShieldQService.InquireRequest();
            req.requestId = requestId;
            req.summaryTitle = 'Book: ' + s.Experience__r.Name;
            req.category = CATEGORY;
            req.userEmail = email.trim();
            req.ttlSeconds = TTL_SECONDS;
            BotShieldQService.ActionDetail d = new BotShieldQService.ActionDetail();
            d.label = 'Total';
            d.value = '$' + String.valueOf(total);
            req.summaryDetail = d;
            req.detailsJson = JSON.serialize(new List<Map<String, String>>{
                new Map<String, String>{ 'title' => 'EXPERIENCE', 'value' => s.Experience__r.Name },
                new Map<String, String>{ 'title' => 'DATE', 'value' => String.valueOf(s.Date__c) },
                new Map<String, String>{ 'title' => 'TIME', 'value' => formatTime(s.Start_Time__c) + '–' + formatTime(s.End_Time__c) },
                new Map<String, String>{ 'title' => 'GUESTS', 'value' => String.valueOf(guests) },
                new Map<String, String>{ 'title' => 'TOTAL', 'value' => '$' + String.valueOf(total) }
            });

            BotShieldQService.InquireResult r = BotShieldQService.inquire(req);
            if (r.isError()) {
                throw new GateException(friendlyError(r.errorMessage, r.statusCode));
            }

            // Pending booking, AFTER the card exists. Date, times, experience
            // name and total are all formulas off the session — only the
            // relationships + guests are writable. Is_Canceled__c = true means
            // it holds the parameters without consuming capacity; only an
            // approved verdict (checkBooking) flips it active.
            insert new Booking__c(
                Session__c = s.Id,
                Contact__c = findOrCreateContact(email.trim()),
                Number_of_Guests__c = guests,
                Is_Canceled__c = true,
                BotShield_Request_Id__c = requestId
            );

            out.requestId = requestId;
            out.status = r.status;
            out.ttlAt = r.ttlAt;
            out.experienceName = s.Experience__r.Name;
            out.totalPrice = total;
            return out;
        } catch (GateException e) {
            out.status = 'error';
            out.errorMessage = e.getMessage();
            return out;
        } catch (Exception e) {
            out.status = 'error';
            out.errorMessage = 'Something went wrong starting the confirmation. Please try again.';
            return out;
        }
    }

    // ── poll ──────────────────────────────────────────────────────────────

    @AuraEnabled
    public static StatusResponse checkBooking(String requestId) {
        StatusResponse out = new StatusResponse();
        try {
            BotShieldQService.StatusResult r = BotShieldQService.checkStatus(requestId);
            if (r.isError()) {
                out.status = 'error';
                out.errorMessage = friendlyError(r.errorMessage, r.statusCode);
                return out;
            }
            out.status = r.status;

            if (r.status == 'approved') {
                // The only path that activates a booking: a verdict read from
                // BotShield by this server. Idempotent — re-polling after the
                // flip returns the same confirmed booking.
                List<Booking__c> bs = [
                    SELECT Id, Name, Is_Canceled__c
                    FROM Booking__c
                    WHERE BotShield_Request_Id__c = :requestId
                    LIMIT 1
                ];
                if (bs.isEmpty()) {
                    out.status = 'error';
                    out.errorMessage = 'Confirmation found but no matching booking.';
                    return out;
                }
                if (bs[0].Is_Canceled__c) {
                    bs[0].Is_Canceled__c = false;
                    update bs[0];
                }
                out.bookingId = bs[0].Id;
                out.bookingName = bs[0].Name;
            }
            return out;
        } catch (Exception e) {
            out.status = 'error';
            out.errorMessage = 'Could not check the confirmation status.';
            return out;
        }
    }

    // ── cancel ────────────────────────────────────────────────────────────

    @AuraEnabled
    public static StatusResponse cancelBooking(String requestId) {
        StatusResponse out = new StatusResponse();
        try {
            BotShieldQService.StatusResult r = BotShieldQService.cancel(requestId);
            // Already-resolved cards error here; either way the local booking
            // stays canceled unless an approved verdict flipped it, so report
            // cancelled and let the next poll settle any race.
            out.status = r.isError() ? 'cancelled' : (r.status == null ? 'cancelled' : r.status);
            return out;
        } catch (Exception e) {
            out.status = 'cancelled';
            return out;
        }
    }

    // ── helpers ───────────────────────────────────────────────────────────

    private static Id findOrCreateContact(String email) {
        List<Contact> cs = [SELECT Id FROM Contact WHERE Email = :email LIMIT 1];
        if (!cs.isEmpty()) {
            return cs[0].Id;
        }
        Contact c = new Contact(
            LastName = email.substringBefore('@'),
            Email = email
        );
        insert c;
        return c.Id;
    }

    private static String formatTime(Time t) {
        if (t == null) { return ''; }
        String h = String.valueOf(t.hour()).leftPad(2, '0');
        String m = String.valueOf(t.minute()).leftPad(2, '0');
        return h + ':' + m;
    }

    // Map raw WG errors to guest-safe copy. Never leak endpoint or key detail.
    private static String friendlyError(String message, Integer statusCode) {
        String m = message == null ? '' : message.toLowerCase();
        if (statusCode == 404 || m.contains('not found') || m.contains('not registered')) {
            return 'No BotShield account found for that email. Download the BotShield app and create an account first.';
        }
        if (statusCode == 401 || statusCode == 403) {
            return 'The booking service is not configured. Please contact the resort.';
        }
        return 'The confirmation service is unavailable right now. Please try again shortly.';
    }
}
