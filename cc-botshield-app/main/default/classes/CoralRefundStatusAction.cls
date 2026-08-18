/**
 * Coral Cloud: Check Refund Status — reads THE ORG (booking flag + the
 * BotShield-pushed resolution verdict). No callout: the manager's decision
 * arrives as a BotShield_Resolution__c row and the pause/resume flow flips
 * the booking; this just reports what the org knows.
 */
public without sharing class CoralRefundStatusAction {

    @InvocableMethod(
        label='Coral Cloud: Check Refund Status'
        description='Check whether a pending cancellation/refund has been decided. Returns canceled=true when the manager approved and the booking is cancelled; verdict "Denied"/"Expired"/"Cancelled" when it was not approved; otherwise still pending — keep polling every few seconds.'
    )
    public static List<Response> check(List<Request> requests) {
        List<Response> out = new List<Response>();
        for (Request req : requests) {
            Response r = new Response();
            r.bookingNumber = req.bookingNumber;
            BotShieldCensusCheckout.CancelStatus st = BotShieldCensusCheckout.getCancellationStatus(req.bookingNumber);
            r.found = st.found;
            r.canceled = st.canceled;
            r.verdict = st.verdict;
            r.status = !st.found ? 'error' : st.canceled ? 'canceled' : (st.verdict != null && st.verdict != 'Approved') ? 'declined' : 'pending';
            r.message = r.status == 'canceled' ? 'Refund approved — the booking is cancelled.'
                : r.status == 'declined' ? 'The refund was ' + String.valueOf(st.verdict).toLowerCase() + ' — the booking stays as is.'
                : r.status == 'pending' ? 'Still waiting for the manager\'s decision.' : 'No booking with that number.';
            out.add(r);
        }
        return out;
    }

    public class Request {
        @InvocableVariable(required=true label='Booking number') public String bookingNumber;
    }
    public class Response {
        @InvocableVariable(label='Status' description='pending | canceled | declined | error') public String status;
        @InvocableVariable(label='Canceled') public Boolean canceled = false;
        @InvocableVariable(label='Verdict') public String verdict;
        @InvocableVariable(label='Found') public Boolean found = false;
        @InvocableVariable(label='Booking number') public String bookingNumber;
        @InvocableVariable(label='Message') public String message;
    }
}
