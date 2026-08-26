# PulseBridge Plugins

The official plugin packages for [PulseBridge](https://www.npmjs.com/package/pulsebridge) — an Nx + npm-workspaces monorepo of `@prsgoo/*` integrations and processors.

These plugins are not special to the runtime: they conform to the same [plugin contract](./docs/PLUGIN_AUTHORING.md) as any third-party plugin and install the same way over npm.

## Packages

### Integrations

Connect to one external system, poll or receive webhooks, and emit canonical `PulseRecord<T>` objects.

| Package | Description |
| --- | --- |
| `@prsgoo/integration-adsbfi` | adsb.fi community ADS-B real-time flight positions |
| `@prsgoo/integration-airplaneslive` | AirplanesLive community ADS-B real-time flight positions |
| `@prsgoo/integration-cloudflare-radar` | Cloudflare Radar internet anomalies and BGP events |
| `@prsgoo/integration-coingecko` | CoinGecko public cryptocurrency price API |
| `@prsgoo/integration-discord` | Discord webhook outbound notifications (action) |
| `@prsgoo/integration-finnhub-markets` | Finnhub stock market quotes |
| `@prsgoo/integration-fred-economics` | Federal Reserve FRED economic data series |
| `@prsgoo/integration-gdelt-news` | GDELT v2 global news event articles |
| `@prsgoo/integration-nasa-apod` | NASA Astronomy Picture of the Day |
| `@prsgoo/integration-nasa-donki` | NASA DONKI solar and space weather events |
| `@prsgoo/integration-nasa-firms` | NASA FIRMS active wildfire and fire detection |
| `@prsgoo/integration-ntfy` | ntfy.sh push notification outbound actions |
| `@prsgoo/integration-nvd-cve` | NVD CVE vulnerability feed |
| `@prsgoo/integration-open-elevation` | Open-Elevation terrain elevation batch queries (action) |
| `@prsgoo/integration-openaq-air` | OpenAQ v3 air quality measurements |
| `@prsgoo/integration-opensky` | OpenSky Network ADS-B real-time flight positions |
| `@prsgoo/integration-openweather` | OpenWeatherMap current weather |
| `@prsgoo/integration-rss` | Generic RSS and Atom feed reader |
| `@prsgoo/integration-telegram` | Telegram Bot outbound notifications (action) |
| `@prsgoo/integration-usgs-earthquakes` | USGS Earthquake Hazards Program public GeoJSON feed |

### Processors

Consume canonical records from one or more integrations, aggregate them, and emit a named view.

| Package | Description |
| --- | --- |
| `@prsgoo/processor-crypto-ticker` | Aggregates `crypto.price` records into a live ticker view with price movement |
| `@prsgoo/processor-daily-digest` | Combines weather and NASA APOD data into a daily digest view |
| `@prsgoo/processor-flight-feed` | Aggregates `flight.position` records from multiple sources into a unified live feed |
| `@prsgoo/processor-news-feed` | Aggregates `news.event` records from GDELT and RSS into a unified news feed |
| `@prsgoo/processor-seismic-feed` | Aggregates `seismic.event` records into a map-ready seismic feed view |
| `@prsgoo/processor-weather-feed` | Turns `weather.current` records into a per-location weather feed view |
| `@prsgoo/processor-wildfire-feed` | Aggregates `wildfire.event` records into a unified wildfire feed view |

## Build your own plugin

You don't need this monorepo to write a plugin — scaffold a self-contained package in your own repo:

```bash
npm create pulsebridge-plugin@latest
```

Then read the **[Plugin Authoring Guide](./docs/PLUGIN_AUTHORING.md)** for the full contract: manifest fields, the integration and processor interfaces, scoped secrets, error semantics, and explicit host registration.

## Development (this monorepo)

```bash
npm install
npm run build         # nx run-many -t build
npm test              # vitest across all packages
npm run typecheck
npm run generate:plugin   # scaffold a new package inside this monorepo
```

> The core `pulsebridge` library must be built or published before building plugins, as they depend on its compiled output.

## License

MIT
