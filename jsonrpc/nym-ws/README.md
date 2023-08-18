The current state of this Nym integration of Nym is local, 
without spinning up a TS module.

In the future, I can consider making it a proper TS/JS module,
so that it is easier to reuse in other parts of the code than where I'm directly integrating.

Must `npm link` here if not published yet.
walletconnect-monorepo-nym must then `npm link nym-ws-connection nym-http-connection` (both at the same time!) after `npm install`, with the local links removed during the `npm install` phase (messy set-up necessary by npm...) 