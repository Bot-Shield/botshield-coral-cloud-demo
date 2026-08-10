import { LightningElement } from 'lwc';

export default class SiteHeader extends LightningElement {
    // Booking starts at the experiences browser further down the home page —
    // pick an experience, pick a session, and the Book button runs the
    // BotShield confirmation gate. BOOK NOW just takes the guest there.
    handleBookClick(event) {
        event.preventDefault(); // href="#" would jump back to the top
        window.scrollBy({
            top: window.innerHeight,
            left: 0,
            behavior: 'smooth'
        });
    }
}
