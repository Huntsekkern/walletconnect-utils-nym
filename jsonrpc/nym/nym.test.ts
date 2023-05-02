import NymWsConnection from "./nym-ws";
import NymWsServiceProvider from "./nym-ws-service_provider"

const RELAY_URL = "wss://staging.relay.walletconnect.com";

/*
Logic should be:
Try to use the permanent staging wc relay, but create the wss connection from the
nym-ws-service-provider.ts instead of ws.ts
This is probably a useful reference: jsonrpc/ws-connection/test/index.test.ts

Once this test works, the second step would be to test both nym-ws and nym-ws-service-provider
conjointly, but that implies already sending messages on the nym mixnet.
Not sure I want to do that as part of the regular test suite...
There is however no real alternative as far as I can think of,
apart from manual testing of course, but which is nearly equivalent.

Let's then say that this second batch of test will be in another file,
and that the current file is only taking inspiration from jsonrpc/ws-connection/test/index.test.ts
but with the service provider instead of the WC client.
 */

