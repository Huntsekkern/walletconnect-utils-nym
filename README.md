# WalletConnect Utils

Monorepo of JS utility packages for WalletConnect

## Nym implications

The original instructions (setup) below should work as is, as long as the proper Nym clients and Service Provider are running.
There are 4 new packages in `jsonrpc`: `nym-http`, `nym-run-SP`, `nym-SP` and `nym-ws`.

`nym-http` and `nym-ws` are respectively Nym-enabled versions of `http-connection` and `ws-connection`. 
They are only working if a service provider is reachable, however.

`nym-SP` contains the code for said service provider and `nym-run-SP` allows to launch a service provider from the command line.

All the ports and addresses below can be updated.

To run the `nym-SP` tests, a Nym client must be available on port 1978.

To run the `nym-http` tests, Nym clients must be available on port 1977 and 1990 and a service provider must be available
on Nym address GbEM8X8FCpsX6tttTXMu9DTinBeHqNz8Xa32vuGL9BLj.Hz652DoVDfbLrbgWWrr7BEYts4ZmDG4niNNCkYPKjDbM@9Byd9VAtyYMnbVAcqdoQxJnq76XEg2dbxbiF5Aa5Jj9J

To run the `nym-ws` tests, Nym clients must be available on port 1977, 1979 and 1980 and a service provider must be available
on Nym address GbEM8X8FCpsX6tttTXMu9DTinBeHqNz8Xa32vuGL9BLj.Hz652DoVDfbLrbgWWrr7BEYts4ZmDG4niNNCkYPKjDbM@9Byd9VAtyYMnbVAcqdoQxJnq76XEg2dbxbiF5Aa5Jj9J

Notably, running the service provider for the `nym-http` and `nym-ws` tests may make the Nym client on port 1978 
unavailable for the `nym-SP` test, depending on the exact configuration of Nym clients.

Those packages are currently not published on npm and using them require usage of the `npm link` instruction

## Setup

1. Clone the repository:

```bash
git clone https://github.com/WalletConnect/walletconnect-utils.git
```

2. Install all dependencies:

```bash
npm install
```

3. Configure all monorepo packages:

```bash
npm run bootstrap
```

4. Ensure all packages lint, build, and test successfully:

> **For all tests to pass in the following command, you will need your own `TEST_PROJECT_ID` value**,
> which will be generated for you when you set up a new project on [WalletConnect Cloud](https://cloud.walletconnect.com).

```bash
TEST_PROJECT_ID=YOUR_PROJECT_ID npm run check
```

## License

MIT
