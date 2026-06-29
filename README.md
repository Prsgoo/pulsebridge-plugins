# PulseBridge Plugins

The official plugin packages for [PulseBridge](https://www.npmjs.com/package/pulsebridge) — an Nx + npm-workspaces monorepo of `@prsgoo/*` integrations.

These plugins are not special to the runtime: they conform to the same [plugin contract](./docs/PLUGIN_AUTHORING.md) as any third-party plugin and install the same way over npm.

## Packages

### Integrations

| Package                                     | Source                                           |
| ------------------------------------------- | ------------------------------------------------ |
| `@prsgoo/integration-cloudflare-radar` | Cloudflare Radar internet anomalies & BGP events |
| `@prsgoo/integration-coingecko`        | CoinGecko public crypto price API                |
| `@prsgoo/integration-finnhub-markets`  | Finnhub stock market quotes                      |
| `@prsgoo/integration-fred-economics`   | Federal Reserve FRED economic data               |
| `@prsgoo/integration-gdelt-news`       | GDELT v2 global news event articles              |
| `@prsgoo/integration-nasa-apod`        | NASA Astronomy Picture of the Day                |
| `@prsgoo/integration-nasa-donki`       | NASA DONKI solar flare data                      |
| `@prsgoo/integration-nvd-cve`          | NVD CVE vulnerability data                       |
| `@prsgoo/integration-openaq-air`       | OpenAQ v3 air quality measurements               |
| `@prsgoo/integration-openweather`      | OpenWeatherMap current weather                   |
| `@prsgoo/integration-usgs-earthquakes` | USGS earthquake GeoJSON feed                     |

## Build your own plugin

You don't need this monorepo to write a plugin — scaffold a self-contained package in your own repo:

```bash
npm create pulsebridge-plugin@latest
```

Then read the **[Plugin Authoring Guide](./docs/PLUGIN_AUTHORING.md)** for the full contract: manifest fields, the integration/processor interfaces, scoped secrets, error semantics, and explicit host registration.

## Development (this monorepo)

```bash
npm install
npm run build         # nx run-many -t build
npm test              # vitest across all packages
npm run typecheck
npm run generate:plugin   # scaffold a new package inside this monorepo
```

> The core `pulsebridge` library must be built/published before building plugins — they depend on its compiled output.

## License

MIT
