#!/usr/bin/env bash
# Install the BotShield managed package, then deploy the Coral Cloud demo on top.
# Usage: PACKAGE=04t... ORG=my-demo-org ./scripts/setup-botshield-demo.sh
set -euo pipefail
ORG="${ORG:?set ORG to your target org alias}"
PACKAGE="${PACKAGE:?set PACKAGE to the BotShield 04t... version id (from the package repo)}"
: "${SF_CC_PLACEHOLDER_USERNAME:?set SF_CC_PLACEHOLDER_USERNAME (the agent/bot user)}"

echo "1/4  Installing BotShield package $PACKAGE ..."
sf package install --package "$PACKAGE" -o "$ORG" --wait 20 --publish-wait 20 --no-prompt

echo "2/4  Assigning BotShield permission sets ..."
for ps in botshield__BotShield_Admin botshield__BotShield_User botshield__BotShield_Integration botshield__BotShield_Agent_Access; do
  sf org assign permset -o "$ORG" -n "$ps" || true
done

echo "3/4  Deploying Coral Cloud (base, site, employee, service) ..."
sf project deploy start -o "$ORG" \
  -d cc-base-app -d cc-site -d cc-employee-app -d cc-service-app -w 40

echo "4/4  Deploying the BotShield demo glue (cc-botshield-app) ..."
sf project deploy start -o "$ORG" -d cc-botshield-app -w 40

cat <<NOTE

Done. Next (manual, once):
  - BotShield Setup tab → set the agent key on the 'BotShield Agent (Default)' External Credential.
  - Create the External Client App + connect the org in the BotShield Console (Integrations → Salesforce).
  - Publish the Coral Cloud site; set the Census deployment's allowed origins to the site URL.
  - Point cc-service-app agent at your agent user; activate it.
NOTE
