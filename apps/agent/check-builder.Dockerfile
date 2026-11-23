# The BuildKit image of check builders (apps/agent/src/runtime/check-builder.ts, CHECK_BUILDER_IMAGE).
# Nothing builds this file: it is here so that Dependabot proposes new BuildKit releases. Update
# CHECK_BUILDER_IMAGE with it; a unit test keeps both equal.
FROM moby/buildkit:v0.35.1@sha256:baf6138eb8c37644800c7c913fba051e840ebb9ba13eaf92d92ef9a1712d0b4c
