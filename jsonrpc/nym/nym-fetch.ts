import fetch from "cross-fetch";


const DEFAULT_HTTP_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
};

const DEFAULT_HTTP_METHOD = "POST";

const DEFAULT_FETCH_OPTS = {
  headers: DEFAULT_HTTP_HEADERS,
  method: DEFAULT_HTTP_METHOD,
};

export function nymFetch(url: RequestInfo, payload?: RequestInit): Promise<Response> {
  /* Payload doesn't need to be modified afaik, but url is a fixed url set when the http-connection is open
  This is what should be adapted to the Nym gateway proxying for the relay-server. There is actually a small slight argument
  in favour of doing it within the http-connection, or even above, where the connection is constructed (but this is outside
  of this module, it's probably more at the monorepo level).
  But this will cause more blending of nym and WC, instead of keeping the code somewhat separate.
  Downside of doing it here is kind of "how to make it persistent?" "who is choosing the gateway URL?", so maybe it still
  needs to go higher up, so that it can come from a user input?

  Even after this issue solved, there is still the second point of the cross-fetch library not sending through nym,
  so I should maybe still replace it manually.
  If I need to go lower, could copy code from https://github.com/node-fetch/node-fetch/blob/main/src/index.js
  (one of the form that cross-fetch uses) and protect line 94.
   */
  const res = fetch(url, payload);
  return res;
}