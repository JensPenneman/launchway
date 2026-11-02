# The BuildKit image of check builders (apps/agent/src/runtime/check-builder.ts, CHECK_BUILDER_IMAGE).
# Nothing builds this file: it is here so that Dependabot proposes new BuildKit releases. Update
# CHECK_BUILDER_IMAGE with it; a unit test keeps both equal.
FROM moby/buildkit:v0.34.1@sha256:99368f3e46177c6405b9740e4461d91cee004128daeecca78d4ceac50ec1da5c
