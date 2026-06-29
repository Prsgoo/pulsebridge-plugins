# PulseBridge Plugin Authoring Guide

This is the contract for building a PulseBridge plugin — in this monorepo or, more commonly, in **your own repository**. The runtime (`pulsebridge`) installs and runs any npm package that conforms to it.

A plugin is one of two kinds:

- **Integration** — polls an external system and normalizes its data into canonical `PulseRecord` objects.
- **Processor** — reacts to records and emits a named `PulseViewRecord` (a "view").

## Quick start

```bash
npm create pulsebridge-plugin@latest
```

This scaffolds a self-contained, tested package. The rest of this document is the reference for what that package must satisfy.

## Package requirements

Your `package.json` must:

- Be **ESM** — `"type": "module"`.
- Declare a runtime dependency on `pulsebridge` (the version range you target — see [Versioning](#versioning--compatibility)).
- Expose your plugin class from the package entry (`main` / `exports` / `types`).
- Optionally include the `"pulsebridge-plugin"` keyword for npm discoverability:

```json
{
  "type": "module",
  "keywords": ["pulsebridge-plugin"],
  "dependencies": { "pulsebridge": "^0.1.0-alpha.9" }
}
```

> The host registers plugins explicitly by importing the class — the core never auto-loads packages. The `"pulsebridge-plugin"` keyword is just an npm tag so people can find PulseBridge plugins; it has no effect on registration.

## Integration plugins

```ts
interface IntegrationPlugin<TConfig = unknown> {
  readonly manifest: IntegrationPluginManifest;
  readonly configSchema?: ZodType<TConfig>;

  configure?(config: TConfig): void;
  init?(context: RuntimeContext): Promise<void> | void;
  execute(
    operationId: string,
    context: RuntimeContext,
  ): Promise<ReadonlyArray<PulseRecord<unknown>>>;
  reauth?(context: RuntimeContext): Promise<void>; // OAuth2 refresh
  destroy?(): Promise<void> | void;
}
```

`execute()` is the heart of an integration: fetch from the upstream API, normalize the response, and return `PulseRecord[]`. Throw a [typed error](#error-handling) to signal auth/rate-limit/transient failures.

### IntegrationPluginManifest

```ts
{
  id: string;            // stable unique id — use your package name
  name: string;          // human-readable
  version: string;       // your plugin's semver
  kind: PluginKinds.INTEGRATION;

  operations: ReadonlyArray<{
    id: string;          // passed to execute(operationId, ...)
    name: string;
    recordType: string;  // the PulseRecord.type this operation produces
  }>;

  auth?: {
    type: "none" | "apiKey" | "bearerToken" | "oauth2";
    secrets?: ReadonlyArray<{ key: string; required: boolean; description?: string }>;
    tokenKey?: string;   // oauth2 only: key in the TokenStore (defaults to plugin id)
  };

  polling?: HardPollingConfig | FlexiblePollingConfig;
  rateLimit?: { requestsPerMinute?: number; maxConcurrentRequests?: number };

  requiresCapabilities?: ReadonlyArray<string>;
  recommendsCapabilities?: ReadonlyArray<string>;
}
```

### Polling

Polling is a discriminated union on `hard`:

```ts
// Hard — fixed by an API constraint; the host CANNOT override it.
{ defaultIntervalMs: number; hard: true }

// Flexible — the host MAY override, clamped to minIntervalMs.
{ defaultIntervalMs: number; minIntervalMs?: number; hard: false }
```

Use `hard: true` when the upstream enforces a fixed cadence (e.g. a daily feed). Use `hard: false` for most APIs so operators can tune frequency.

## Processor plugins

```ts
interface ProcessorPlugin<TConfig = unknown> {
  readonly manifest: ProcessorPluginManifest;
  readonly configSchema?: ZodType<TConfig>;

  configure?(config: TConfig): void;
  init?(context: RuntimeContext): Promise<void> | void;
  process(
    records: ReadonlyArray<PulseRecord>,
    context: RuntimeContext,
    views?: ReadonlyMap<string, PulseViewRecord>, // present when consumesViews is declared
  ): Promise<PulseViewRecord>;
  destroy?(): Promise<void> | void;
}
```

### ProcessorPluginManifest

```ts
{
  id: string;
  name: string;
  version: string;
  kind: PluginKinds.PROCESSOR;

  consumes: ReadonlyArray<string>;       // record types that trigger this processor
  produces?: ReadonlyArray<string>;      // view names this processor emits
  consumesViews?: ReadonlyArray<string>; // views from other processors it depends on

  providesCapabilities?: ReadonlyArray<string>;
  recommendsCapabilities?: ReadonlyArray<string>;
}
```

### Chaining

A processor that declares `consumesViews` runs **after** the processors that `produce` those views — the runtime builds a dependency graph from `produces`/`consumesViews` and executes in topological order. The upstream views arrive as the third argument to `process()`. Processors declaring neither run in the first pass. A dependency cycle is logged as a warning.

## Records and views

```ts
interface PulseRecord<TData> {
  type: string; // stable domain id, e.g. "weather.current"
  timestamp: string; // ISO-8601
  source: string; // the producing plugin id
  entityKey?: string; // deduplication key
  data: TData;
}

interface PulseViewRecord<TItem> {
  view: string; // the view name (matches manifest.produces)
  generatedAt: string; // ISO-8601
  items: ReadonlyArray<TItem>;
}
```

Reads from the host (`getRecords()`, `getView()`) return whatever was last written — they never trigger a live fetch.

## RuntimeContext

Both `execute()` and `process()` receive a context:

```ts
interface RuntimeContext {
  logger: PulseLogger; // debug/info/warn/error
  now(): Date; // use this, not Date.now(), so tests can control time
  secrets: SecretStore; // scoped to your declared secrets only
  tokens?: TokenStore; // present when the host configured OAuth2
  stateStore?: StateStore; // key-value persistence for stateful processors
}
```

## Secrets and scoping

Declare every secret your plugin needs in `manifest.auth.secrets`. At runtime you receive a **scoped** secret store — you can only read keys you declared:

```ts
const key = context.secrets.get("MY_API_KEY"); // ok if declared
context.secrets.get("OTHER_KEY"); // throws ScopedSecretAccessError
```

`get()` returns `string | undefined`. Guard required secrets explicitly — do **not** use a non-null assertion:

```ts
const apiKey = context.secrets.get("MY_API_KEY");
if (!apiKey) {
  throw new PluginAuthError("MY_API_KEY secret is required but not set.");
}
```

The host supplies values out-of-band via `platform.provision(pluginId, { MY_API_KEY: "..." })` — the core encrypts them at rest and exposes only your declared keys. The host pre-checks `required: true` secrets before calling `execute()`, but guarding keeps your plugin correct in tests and standalone use.

## Error handling

Throw these typed classes (all exported from `pulsebridge`) so the runtime reacts correctly:

| Error                                | Throw when                      | Runtime response                                                                  |
| ------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------- |
| `PluginAuthError`                    | Credentials rejected / missing  | status → `auth_error`, no backoff                                                 |
| `ReauthRequiredError`                | OAuth2 token expired or revoked | calls `reauth()`, else status → `needs_reauth`                                    |
| `RateLimitError(msg, retryAfterMs?)` | HTTP 429                        | status → `rate_limited`, backs off for `retryAfterMs`                             |
| `TransientError(msg, retryAfterMs?)` | HTTP 5xx / network blip         | status → `degraded`, short backoff, does **not** count toward the circuit breaker |

Any other thrown error is treated as unexpected: exponential backoff, and (if the host set `maxConsecutiveFailures`) eventual permanent disable.

## Lifecycle

1. `configure(config)` — called with validated config (against `configSchema` if provided).
2. `init(context)` — optional one-time setup.
3. `execute()` / `process()` — called on schedule (integration) or reactively (processor).
4. `reauth(context)` — optional; called after `ReauthRequiredError`.
5. `destroy()` — called on host shutdown; release resources here.

## Registration

The host imports your plugin class and registers it explicitly, then provisions any declared secrets:

```ts
import { MyPlugin } from "my-pulsebridge-plugin";

await platform.registerIntegration(new MyPlugin(), config);
await platform.provision("my-plugin-id", { MY_API_KEY: process.env.MY_API_KEY });
```

The core never auto-loads packages from `node_modules` — registration is always an explicit host action.

## Versioning & compatibility

- Your plugin's `manifest.version` is independent of the `pulsebridge` version it targets.
- Pin the `pulsebridge` dependency to the major/minor you build against. While the platform is in `0.x` alpha, the public API may shift between alpha releases — track the [core changelog](https://github.com/Prsgoo/pulsebridge/blob/main/CHANGELOG.md).
- Import `z` from `"zod"` (v4) consistently if you use `configSchema`.

## Testing & publishing

- Test `execute()`/`process()` against a mocked `fetch` and a fake context (the scaffolder includes a working example).
- Use `context.now()` for deterministic timestamps in tests.
- Publish to npm like any package. Add the `pulsebridge-plugin` keyword so others can find it; hosts still register it explicitly by importing the class.
