# The decision model on CPU: Von 1.3 (ModernBERT-large, 395M parameters,
# Apache-2.0) behind the System One endpoint. The weights are baked in, so
# the pod needs no egress and starts without a download.
FROM python:3.12-slim
ENV HF_HOME=/models PIP_NO_CACHE_DIR=1
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch \
 && pip install "von-sdk>=1.3.7"
# Start the server once and ask it a real question: the weights are fetched
# on the first decision, not at start-up. The build fails if none arrives.
COPY deploy/docker/warm-decision.py /tmp/warm.py
RUN (von serve --host 127.0.0.1 --port 8100 --device cpu --model von-1.3 &) \
 && python /tmp/warm.py && rm /tmp/warm.py
# From here on the image never looks for the network.
ENV HF_HUB_OFFLINE=1
EXPOSE 8100
CMD ["von", "serve", "--host", "0.0.0.0", "--port", "8100", \
     "--device", "cpu", "--model", "von-1.3"]
