# The BuildKit image of check builders (apps/agent/src/runtime/check-builder.ts, CHECK_BUILDER_IMAGE).
# Nothing builds this file: it is here so that Dependabot proposes new BuildKit releases. Update
# CHECK_BUILDER_IMAGE with it; a unit test keeps both equal.
FROM moby/buildkit:v0.34.2@sha256:c5f8862f52499773af85bc07695b2379ef08e8002352b0df2c4864c91d78dabe
