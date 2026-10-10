FROM node:22-alpine AS build
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

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
