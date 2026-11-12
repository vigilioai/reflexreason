# The gateway and the intake binary are static, so the image is the two files.
FROM scratch
COPY rust/target/x86_64-unknown-linux-musl/release/vllm-gate /vllm-gate
COPY rust/target/x86_64-unknown-linux-musl/release/intake /intake
USER 65534
ENTRYPOINT ["/vllm-gate"]
