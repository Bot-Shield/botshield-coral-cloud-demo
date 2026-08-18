# cc-botshield-app — BotShield glue for the Coral Cloud demo

Demo-only metadata that wires **BotShield** into the Coral Cloud sample. It depends on the
**BotShield managed package** (`botshield` namespace) being installed first — see the root README.

- `lwc/coralCart` — Shopify-style cart drawer; hosts the package's `botshield-verify` Census widget as the checkout gate; Cancel & refund on the confirmation screen.
- `classes/BotShieldCensusCheckout` — Census-gated checkout (row-gated on `BotShield_Census__c`), cancellation start/status.
- `classes/Coral*Action` + `cc-service-app/genAiFunctions/Coral_*` — site-agent actions (list/cancel/refund status).
- `flows/BotShield_Cancel_Booking_With_Refund` — Agents Ask refund co-sign (pause/resume on the package's platform event).
- `bots/`, `genAiPlugins/`, `genAiPlannerBundles/`, `aiAuthoringBundles/`, `applications/`, `specs/` — the Coral Cloud demo agents (BotShield Concierge, Employee variant) and demo app.
- `objects/Booking__c/fields/BotShield_Request_Id__c` — demo stamp of the Q request on the booking.

`lwc/botshieldVerify` is a transitional copy of the packaged widget; it is removed once the demo org runs on the package (`c-botshield-verify` → `botshield-verify`).
