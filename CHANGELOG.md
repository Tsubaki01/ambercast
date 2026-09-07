# Changelog

## [0.3.1](https://github.com/kotarotsubaki/ambercast/compare/v0.3.0...v0.3.1) (2026-09-07)


### Bug Fixes

* **readme:** rename translated READMEs so npm serves README.md ([#290](https://github.com/kotarotsubaki/ambercast/issues/290)) ([6e6e669](https://github.com/kotarotsubaki/ambercast/commit/6e6e669533cdfa43b65045c9f04a3aa39d1738a9))

## [0.3.0](https://github.com/kotarotsubaki/ambercast/compare/v0.2.0...v0.3.0) (2026-09-06)


### Features

* **website:** align the docs pages with the design handoff ([#285](https://github.com/kotarotsubaki/ambercast/issues/285)) ([a9e1d65](https://github.com/kotarotsubaki/ambercast/commit/a9e1d65bf1bf6bcd762b7ddfc2c73a366771e2ac))
* **website:** apply the ambercast brand and design system to the Starlight docs site ([#273](https://github.com/kotarotsubaki/ambercast/issues/273)) ([66d72f1](https://github.com/kotarotsubaki/ambercast/commit/66d72f13315027d33b148b3e5aff89e33c80ca74))
* **website:** apply the museum-lighting landing design and header fixes ([#280](https://github.com/kotarotsubaki/ambercast/issues/280)) ([8b2c8dc](https://github.com/kotarotsubaki/ambercast/commit/8b2c8dc0745a4df5418c81fd645e12457672c01d))


### Bug Fixes

* **architecture:** isolate the yield branch of an IteratorResult union for issue 276 round 3 ([#282](https://github.com/kotarotsubaki/ambercast/issues/282)) ([ef8c2d4](https://github.com/kotarotsubaki/ambercast/commit/ef8c2d4ffe816d2c9cdfa791786098a1bde25624))
* **architecture:** resolve remaining assignment-form for-of gaps for issue 276 (round 2) ([#281](https://github.com/kotarotsubaki/ambercast/issues/281)) ([89d8995](https://github.com/kotarotsubaki/ambercast/commit/89d8995f5b01b602147f36a9c3ccc63b8510cff5))
* **architecture:** track nested-array assignment destructuring whose element target is not a bare identifier ([#272](https://github.com/kotarotsubaki/ambercast/issues/272)) ([8dc4bae](https://github.com/kotarotsubaki/ambercast/commit/8dc4bae3a975189f9e257a34daec28087da7722e))
* **architecture:** unwrap transparent wrappers and track for-of assignment heads in nested-array assignment destructuring ([#279](https://github.com/kotarotsubaki/ambercast/issues/279)) ([bca6bf2](https://github.com/kotarotsubaki/ambercast/commit/bca6bf2711325d9a91c93363d696b013eb58f03c))

## [0.2.0](https://github.com/Tsubaki01/ambercast/compare/v0.1.0...v0.2.0) (2026-09-04)


### ⚠ BREAKING CHANGES

* **generate:** the AI provider request schema (`GENERATED_PLAN_RESPONSE_SCHEMA` / `generatedPlanResponseSchema`) changed, which changes `producerBundleFingerprint` and therefore `inputsDigest` for every prompt. A plan generated under 0.1.0 must be regenerated: `ambercast check` will report existing committed plans as stale (exit 4), and `ambercast generate` (or `--force`) must be re-run to produce a fresh plan under the new fingerprint. This is an owner-approved, intentional user impact (spec: SPEC-J4 J4-4, フェーズ2検収follow-up小粒バッチ実装仕様書.md).

### Bug Fixes

* **architecture:** close union-receiver, for-of/catch and nested-array destructuring bypasses and document SA-2 limits (SPEC-I1/I2/SA-2) ([#264](https://github.com/Tsubaki01/ambercast/issues/264)) ([b1bd7ef](https://github.com/Tsubaki01/ambercast/commit/b1bd7ef8a1633f4ccc17c97d9a6a49c8b5b1f235))
* **generate:** admit empty verificationIntent in the AI provider request schema ([#266](https://github.com/Tsubaki01/ambercast/issues/266)) ([b5672dc](https://github.com/Tsubaki01/ambercast/commit/b5672dca71d5e94b412b48b18c30e8802a54512d))
* **generate:** lazy-resolve AI provider for --list ([#191](https://github.com/Tsubaki01/ambercast/issues/191)) ([#263](https://github.com/Tsubaki01/ambercast/issues/263)) ([ac0d1ce](https://github.com/Tsubaki01/ambercast/commit/ac0d1cebc014995c2b59f3fad5cde92561f8ec49))
* **report:** sanitize control sequences in human renderer output ([#192](https://github.com/Tsubaki01/ambercast/issues/192)) ([#262](https://github.com/Tsubaki01/ambercast/issues/262)) ([3b13ede](https://github.com/Tsubaki01/ambercast/commit/3b13edeecd077ed5a1626aae0c14c801e947100e))

## [0.1.0](https://github.com/Tsubaki01/ambercast/compare/v0.0.1...v0.1.0) (2026-09-03)


### ⚠ BREAKING CHANGES

* **core/ir:** the `a11y-neighborhood-v1` fingerprint hash preimage changed (parent and both immediate adjacent siblings are now included with normalized names, where the prior implementation hashed all siblings by role only with no normalization). The algorithm tag itself is intentionally unchanged, since `a11y-neighborhood-v1` names this project's already-frozen IR-format spec and this PR is a bugfix bringing the implementation into conformance with it, not a new format version. Any grounding entry produced by the prior (incorrect) implementation will no longer match on replay: an ordinary replay reports `fingerprint-mismatch` and self-heals through one AI-fallback re-resolution per affected step; a `cacheOnly`/CI replay instead reports a clean grounding miss and aborts, per existing `cacheOnly` semantics. No data migration is needed for this repository itself, as it ships no committed real grounding artifact yet (0.0.1 placeholder, pre-implementation).
* bootstrap TypeScript build toolchain (tsdown, Node >=22.14) ([#11](https://github.com/Tsubaki01/ambercast/issues/11))

### Features

* **adapters/browser:** single-capture AccessibilityCapture + 3-channel OR secret detection ([#133](https://github.com/Tsubaki01/ambercast/issues/133)) ([37a574e](https://github.com/Tsubaki01/ambercast/commit/37a574e297836b3489d441c6096810de8ad0cbba))
* **adapters:** implement real storage and system adapters ([#34](https://github.com/Tsubaki01/ambercast/issues/34)) ([bac50e3](https://github.com/Tsubaki01/ambercast/commit/bac50e34a65a8d23a4fbb257cd9ec12cb4f3e994))
* **ai:** wire AI adapter-driven generate (claude-code-cli/codex-cli) ([#78](https://github.com/Tsubaki01/ambercast/issues/78)) ([8617ee1](https://github.com/Tsubaki01/ambercast/commit/8617ee11d8dc32a3cc5b758f64816f17836312f6))
* **architecture:** default-deny digest and schema-version tripwire scanners (SPEC-E2) ([#237](https://github.com/Tsubaki01/ambercast/issues/237)) ([16ea86f](https://github.com/Tsubaki01/ambercast/commit/16ea86f8e4b0a524d2b374111ce17124f98c8c19))
* **architecture:** property-selection type evidence and aggregate-escape hardening for reference scanners (SPEC-H1+H3) ([#253](https://github.com/Tsubaki01/ambercast/issues/253)) ([b30e0d5](https://github.com/Tsubaki01/ambercast/commit/b30e0d580c59b04f6f5435945128930aa1d94957))
* **architecture:** symbol-identity static reference resolution for tripwire scanners (SPEC-G2) ([#248](https://github.com/Tsubaki01/ambercast/issues/248)) ([d4aeb95](https://github.com/Tsubaki01/ambercast/commit/d4aeb95d4947301971c8aa70816f88b2da279b2a))
* **config:** implement config loading and JSON Schema packaging ([#33](https://github.com/Tsubaki01/ambercast/issues/33)) ([74e53ba](https://github.com/Tsubaki01/ambercast/commit/74e53ba7a7aba1db42941decefd471d67a381159))
* **core/ir:** canonical JSON serialization and digest computation ([#23](https://github.com/Tsubaki01/ambercast/issues/23)) ([5ded4fb](https://github.com/Tsubaki01/ambercast/commit/5ded4fbeaee03213ee491d750eb16601f3fdb5d5))
* **core/ir:** make grounding the sole trace authority ([#63](https://github.com/Tsubaki01/ambercast/issues/63)) ([72c0590](https://github.com/Tsubaki01/ambercast/commit/72c0590e408f6e568f36b1562cce7629b8afe9b3))
* **core/ir:** Plan/Grounding zod schema and JSON Schema generation ([#22](https://github.com/Tsubaki01/ambercast/issues/22)) ([d86adca](https://github.com/Tsubaki01/ambercast/commit/d86adca1745280dd589a871657dd6966228b0152))
* **core/ir:** reshape AI grounding trace into events/verification record ([#82](https://github.com/Tsubaki01/ambercast/issues/82)) ([819f597](https://github.com/Tsubaki01/ambercast/commit/819f597b61d3f8fd6d4a68a894a21f07b5d7632c))
* **core:** add layout resolver and shared config vocabulary ([#32](https://github.com/Tsubaki01/ambercast/issues/32)) ([5090f6a](https://github.com/Tsubaki01/ambercast/commit/5090f6a17258c35b8c7527fef77f8ef7dda16969))
* define ports + contract-tested fakes ([#30](https://github.com/Tsubaki01/ambercast/issues/30)) ([c897eb5](https://github.com/Tsubaki01/ambercast/commit/c897eb59af38d21ed60ba16735628d81f4862f43))
* **generate:** plan producer bundle fingerprint in inputsDigest ([#213](https://github.com/Tsubaki01/ambercast/issues/213)) ([2502651](https://github.com/Tsubaki01/ambercast/commit/25026518a534e4b2ca4c5c07f5e38c47c2453c6a))
* **generator:** explicit grant lines + verbatim citation verification for secret refs ([#138](https://github.com/Tsubaki01/ambercast/issues/138)) ([04ad37f](https://github.com/Tsubaki01/ambercast/commit/04ad37f435347c9ae25368086da9b15322103460))
* **grounding:** unify repository/write-back posture with missing-grounding detection (A3+D1) ([#184](https://github.com/Tsubaki01/ambercast/issues/184)) ([84a25da](https://github.com/Tsubaki01/ambercast/commit/84a25da67f9330ef06a7feac8c32aa3e24eef60f))
* **heal:** commit preimage integrity + runsDir write containment (SPEC-5) ([#209](https://github.com/Tsubaki01/ambercast/issues/209)) ([c1856de](https://github.com/Tsubaki01/ambercast/commit/c1856de6c781199a4c1ad0160f388d6290ea82bd))
* **heal:** frontier single-step Stage 2 iteration (SPEC-4) ([#208](https://github.com/Tsubaki01/ambercast/issues/208)) ([881c306](https://github.com/Tsubaki01/ambercast/commit/881c306de93076040ab1a4c1325fcb3921d56141))
* **heal:** implement 3-stage self-healing core state machine ([#196](https://github.com/Tsubaki01/ambercast/issues/196)) ([c5f231d](https://github.com/Tsubaki01/ambercast/commit/c5f231dde4c645b4c42a17da447e3224723a6257))
* **heal:** implement heal-cli confirmation and CLI wiring (layer 3 of 3) ([#198](https://github.com/Tsubaki01/ambercast/issues/198)) ([fa6f71d](https://github.com/Tsubaki01/ambercast/commit/fa6f71d374c31e548a9589b7b3c7ae56f8df8800))
* **heal:** meter real AI dispatches with a case-scoped admission budget (SPEC-F5) ([#226](https://github.com/Tsubaki01/ambercast/issues/226)) ([8a5e823](https://github.com/Tsubaki01/ambercast/commit/8a5e823dd23205adc9a5f0ff1132b3a5608451c3))
* **heal:** read-once validated snapshot preimage capability (SPEC-F3) ([#223](https://github.com/Tsubaki01/ambercast/issues/223)) ([0c30e26](https://github.com/Tsubaki01/ambercast/commit/0c30e26ef825cbe466f837ae61f85fb44b019f03))
* **heal:** share grounding recovery table between run and heal ([#207](https://github.com/Tsubaki01/ambercast/issues/207)) ([4e25629](https://github.com/Tsubaki01/ambercast/commit/4e25629758e3658012e2f875274699657ce99ae7))
* **heal:** structured Stage 2 provider context with current plan (SPEC-F2) ([#225](https://github.com/Tsubaki01/ambercast/issues/225)) ([cc903a2](https://github.com/Tsubaki01/ambercast/commit/cc903a291eb7c4203b0c7a5b802469e7d22c1bc6))
* **ir:** require instruction coverage in plan schema v2 ([#173](https://github.com/Tsubaki01/ambercast/issues/173)) ([e058e1e](https://github.com/Tsubaki01/ambercast/commit/e058e1e75c24f0f8ea3ed8fd92ee7d7c908c0250))
* **ports/storage:** atomic-write contract ([#62](https://github.com/Tsubaki01/ambercast/issues/62)) ([e74dfe3](https://github.com/Tsubaki01/ambercast/commit/e74dfe3e3e9c63f6d47150306ae817f20f38c2de))
* **ports:** add secretSinkOrigins config and dedicated fillSecret port ([#141](https://github.com/Tsubaki01/ambercast/issues/141)) ([d5e95d4](https://github.com/Tsubaki01/ambercast/commit/d5e95d4ebb7f6a92c4daeecfa4e4650f70af113a))
* **ports:** redesign resolveGrounded around a BoundElement live handle, drop .first() ([#131](https://github.com/Tsubaki01/ambercast/issues/131)) ([3487b98](https://github.com/Tsubaki01/ambercast/commit/3487b98dc705fc85c416c903eef8ef6dfdb450ed))
* **report:** add schemaVersion 2.0 with batch interruption and normalization ([#182](https://github.com/Tsubaki01/ambercast/issues/182)) ([d4c2f20](https://github.com/Tsubaki01/ambercast/commit/d4c2f205780304d6ab2b7d12d38fa271a2af59f3))
* **report:** complete heal report schema (listed branch, dryRun field) ([#195](https://github.com/Tsubaki01/ambercast/issues/195)) ([35fdee1](https://github.com/Tsubaki01/ambercast/commit/35fdee1049f1002249b3ef645a6e67ec316be408))
* **report:** promote envelope finalization to a single typed boundary ([#205](https://github.com/Tsubaki01/ambercast/issues/205)) ([bbb3787](https://github.com/Tsubaki01/ambercast/commit/bbb3787f59602b2fa4504481589978e6afa673d7))
* **report:** schema 3.0 — heal repairOutcome x application axes, decline exit 1 ([#206](https://github.com/Tsubaki01/ambercast/issues/206)) ([e0f51f7](https://github.com/Tsubaki01/ambercast/commit/e0f51f72693951acf0630c6e292b15a98569d058))
* **run:** Chromium path A replay (grounding-hit execution, zero AI calls) ([#81](https://github.com/Tsubaki01/ambercast/issues/81)) ([0f588ee](https://github.com/Tsubaki01/ambercast/commit/0f588ee4dc20b6d51f4ec63ed26f546a015e187f))
* **run:** grounding miss recovery and trace replay (paths B/C) ([#83](https://github.com/Tsubaki01/ambercast/issues/83)) ([8bcde8a](https://github.com/Tsubaki01/ambercast/commit/8bcde8a29ffada22dc37a73a9fa5f851f32753d0))
* **run:** implement --allow-empty/--list, document --stale=regenerate as intentionally unsupported ([#117](https://github.com/Tsubaki01/ambercast/issues/117)) ([a1fa914](https://github.com/Tsubaki01/ambercast/commit/a1fa914a56352e9e54594694a9a8cd6273501431))
* **run:** persist failure evidence and RunReport to .runs/ ([#112](https://github.com/Tsubaki01/ambercast/issues/112)) ([1f5db46](https://github.com/Tsubaki01/ambercast/commit/1f5db461006efc5d95e60e4b4cbf8517ea7af7a1))
* **scripts:** lock worktrees at creation and serialize removal behind a guarded single entrance ([#236](https://github.com/Tsubaki01/ambercast/issues/236)) ([1e6daed](https://github.com/Tsubaki01/ambercast/commit/1e6daeddd49137a92c239b816f6a4c744260b6aa))
* unify target selection across commands ([#171](https://github.com/Tsubaki01/ambercast/issues/171)) ([de4d6b2](https://github.com/Tsubaki01/ambercast/commit/de4d6b2dca07f6b4124ce307aaf365de53b8e01c))
* **usecases:** implement check — read-only plan/grounding freshness gate ([#160](https://github.com/Tsubaki01/ambercast/issues/160)) ([29d4f39](https://github.com/Tsubaki01/ambercast/commit/29d4f395a576c01cf062564bc8fbe800f16c517b))


### Bug Fixes

* **adapters/ai:** retain codex-cli stderr excerpt on non-completion ([#89](https://github.com/Tsubaki01/ambercast/issues/89)) ([fb685ea](https://github.com/Tsubaki01/ambercast/commit/fb685ea8d23cffe9335c9b9b5c934b0fa8a1722d))
* **adapters/browser:** re-verify secret-sink origin immediately before .fill() (F2) ([#150](https://github.com/Tsubaki01/ambercast/issues/150)) ([814113b](https://github.com/Tsubaki01/ambercast/commit/814113be119160253d508012a36927cd9081993c))
* **browser:** pin fillSecret to one ElementHandle ([#169](https://github.com/Tsubaki01/ambercast/issues/169)) ([b26bc80](https://github.com/Tsubaki01/ambercast/commit/b26bc804830cb97ca5a308de992ff9b88d810c8b))
* **check:** apply inverse-then-judge artifact scanning and unify discovery-only --list ([#186](https://github.com/Tsubaki01/ambercast/issues/186)) ([80b6182](https://github.com/Tsubaki01/ambercast/commit/80b6182a46c2ca0d1ebcba826fa2cc6471c0633d))
* **check:** share canonical grounding verification with run (H1) ([#190](https://github.com/Tsubaki01/ambercast/issues/190)) ([172ce91](https://github.com/Tsubaki01/ambercast/commit/172ce912def5653a76c656d660925de63f6d2c4d))
* **contract:** await the real close event before teardown confirmation on spawn failure (SPEC-G4) ([#244](https://github.com/Tsubaki01/ambercast/issues/244)) ([5f2709b](https://github.com/Tsubaki01/ambercast/commit/5f2709ba10c7fec933379353bbce2f40a3d092b8))
* **core/ir:** correct a11y-neighborhood-v1 fingerprint algorithm and verify AI-supplied fingerprints in path B ([#109](https://github.com/Tsubaki01/ambercast/issues/109)) ([de90917](https://github.com/Tsubaki01/ambercast/commit/de90917e2eb499097fc885bba170b4f4ee3fb32d))
* **core/ir:** harden schema regex — dotAll flag loss + baseUrl secrets gap ([#38](https://github.com/Tsubaki01/ambercast/issues/38)) ([0d44fef](https://github.com/Tsubaki01/ambercast/commit/0d44fef539ae008e81893bbcc20b5af03146e94b))
* **core/ir:** rewrite fingerprint parser to fail-closed scanning, bump algorithm to a11y-neighborhood-v2 ([#129](https://github.com/Tsubaki01/ambercast/issues/129)) ([8975cec](https://github.com/Tsubaki01/ambercast/commit/8975cec4325a78d3cf644af4e4a7da9c0be3d50d))
* **heal:** confine repairable-navigation allowlist to RunCaseOutcome errors (SPEC-E4) ([#238](https://github.com/Tsubaki01/ambercast/issues/238)) ([9d37714](https://github.com/Tsubaki01/ambercast/commit/9d3771422268a0e637974a7f6f7697854a920135))
* **heal:** fail-closed arbitration for thrown integrity in the dispatch budget (SPEC-G1/G5) ([#245](https://github.com/Tsubaki01/ambercast/issues/245)) ([2defb28](https://github.com/Tsubaki01/ambercast/commit/2defb28015f5431a9d7fde727d84ac6ab279757a))
* **heal:** fail-closed integrity-violation propagation with a repairable navigation exception (SPEC-F4) ([#227](https://github.com/Tsubaki01/ambercast/issues/227)) ([45c0d20](https://github.com/Tsubaki01/ambercast/commit/45c0d203e3621c1c78996f1c736954ee813b33ff))
* **heal:** latch dispatch protocol violations on the phase token and de-vacuous acceptance tests ([#252](https://github.com/Tsubaki01/ambercast/issues/252)) ([b3932ca](https://github.com/Tsubaki01/ambercast/commit/b3932ca20e12967d1c99eea3c9dc5683144aea70))
* **heal:** Stage 2 retained-grant seed and typed rejection (SPEC-F1) ([#224](https://github.com/Tsubaki01/ambercast/issues/224)) ([0ddb11c](https://github.com/Tsubaki01/ambercast/commit/0ddb11c806013b5267cfeecea09bc3b01156d11c))
* **heal:** supervise real-CLI contract child-process teardown with fail-closed cleanup (SPEC-E3) ([#233](https://github.com/Tsubaki01/ambercast/issues/233)) ([76c7623](https://github.com/Tsubaki01/ambercast/commit/76c76239e6c1e02cbf4a55210b927ff9d15cf1c9))
* **heal:** synchronize ai-call emission with budget admission (SPEC-E1) ([#234](https://github.com/Tsubaki01/ambercast/issues/234)) ([46e190d](https://github.com/Tsubaki01/ambercast/commit/46e190d21ec8e6a92df51f857a172c41e65d18df))
* **hooks:** resolve guard_git/guard_phase/guard_stop against the correct linked worktree ([#60](https://github.com/Tsubaki01/ambercast/issues/60)) ([0acc017](https://github.com/Tsubaki01/ambercast/commit/0acc0177000c6abe47d439c6e7dda125bf31d4f3))
* **hooks:** stop counting delegation transcripts as flow progress ([#211](https://github.com/Tsubaki01/ambercast/issues/211)) ([aa13a4a](https://github.com/Tsubaki01/ambercast/commit/aa13a4a537b09b165784c7fa86729a1b82c2ec1f))
* **lint:** give ESLint boundaries a TS-aware resolver so it fires on real src ([#40](https://github.com/Tsubaki01/ambercast/issues/40)) ([5250e7a](https://github.com/Tsubaki01/ambercast/commit/5250e7a2c676c9d088fa66491dae66cd0c038ee2))
* **ports/storage:** harden atomic-write contract coverage and documentation gaps ([#72](https://github.com/Tsubaki01/ambercast/issues/72)) ([e183411](https://github.com/Tsubaki01/ambercast/commit/e1834115fdefe53dafe779b39ee759f776dec4f1))
* **report:** relativize run report identity fields (id/file/planFile/caseId) against projectRoot ([#146](https://github.com/Tsubaki01/ambercast/issues/146)) ([d3d4228](https://github.com/Tsubaki01/ambercast/commit/d3d4228d5a80fb45addbec63a821d9c584d419d3))
* **run:** apply credential-heuristic literal detection symmetrically to fill.value at both run-time choke points ([#143](https://github.com/Tsubaki01/ambercast/issues/143)) ([79840a0](https://github.com/Tsubaki01/ambercast/commit/79840a043695cd7cf711aa3bda6855cab2a2d27a))
* **run:** close blob: scheme bypass in the navigate origin guard ([#110](https://github.com/Tsubaki01/ambercast/issues/110)) ([5e5a626](https://github.com/Tsubaki01/ambercast/commit/5e5a626f619272f9de033e0663e26ab6a1722c7e))
* **run:** compose and classify AI-call timeouts for path B/C ([#113](https://github.com/Tsubaki01/ambercast/issues/113)) ([b7f6b5b](https://github.com/Tsubaki01/ambercast/commit/b7f6b5b4828e90835cef4bd541454b82b9895384))
* **run:** compose fresh AbortSignal timeout into resolveAiProvider's isAvailable probe ([#128](https://github.com/Tsubaki01/ambercast/issues/128)) ([32f357a](https://github.com/Tsubaki01/ambercast/commit/32f357a3515e9bf1c0ace580b275fbb7f078c0dd))
* **run:** projectRoot-relative screenshot paths + 3-state RunReport persistence ([#136](https://github.com/Tsubaki01/ambercast/issues/136)) ([53ae31e](https://github.com/Tsubaki01/ambercast/commit/53ae31e5621ca1d05fbf18f2e236ae52b4c53b9f))
* **run:** redact accessibility-tree snapshots and drop screenshots at the AI boundary ([#96](https://github.com/Tsubaki01/ambercast/issues/96)) ([1a858ff](https://github.com/Tsubaki01/ambercast/commit/1a858ff9814bcfe7154542f1585385a8a6676e26))
* **run:** redact secret/run values at the report boundary for path A ([#95](https://github.com/Tsubaki01/ambercast/issues/95)) ([63d00e3](https://github.com/Tsubaki01/ambercast/commit/63d00e305147f8a485a7d7e79c427f5e75378cca))
* **run:** reject cross-origin navigate destinations at replay time ([#106](https://github.com/Tsubaki01/ambercast/issues/106)) ([c25b72c](https://github.com/Tsubaki01/ambercast/commit/c25b72c385913633853a4f6af4f1d38dc95fde8b))
* **run:** reject substring-embedded secrets and re-verify before persisting grounding ([#97](https://github.com/Tsubaki01/ambercast/issues/97)) ([18f85ea](https://github.com/Tsubaki01/ambercast/commit/18f85eafbf21313672d79ed51a0459c81b963415))
* **run:** rewrite jsonContainsResolvedSecret to iterative fail-closed scan, close trace closed-vocabulary gap (F1+F4) ([#152](https://github.com/Tsubaki01/ambercast/issues/152)) ([28acfb8](https://github.com/Tsubaki01/ambercast/commit/28acfb88f154cae1a3bf4ec01d96d3c4d7683de8))
* **scripts:** ensure-locked terminal states for worktree removal (SPEC-G3) ([#246](https://github.com/Tsubaki01/ambercast/issues/246)) ([d6c9d87](https://github.com/Tsubaki01/ambercast/commit/d6c9d877fda384aefb194a229a98a5f735d6e181))
* **secrets:** enforce strict 1:1 grant consumption on the run side, regenerate on attribution-unsound fresh plans (F5) ([#154](https://github.com/Tsubaki01/ambercast/issues/154)) ([0b402ed](https://github.com/Tsubaki01/ambercast/commit/0b402ed68854e1f6b6ef1798594dcfc3f10040ea))
* **security:** deny AI CLI child env and reap unresponsive processes on abort ([#93](https://github.com/Tsubaki01/ambercast/issues/93)) ([01274bb](https://github.com/Tsubaki01/ambercast/commit/01274bb4ad55c9708eb97c22feacf881a7aeb2b0))
* **security:** reject generated/replayed secret refs absent from test.md ([#94](https://github.com/Tsubaki01/ambercast/issues/94)) ([29ca2c1](https://github.com/Tsubaki01/ambercast/commit/29ca2c198c72d02d418be346d00b3a3174bf6c64))
* **usecases:** unify exit-code aggregation priority to 2&gt;3&gt;4&gt;1&gt;5&gt;0 ([#91](https://github.com/Tsubaki01/ambercast/issues/91)) ([7aa41c6](https://github.com/Tsubaki01/ambercast/commit/7aa41c669cf828988f66c6a2fd3b3a62fdebccd4))
* wire EventSink into generate, strip $schema from claude-code-cli, and fix run.ts step-start timing ([#111](https://github.com/Tsubaki01/ambercast/issues/111)) ([ff44a2a](https://github.com/Tsubaki01/ambercast/commit/ff44a2a33cb2448c2899e9907999c38fcda627df))
* **workflow:** let sessions with live background work pass the Stop guard ([#19](https://github.com/Tsubaki01/ambercast/issues/19)) ([1f559cb](https://github.com/Tsubaki01/ambercast/commit/1f559cb60a81b940192bf481877c91086c012008))


### Miscellaneous Chores

* bootstrap TypeScript build toolchain (tsdown, Node &gt;=22.14) ([#11](https://github.com/Tsubaki01/ambercast/issues/11)) ([82524ed](https://github.com/Tsubaki01/ambercast/commit/82524edc8e8fd9ffb4a4df3e0e1f3bf55740919f))
