#!/usr/bin/env bash
# Posts a published chart release to Slack. publish.yml runs it as the publish
# job's last step, so only after scripts/publish-chart.sh pushed the chart and
# the job verified its provenance attestation, and a failure here does not fail
# the release. It runs in the job that can publish and sign, so it uses only jq
# and curl.
#
# Environment: TAG (<chart>-v<version>), RELEASE_URL (its GitHub Release), NAME
# and DIGEST (the pushed chart and manifest digest publish-chart.sh reported),
# and SLACK_WEBHOOK_URL (the SLACK_RELEASES_WEBHOOK secret). Without a webhook it
# warns and fails instead of reporting a notification it did not send.
set -euo pipefail

: "${TAG:?TAG must be set}" "${RELEASE_URL:?RELEASE_URL must be set}"
: "${NAME:?NAME must be set}" "${DIGEST:?DIGEST must be set}"
if [ -z "${SLACK_WEBHOOK_URL:-}" ]; then
  echo '::warning title=Slack notification not sent::SLACK_RELEASES_WEBHOOK is not set, so this release was not posted to Slack.'
  exit 1
fi

# jq builds the JSON, and the values are escaped for Slack, which reads &, < and
# > as markup (links and mentions).
payload=$(jq -n --arg url "$RELEASE_URL" --arg tag "$TAG" --arg ref "oci://$NAME:${TAG##*-v}@$DIGEST" '
  def text: gsub("&"; "&amp;") | gsub("<"; "&lt;") | gsub(">"; "&gt;");
  {text: ":package: *<\($url | text)|\($tag | text)>* of the Browserless Helm chart published as `\($ref | text)` (provenance attestation verified)."}')

# --variable reads the webhook from the environment, so it is in no argument
# list. --retry repeats timeouts, 429 and 5xx responses, not rejected messages.
curl --silent --show-error --fail-with-body \
  --variable %SLACK_WEBHOOK_URL --expand-url '{{SLACK_WEBHOOK_URL}}' \
  --connect-timeout 10 --max-time 30 --retry 3 --retry-delay 2 \
  --header 'Content-Type: application/json' --data "$payload"
echo
