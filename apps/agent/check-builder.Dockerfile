# The BuildKit image of check builders (apps/agent/src/runtime/check-builder.ts, CHECK_BUILDER_IMAGE).
# Nothing builds this file: it is here so that Dependabot proposes new BuildKit releases. Update
# CHECK_BUILDER_IMAGE with it; a unit test keeps both equal.
FROM moby/buildkit:v0.35.0@sha256:aa632b921ef07411d2cb77292cd34213d4f7b384001d6fceef1e1f25bf9752bb
