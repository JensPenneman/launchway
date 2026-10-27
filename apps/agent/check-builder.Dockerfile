# The BuildKit image of check builders (apps/agent/src/runtime/check-builder.ts, CHECK_BUILDER_IMAGE).
# Nothing builds this file: it is here so that Dependabot proposes new BuildKit releases. Update
# CHECK_BUILDER_IMAGE with it; a unit test keeps both equal.
FROM moby/buildkit:v0.33.1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea
