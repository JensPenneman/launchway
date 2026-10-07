# Changelog

## [0.1.0](https://github.com/JensPenneman/slipway/compare/v0.1.0...v0.1.0) (2026-10-07)


### Features

* **agent:** add the node agent skeleton with hello, heartbeats, reconnects and a Docker probe ([74631ff](https://github.com/JensPenneman/slipway/commit/74631ff223fe2b7b470d194632b812d433b568db))
* **agent:** implement deploy, cancel, stop, remove, status and log streams ([f0d3c6b](https://github.com/JensPenneman/slipway/commit/f0d3c6b025157b6f14c3c424f6f1d272716937fc))
* **api:** add accounts, sessions, passkeys, tokens, invitations and audit ([4a78c75](https://github.com/JensPenneman/slipway/commit/4a78c7505825bf2822b73a7c57d244a8e55115d6))
* **api:** add dns provider plugins, managed domains and dynamic dns ([45d605d](https://github.com/JensPenneman/slipway/commit/45d605dac2debc263bf0e405af89bfb631d2bc14))
* **api:** add github connections, apps, environment and deployments ([7dd5a7d](https://github.com/JensPenneman/slipway/commit/7dd5a7dd427529608369af65ea2605624acacae4))
* **api:** add nodes, the agent gateway, http routes and the caddy edge ([52250de](https://github.com/JensPenneman/slipway/commit/52250de30c9ae5294bf37eaf42802cc28c8a20e2))
* **api:** add the Drizzle schema of every v0.1 entity and the initial migration ([b06c9c8](https://github.com/JensPenneman/slipway/commit/b06c9c89afc0652770dde3fd036498025aac815f))
* **api:** add the Hono control-plane skeleton with the settings and health modules ([ad50002](https://github.com/JensPenneman/slipway/commit/ad50002ff04a2cd7b416bb3b009606fb1f3e896d))
* **api:** add the migration for the active domain status ([b5624eb](https://github.com/JensPenneman/slipway/commit/b5624ebc0b5217827e818afc2258217e4589d4b6))
* **api:** define the agent gateway and deployment sink interfaces ([8eb4068](https://github.com/JensPenneman/slipway/commit/8eb4068f0fb53eafb557ca344ebd418644f2100b))
* **api:** wire the agent gateway, deployment sink and edge hooks ([3a89083](https://github.com/JensPenneman/slipway/commit/3a890833e8ba1322d5911e2e175ffb52f67c5d1f))
* **contracts:** add Zod schemas and types for every v0.1 module and the agent protocol ([f0774b2](https://github.com/JensPenneman/slipway/commit/f0774b2816fae156ba1f9b3607f84646feb9a4ad))
* **contracts:** reserve platform service names on the proxy network ([2ff45fc](https://github.com/JensPenneman/slipway/commit/2ff45fc1bbcd59c4d70b4150d265eb9faf299732))
* **deploy:** add the Compose stack, Caddy bootstrap and installers ([6440a1a](https://github.com/JensPenneman/slipway/commit/6440a1a075b444d695c083dfdf12aea8951ce5f5))
* **web:** add the React shell with TanStack Router, shadcn/ui, theming and a typed API client ([d728b79](https://github.com/JensPenneman/slipway/commit/d728b79bd70a88583e159b83d9346de15056b46b))
* **web:** build every page on a contract-validated data layer ([5572145](https://github.com/JensPenneman/slipway/commit/55721451f59fcf1848efae9951a5ae461a9d3bd0))
* **web:** use the contract schemas for app status, ddns and edge state ([f07c369](https://github.com/JensPenneman/slipway/commit/f07c369dcb99602b9f2f69f7945bdb9b9875a674))


### Bug Fixes

* **agent:** cancel deployments that wait for a build slot at once ([01b75e4](https://github.com/JensPenneman/slipway/commit/01b75e40b9bab06753037c28d8e4e70c8388a4d3))
* **agent:** close Compose policy escapes through namespaces, devices and drivers ([c0fea79](https://github.com/JensPenneman/slipway/commit/c0fea79718e063e298b4fb1159c27f4f49c7ef11))
* **agent:** detect half-open control plane connections ([5f1f78a](https://github.com/JensPenneman/slipway/commit/5f1f78aafe07d741250fc8bbc42a9118dc68d527))
* **agent:** join again when the server refuses the stored credential ([dae381c](https://github.com/JensPenneman/slipway/commit/dae381c1c694f27c03eb24588d04ce81a1c79d9d))
* **api:** activate served domains even when nothing reloads ([4b80e97](https://github.com/JensPenneman/slipway/commit/4b80e97b83508f9e02a7d431eaed59e8ed5b7e54))
* **api:** explain startup state and configuration problems in the logs ([52b7d08](https://github.com/JensPenneman/slipway/commit/52b7d081dd0211b0d3e62dcba6952a291ea33745))
* **api:** pin the API reference bundle and verify it with SRI ([4988797](https://github.com/JensPenneman/slipway/commit/4988797c11bfa3a8846f088b00c61fd96d3a6bcc))
* **api:** redact invitation tokens from the access log ([c21646a](https://github.com/JensPenneman/slipway/commit/c21646ac12e60fc5975031cfcd394ec80d44d13a))
* **api:** serve the web UI's hashed assets ([8ee1c4a](https://github.com/JensPenneman/slipway/commit/8ee1c4ab9cc104cbeaaa23f91c075589dc1b04e2))
* **api:** trust X-Forwarded-For only from Caddy's address by default ([ec98c30](https://github.com/JensPenneman/slipway/commit/ec98c308f2cb81e1da98f9b2f99285e723477da6))
* **apps:** cancel unsent deployments before stopping or deleting an app ([4710cc8](https://github.com/JensPenneman/slipway/commit/4710cc8dffb7b962f62ee9bcbdc858724f1ab0ac))
* **auth:** limit sign-ins per IPv6 /64 and per account, bound argon2 work ([7354b24](https://github.com/JensPenneman/slipway/commit/7354b24b6d9057998fa5fdfa46e7e1b27f3438ae))
* **auth:** require the installer's setup token to claim a new instance ([c01377f](https://github.com/JensPenneman/slipway/commit/c01377f3844615ca8a35413e61c38c4e4c93220d))
* **auth:** revoke a user's API tokens when the password changes ([c50d58b](https://github.com/JensPenneman/slipway/commit/c50d58b3f750c014381f2b3aaf8df23736be8e6d))
* **contracts:** keep the TypeScript build info inside dist ([2a63853](https://github.com/JensPenneman/slipway/commit/2a63853ec362fd13814dfda5edb77c3507ecf3f6))
* **deploy:** download the compose files of the pinned release ([a0aa98a](https://github.com/JensPenneman/slipway/commit/a0aa98a1dc3b59f717d196be09be48969dac2d2f))
* **deploy:** give the agent time to report on shutdown, match edge agents ([6d3c53e](https://github.com/JensPenneman/slipway/commit/6d3c53ed974274adcaca7d373b4f7d82e5bb9745))
* **deployments:** drain final log lines and annotate only running cancels ([0885dfa](https://github.com/JensPenneman/slipway/commit/0885dfaa8daa57aaac3308def5deef4513121599))
* **deployments:** survive agent reconnects and reconcile with heartbeats ([718b70b](https://github.com/JensPenneman/slipway/commit/718b70bd740de7e6f97a1e615fc57823d90d5500))
* **deps:** override uuid for typeid-js to 11.1.1 ([e613d5a](https://github.com/JensPenneman/slipway/commit/e613d5add7131873b2160943457731efae3ee4f3))
* **domains:** keep the status on failed DNS lookups and read it under lock ([e5d0552](https://github.com/JensPenneman/slipway/commit/e5d05528cdd8acd3d5770c8521acf22a70979d3a))
* **edge:** move the Caddy admin API to a unix socket ([728c998](https://github.com/JensPenneman/slipway/commit/728c998203be0c33a45420b7b0be5b1e254b6036))
* **edge:** refuse upstreams on the edge itself and platform containers ([41afce3](https://github.com/JensPenneman/slipway/commit/41afce3510118d2c18a2aabe76b7f66b49200672))
* **edge:** retry failed Caddy loads and announce the load state ([be9390c](https://github.com/JensPenneman/slipway/commit/be9390c8cd6f685684c933760d0c6baaac8a1749))
* **github:** let GitHub redeliver releases whose auto-deploy failed ([cf690db](https://github.com/JensPenneman/slipway/commit/cf690dbf876645fd03d74b432d5c4e8edddba6ff))
* **github:** send nodes repository-scoped, read-only clone tokens ([acb2a55](https://github.com/JensPenneman/slipway/commit/acb2a550aa177d62163d18d305c57b428b156b0b))
* **nodes:** wait longer than the agent's own limit for stop and remove ([4c5c68d](https://github.com/JensPenneman/slipway/commit/4c5c68d3800822e0146f75117ccc052637481044))
* **web:** ask for a redeploy after routing a service of a running app ([8d02a4f](https://github.com/JensPenneman/slipway/commit/8d02a4f53a1d608e6776cea9d1fc6647ccdcd3f5))
* **web:** refetch everything after the change feed reconnects ([934e6d2](https://github.com/JensPenneman/slipway/commit/934e6d2708f340709ffb103ac8f7b962d561d22a))
* **web:** show forced domains as served in the routes tab ([0c3d91e](https://github.com/JensPenneman/slipway/commit/0c3d91e65190eee9bd904516b5454d3038e0bdc2))


### Documentation

* add development and operations guides and architecture decision records ([4ce1938](https://github.com/JensPenneman/slipway/commit/4ce19386e916db3974538b6efd6382c6240dc3fd))
* add README, license, security policy and contributing guide ([4148de9](https://github.com/JensPenneman/slipway/commit/4148de9994fa8f02b44245e520d2679b98d4346a))
* add v0.1 architecture contract ([a1364f5](https://github.com/JensPenneman/slipway/commit/a1364f523c4e4665906a4bd34f6b2ded1067a608))
* describe the reconnect grace period at start ([4f61a49](https://github.com/JensPenneman/slipway/commit/4f61a490c332c6764947bcc7f62ac6f91dfffd73))
* drop stale open questions and the deleted provisional schemas ([d17da08](https://github.com/JensPenneman/slipway/commit/d17da08840b2c5ca709fb074b9494fe1e9f89a1c))
* fix the migration rule and explain running an agent locally ([7ab2bc7](https://github.com/JensPenneman/slipway/commit/7ab2bc7408352cf649901e3dd863173c17b1cb9b))
* record the integration decisions in ADRs 0010 to 0013 ([f3572ac](https://github.com/JensPenneman/slipway/commit/f3572acc5e5ba2c54b71fd8942c59bf288731bca))
* **roadmap:** record the deferred findings of the v0.1 review ([9ee962b](https://github.com/JensPenneman/slipway/commit/9ee962be5043f698d09a2768ba75518e10dd1ac6))
* **security:** describe the network exposure and scans as they are ([73e5ee5](https://github.com/JensPenneman/slipway/commit/73e5ee5f040e6f4cb2b7c26b284ce98eaf15b266))
* update the README, guides and roadmap after the v0.1 integration ([0c6e996](https://github.com/JensPenneman/slipway/commit/0c6e9968b10bf2219b0c832f8e4ea35c46d9aa69))
