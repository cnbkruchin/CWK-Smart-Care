// Canonical signing strings shared by GAS and the Node gateway (gateway/). Any change here is a
// protocol version change: bump the prefix and keep the old one until both sides are deployed.
//
// GAS → gateway request:   headers X-CWK-Key-Id, X-CWK-Timestamp (unix s), X-CWK-Nonce (uuid),
//                          X-CWK-Signature = base64(HMAC-SHA256(secret, requestSigningString))
// gateway → GAS response:  header X-CWK-Signature = base64(HMAC-SHA256(secret, responseSigningString))
// gateway → GAS envelope:  JSON body {v:1, kid, ts, nonce, source, payload (string), sig}
//                          sig = base64(HMAC-SHA256(envelopeSecret, envelopeSigningString))

export const MAX_CLOCK_SKEW_SECONDS = 300;

export function requestSigningString({ method, path, ts, nonce, bodySha256 }) {
  return ['CWK-GW-V1', String(method).toUpperCase(), path, String(ts), nonce, bodySha256].join('\n');
}

export function responseSigningString({ status, nonce, bodySha256 }) {
  return ['CWK-GW-V1-RESP', String(status), nonce, bodySha256].join('\n');
}

export function envelopeSigningString({ kid, ts, nonce, source, payloadSha256 }) {
  return ['CWK-ENV-V1', kid, String(ts), nonce, source, payloadSha256].join('\n');
}

export function withinSkew(tsSeconds, nowMs, skew = MAX_CLOCK_SKEW_SECONDS) {
  const t = Number(tsSeconds);
  return Number.isFinite(t) && Math.abs(nowMs / 1000 - t) <= skew;
}
