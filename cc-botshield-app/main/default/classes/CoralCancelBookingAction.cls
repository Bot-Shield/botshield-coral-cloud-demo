/**
 * Coral Cloud: Cancel Booking With Refund — Agentforce action for the site chat.
 *
 * The verified customer (BotShield-linked; Contact mapped in from the
 * conversation) asks to cancel one of THEIR bookings. Money moves, so above the
 * refund threshold a Coral Cloud manager co-signs on their phone (Agents Ask):
 * this starts BotShield_Cancel_Booking_With_Refund, which pauses until the
 * BotShield-pushed resolution fires the resume event. Ownership is enforced
 * here — a booking number alone never cancels someone else's booking.
 */
public without sharing class CoralCancelBookingAction {

    @InvocableMethod(
        label='Coral Cloud: Cancel Booking With Refund'
        description='Cancel one of the verified customer\'s bookings and refund it. Above the refund threshold a Coral Cloud manager must approve on their phone via BotShield; returns status "pending" with a requestId while that approval is outstanding, "canceled" if it completed immediately, or "error". Then poll "Coral Cloud: Check Refund Status" every few seconds until the booking is canceled or the refund is declined.'
    )
    public static List<Response> cancel(List<Request> requests) {
        List<Response> out = new List<Response>();
        for (Request req : requests) {
            Response r = new Response();
            r.bookingNumber = req.bookingNumber;
            List<Booking__c> bs = String.isBlank(req.bookingNumber) ? new List<Booking__c>() : [
                SELECT Id, Name, Contact__c, Is_Canceled__c, Total_Price__c, Experience_Name__c
                FROM Booking__c WHERE Name = :req.bookingNumber LIMIT 1
            ];
            if (bs.isEmpty()) {
                r.status = 'error'; r.message = 'No booking with that number.'; out.add(r); continue;
            }
            Booking__c b = bs[0];
            if (String.isBlank(req.contactId) || b.Contact__c != Id.valueOf(req.contactId)) {
                r.status = 'error'; r.message = 'That booking was not made for this verified customer, so it cannot be cancelled here.'; out.add(r); continue;
            }
            if (b.Is_Canceled__c) {
                r.status = 'canceled'; r.message = 'That booking is already cancelled.'; out.add(r); continue;
            }
            r.refundAmount = b.Total_Price__c;
            r.experienceName = b.Experience_Name__c;
            BotShieldCensusCheckout.CancelResult cr = BotShieldCensusCheckout.requestCancellation(b.Name);
            r.status = cr.status;
            r.requestId = cr.requestId;
            r.message = cr.status == 'pending'
                ? 'A Coral Cloud manager is being asked to approve the $' + b.Total_Price__c + ' refund on their phone.'
                : cr.message;
            out.add(r);
        }
        return out;
    }

    public class Request {
        @InvocableVariable(required=true label='Booking number' description='The booking number, e.g. B-00001608.')
        public String bookingNumber;
        @InvocableVariable(required=true label='Contact ID' description='The verified customer\'s Contact Id (mapped from the conversation). Only that customer\'s bookings can be cancelled.')
        public String contactId;
    }
    public class Response {
        @InvocableVariable(label='Status' description='pending | canceled | error') public String status;
        @InvocableVariable(label='Request ID' description='BotShield request id while pending.') public String requestId;
        @InvocableVariable(label='Booking number') public String bookingNumber;
        @InvocableVariable(label='Experience name') public String experienceName;
        @InvocableVariable(label='Refund amount') public Decimal refundAmount;
        @InvocableVariable(label='Message') public String message;
    }
}
