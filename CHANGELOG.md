# Changelog

## [0.1.1](https://github.com/JensPenneman/launchway/compare/v0.1.0...v0.1.1) (2026-10-07)


### Bug Fixes

* **agent:** stop reporting Docker network addresses as the LAN IP ([dbf2c88](https://github.com/JensPenneman/launchway/commit/dbf2c88def02c1594885d9752e8637d939c7939b))


### Documentation

* record service name collisions on the proxy network in the roadmap ([d12b79b](https://github.com/JensPenneman/launchway/commit/d12b79b5d7be343b5f4e4c8c7244cb4df5cff5d3))

## [0.1.0](https://github.com/JensPenneman/launchway/compare/v0.1.0...v0.1.0) (2026-10-07)


### ⚠ BREAKING CHANGES

* every name-derived identifier changes, so an installation made before this commit cannot be upgraded in place; reinstall it.
    - Environment variables: SLIPWAY_* -> LAUNCHWAY_* (API, agent, installers,
      .env files); default install directories /opt/launchway, ~/launchway.
    - Docker labels slipway.app/.deployment/.service -> launchway.*; app
      Compose projects slipway-<slug> -> launchway-<slug>; generated override
      file compose.slipway.yaml -> compose.launchway.yaml.
    - Docker network slipway-proxy -> launchway-proxy; platform Compose
      projects (and so their volumes) slipway, slipway-agent -> launchway,
      launchway-agent; database name and user slipway -> launchway; agent
      workspace /var/lib/slipway -> /var/lib/launchway.
    - Images ghcr.io/jenspenneman/slipway and slipway-agent ->
      ghcr.io/jenspenneman/launchway and launchway-agent.
    - Token prefixes: slp_ -> lwy_ (API tokens), slpn_ -> lwyn_ (node join),
      slpa_ -> lwya_ (node credentials), slpi_ -> lwyi_ (invitations); tokens
      with the old prefixes are rejected. The installers generate setup tokens
      as lwys_ instead of slps_.
    - Session cookie slipway_session -> launchway_session. The HKDF labels of
      the subkeys derived from LAUNCHWAY_SECRET_KEY change, so sessions end and
      secrets encrypted by an older installation cannot be decrypted.
    - Packages @slipway/* -> @launchway/*, export condition @launchway/source;
      the reserved app slug slipway -> launchway.

### Features

* **agent:** add the node agent skeleton with hello, heartbeats, reconnects and a Docker probe ([8bdf6c6](https://github.com/JensPenneman/launchway/commit/8bdf6c6c3aa2087372dd5afb61d93685e0d303d2))
* **agent:** implement deploy, cancel, stop, remove, status and log streams ([bd1b0e3](https://github.com/JensPenneman/launchway/commit/bd1b0e38e7d66c3908678b6e4c1407c7621dae03))
* **api:** add accounts, sessions, passkeys, tokens, invitations and audit ([5abfd05](https://github.com/JensPenneman/launchway/commit/5abfd05cb2516e7b3b691269528852932c18e63b))
* **api:** add dns provider plugins, managed domains and dynamic dns ([f1285c8](https://github.com/JensPenneman/launchway/commit/f1285c84d32eeea6ec630df25850d33d70d7deda))
* **api:** add github connections, apps, environment and deployments ([7d41021](https://github.com/JensPenneman/launchway/commit/7d4102163d427de9eba198560be8144a69ff5b6f))
* **api:** add nodes, the agent gateway, http routes and the caddy edge ([11f9d7d](https://github.com/JensPenneman/launchway/commit/11f9d7d5a78910b616a9078a86d90b65430b4d2d))
* **api:** add the Drizzle schema of every v0.1 entity and the initial migration ([438f3fa](https://github.com/JensPenneman/launchway/commit/438f3fa6345b297c22a233407919ed4e4b1c5574))
* **api:** add the Hono control-plane skeleton with the settings and health modules ([9a1af8f](https://github.com/JensPenneman/launchway/commit/9a1af8f5436433ed45643dca6f6da621d433f359))
* **api:** add the migration for the active domain status ([e3b08fe](https://github.com/JensPenneman/launchway/commit/e3b08fe44dc811a74f29fa87eba0623d5f96f54a))
* **api:** define the agent gateway and deployment sink interfaces ([672d414](https://github.com/JensPenneman/launchway/commit/672d414422fd97c272eba9015bfb0925fac01a86))
* **api:** migrate bind roots, trusted mounts, proxy services and gate target ([c4f5e90](https://github.com/JensPenneman/launchway/commit/c4f5e90d73a414fe4f2955f3dadfd7704174f407))
* **api:** wire the agent gateway, deployment sink and edge hooks ([1e354f6](https://github.com/JensPenneman/launchway/commit/1e354f6cd3be89feb0daa66a587e27758b2c71b3))
* **contracts:** add Zod schemas and types for every v0.1 module and the agent protocol ([8e8f127](https://github.com/JensPenneman/launchway/commit/8e8f1274736532f9e5e6694992139d0799d7c92c))
* **contracts:** reserve platform service names on the proxy network ([03127f6](https://github.com/JensPenneman/launchway/commit/03127f60b792248d0826e6c2c8c9dfba3d9125d3))
* **deploy:** add the Compose stack, Caddy bootstrap and installers ([f6b1ad7](https://github.com/JensPenneman/launchway/commit/f6b1ad703b752a95790d1f0bd1249146c8a87677))
* platform variables, proxy attachment, forward-auth target and extra directives ([c7d4e00](https://github.com/JensPenneman/launchway/commit/c7d4e006ab516176b3a045e09a4bc318cf245034))
* trusted mounts below admin-approved node bind roots ([97ecad7](https://github.com/JensPenneman/launchway/commit/97ecad75f09358b0367d4555d2d02d5b01812457))
* **web:** add the React shell with TanStack Router, shadcn/ui, theming and a typed API client ([d5d73b0](https://github.com/JensPenneman/launchway/commit/d5d73b0718e8b38c615bc939fe0e43d176ff26ac))
* **web:** build every page on a contract-validated data layer ([52f8aaf](https://github.com/JensPenneman/launchway/commit/52f8aaf8e3ccc57001bf1dcad617dfc399a31ec0))
* **web:** use the contract schemas for app status, ddns and edge state ([6c2049f](https://github.com/JensPenneman/launchway/commit/6c2049fe478240b5460f2ccd9b303d290a99ab02))


### Bug Fixes

* **agent:** cancel deployments that wait for a build slot at once ([235be33](https://github.com/JensPenneman/launchway/commit/235be33e630b41c741d2b197cb47f8ef0276e064))
* **agent:** close Compose policy escapes through namespaces, devices and drivers ([295f837](https://github.com/JensPenneman/launchway/commit/295f83714a77a5e0b6e60524fa839c5fe1bf9dd7))
* **agent:** detect half-open control plane connections ([abe6c2d](https://github.com/JensPenneman/launchway/commit/abe6c2d72ff8bdfb9d47c10d64730ed78a8c1238))
* **agent:** join again when the server refuses the stored credential ([4697075](https://github.com/JensPenneman/launchway/commit/4697075bcb13dcb3c8996c33da11855a52c525df))
* **api:** activate served domains even when nothing reloads ([0157739](https://github.com/JensPenneman/launchway/commit/01577392a64ae6cbe5bb60961086225363193061))
* **api:** explain startup state and configuration problems in the logs ([fd323f4](https://github.com/JensPenneman/launchway/commit/fd323f4a14d70e0c4e2bbb9bd6a7e176271328ac))
* **api:** pin the API reference bundle and verify it with SRI ([cde806d](https://github.com/JensPenneman/launchway/commit/cde806de3f864acaea53cfceff085d38d0fbdedd))
* **api:** redact invitation tokens from the access log ([d9c090d](https://github.com/JensPenneman/launchway/commit/d9c090d69c2f05da69c4433d4f8bc86e18116c19))
* **api:** serve the web UI's hashed assets ([e2a95d1](https://github.com/JensPenneman/launchway/commit/e2a95d15a50b0c8bb80a6a81fab88595a594f75e))
* **api:** trust X-Forwarded-For only from Caddy's address by default ([9ff39d4](https://github.com/JensPenneman/launchway/commit/9ff39d4787aca2032284f274d8088498d38056b7))
* **apps:** cancel unsent deployments before stopping or deleting an app ([229372c](https://github.com/JensPenneman/launchway/commit/229372c0fe3f85834b075ce1027a2ac43e81ba94))
* **auth:** limit sign-ins per IPv6 /64 and per account, bound argon2 work ([920331e](https://github.com/JensPenneman/launchway/commit/920331e6e3d1c211b9ece2047e27040a0ddfb3e9))
* **auth:** require the installer's setup token to claim a new instance ([fd23b66](https://github.com/JensPenneman/launchway/commit/fd23b66ca7d151f60bf0302f1ec1ceedd3fc2704))
* **auth:** revoke a user's API tokens when the password changes ([5646850](https://github.com/JensPenneman/launchway/commit/5646850cb4b7fd9bba40d651a1f07586a7f48c31))
* **contracts:** keep the TypeScript build info inside dist ([c8e35d0](https://github.com/JensPenneman/launchway/commit/c8e35d0448273e837219c1e6b81159a5e3494207))
* **deploy:** download the compose files of the pinned release ([a2ae732](https://github.com/JensPenneman/launchway/commit/a2ae73271d2c6f84cba3712b6b2ec70967c4f212))
* **deploy:** give the agent time to report on shutdown, match edge agents ([c845600](https://github.com/JensPenneman/launchway/commit/c845600a6bd488a3a1a3273f1bcf3cfbab010e93))
* **deployments:** drain final log lines and annotate only running cancels ([4bae59e](https://github.com/JensPenneman/launchway/commit/4bae59eaebb6a4f8d1c73f7f3b7ada407b3b27c3))
* **deployments:** survive agent reconnects and reconcile with heartbeats ([5a8ef21](https://github.com/JensPenneman/launchway/commit/5a8ef21ba616b35e5244eb111246a37fa2eec0b0))
* **deps:** override uuid for typeid-js to 11.1.1 ([aa877e4](https://github.com/JensPenneman/launchway/commit/aa877e4cb0def6fa5b7c1fcf054ecc6b366dcdaa))
* **domains:** keep the status on failed DNS lookups and read it under lock ([40ff0a4](https://github.com/JensPenneman/launchway/commit/40ff0a4faad86cbb47dfe80cd611ee55f5f037da))
* **edge:** move the Caddy admin API to a unix socket ([a9bf4fe](https://github.com/JensPenneman/launchway/commit/a9bf4fe472c8c87b09d053bdd37a2ca1b680894f))
* **edge:** refuse upstreams on the edge itself and platform containers ([5708ea5](https://github.com/JensPenneman/launchway/commit/5708ea56e47c1caf055b6729866b10fbaad55bcb))
* **edge:** retry failed Caddy loads and announce the load state ([87e603e](https://github.com/JensPenneman/launchway/commit/87e603edcb7e86820b3dca690dd5b33145c296db))
* **github:** let GitHub redeliver releases whose auto-deploy failed ([1a25dd1](https://github.com/JensPenneman/launchway/commit/1a25dd1682606cdaca655322a1f388ab3bf7212d))
* **github:** send nodes repository-scoped, read-only clone tokens ([1043a24](https://github.com/JensPenneman/launchway/commit/1043a24baea9aeaa0e17590424598a3659eaf3d0))
* **nodes:** wait longer than the agent's own limit for stop and remove ([d7591b5](https://github.com/JensPenneman/launchway/commit/d7591b5e916d7e8865c4e9be4aace17f944746f4))
* stabilise agent tests and clear dependency advisories ([44f6437](https://github.com/JensPenneman/launchway/commit/44f6437313cbfe50857597a17e5c8131ffce1342))
* **web:** ask for a redeploy after routing a service of a running app ([ccee369](https://github.com/JensPenneman/launchway/commit/ccee3693c2e08d3b213593d76b1e658fb0a22e7c))
* **web:** refetch everything after the change feed reconnects ([3bd50c4](https://github.com/JensPenneman/launchway/commit/3bd50c47fc1647b9a4e39585c39bcd1765d91f0b))
* **web:** show forced domains as served in the routes tab ([30687dd](https://github.com/JensPenneman/launchway/commit/30687dd11b3bb7d1d7392af5283df3c6883595ce))


### Documentation

* add development and operations guides and architecture decision records ([6f0320f](https://github.com/JensPenneman/launchway/commit/6f0320fbcd9b6d5922dc1c8199d95d7e44c1f54f))
* add README, license, security policy and contributing guide ([91dd724](https://github.com/JensPenneman/launchway/commit/91dd7245ce86e48644d2bb7250974841af994647))
* add v0.1 architecture contract ([c4d6199](https://github.com/JensPenneman/launchway/commit/c4d619994b2a6a1ad4da653e7106eed62336f0d1))
* describe the reconnect grace period at start ([cda4dd8](https://github.com/JensPenneman/launchway/commit/cda4dd8ad712b514db2d2ce29039f866e8087c74))
* document trusted mounts, proxy services, gate target and platform variables ([93a6f7d](https://github.com/JensPenneman/launchway/commit/93a6f7d304c88e175fdb9791c0d508add2ce0d66))
* drop stale open questions and the deleted provisional schemas ([22219af](https://github.com/JensPenneman/launchway/commit/22219af869162515ad4a9bed61425d258202e5ba))
* fix the migration rule and explain running an agent locally ([cb90282](https://github.com/JensPenneman/launchway/commit/cb902823a32cf30441a9423a0f1995a29a9074dc))
* record the integration decisions in ADRs 0010 to 0013 ([daa5d39](https://github.com/JensPenneman/launchway/commit/daa5d39aed879f09046e1e0c71d7aa3bc3df863c))
* record the rename to Launchway in ADR 0014 ([a837864](https://github.com/JensPenneman/launchway/commit/a83786484f26a93af3254058bfab986bc01c792a))
* **roadmap:** record the deferred findings of the v0.1 review ([229b181](https://github.com/JensPenneman/launchway/commit/229b1818a39a02255ebbcb5c76258f4cf88abdd2))
* **security:** describe the network exposure and scans as they are ([12206f4](https://github.com/JensPenneman/launchway/commit/12206f453e21e966d60a7a6d29b3ec408480d6cb))
* update the README, guides and roadmap after the v0.1 integration ([96c2d74](https://github.com/JensPenneman/launchway/commit/96c2d743637c2a894f02963c0465d1ff3d8abc68))
* use the Launchway name throughout the documentation ([95e51e6](https://github.com/JensPenneman/launchway/commit/95e51e657a8ad13107f80e9232f49f9b531d3876))


### Code Refactoring

* rename the project to Launchway ([b8f5b40](https://github.com/JensPenneman/launchway/commit/b8f5b40ce3638f7a5aacb38982b010cbf0b51a7e))
