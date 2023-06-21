const NymWsServiceProvider = require("nym-ws-connection");

const SP = new NymWsServiceProvider();
await SP.setup();