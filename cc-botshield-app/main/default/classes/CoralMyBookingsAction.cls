/** Coral Cloud: List My Bookings — the verified customer's bookings, by Booking Number. */
public without sharing class CoralMyBookingsAction {

    @InvocableMethod(
        label='Coral Cloud: List My Bookings'
        description='List the verified customer\'s bookings (booking number, experience, date, guests, total, cancelled or not). Use it to find the booking number when the customer refers to a booking by experience or date.'
    )
    public static List<Response> listBookings(List<Request> requests) {
        List<Response> out = new List<Response>();
        for (Request req : requests) {
            Response r = new Response();
            List<String> lines = new List<String>();
            if (String.isNotBlank(req.contactId)) {
                for (Booking__c b : [
                    SELECT Name, Experience_Name__c, Date__c, Number_of_Guests__c, Total_Price__c, Is_Canceled__c
                    FROM Booking__c WHERE Contact__c = :req.contactId ORDER BY CreatedDate DESC LIMIT 20
                ]) {
                    lines.add(b.Name + ' — ' + b.Experience_Name__c + ' on ' + String.valueOf(b.Date__c)
                        + ', ' + b.Number_of_Guests__c + ' guest(s), $' + b.Total_Price__c
                        + (b.Is_Canceled__c ? ' (cancelled)' : ''));
                }
            }
            r.count = lines.size();
            r.bookings = lines.isEmpty() ? 'No bookings found for this customer.' : String.join(lines, '\n');
            out.add(r);
        }
        return out;
    }

    public class Request {
        @InvocableVariable(required=true label='Contact ID' description='The verified customer\'s Contact Id (mapped from the conversation).')
        public String contactId;
    }
    public class Response {
        @InvocableVariable(label='Bookings' description='One line per booking, starting with the booking number.') public String bookings;
        @InvocableVariable(label='Count') public Integer count = 0;
    }
}
