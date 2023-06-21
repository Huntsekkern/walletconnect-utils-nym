import { NymWsServiceProvider } from "nym-ws-connection";

const SP = new NymWsServiceProvider();
await SP.setup();