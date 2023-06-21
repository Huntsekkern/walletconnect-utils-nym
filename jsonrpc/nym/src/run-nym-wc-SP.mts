import NymWsServiceProvider from "./nym-ws-service_provider";

const SP = new NymWsServiceProvider();
// TODO this is not compatible with the cjs build! Should either accept this, or put that in a separate package
await SP.setup();