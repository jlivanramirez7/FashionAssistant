# Build stage: install, typecheck, build the PWA, verify assets.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci
COPY . .
RUN npm run build
# Fail the image build if the MediaPipe models or wasm did not make it
# into dist (setup-assets only warns when a download fails).
RUN test -s dist/models/pose_landmarker_lite.task \
 && test -s dist/models/pose_landmarker_heavy.task \
 && test -s dist/models/selfie_multiclass_256x256.tflite \
 && ls dist/wasm/*.wasm >/dev/null
RUN npm prune --omit=dev --ignore-scripts

# Runtime stage: one Node process serves dist/ and /api (design doc
# section 9). Node 24 runs the TypeScript server directly (type stripping).
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/src/types.ts ./src/types.ts
COPY --from=build /app/.env.production ./.env.production
EXPOSE 8080
USER node
CMD ["node", "server/index.ts"]
