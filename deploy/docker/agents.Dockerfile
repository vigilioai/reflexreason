# One image for every TypeScript service; the command picks which one runs.
# build.sh prepares everything on the host, so this build needs no network:
#   ts/dist/bundle   the esbuild bundles
#   dist/runtime     node_modules with only the embedding runtime and its cached model
#   ts/index.json    the retrieval index
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production INDEX_PATH=/app/index.json SKILLS_DIR=/app/skills LISTEN_HOST=0.0.0.0
COPY dist/runtime/node_modules ./node_modules
COPY ts/dist/bundle ./bundle
COPY ts/skills ./skills
COPY runbooks ./runbooks
COPY ts/index.json ./index.json
USER node
CMD ["node", "bundle/swarm.mjs", "--watch"]
